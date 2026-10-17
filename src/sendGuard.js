// In-session send-once guard for send_digest_email. The staging file survives
// a send (the append tool deletes nothing), so a second send_digest_email
// call re-renders and re-sends it. That is right after a failure that proves
// nothing was sent (bad credentials, RCPT refused) but wrong after one that
// does not: Gmail can accept the message and then stall past the idle timeout
// before its 250 reply, which reads to the model as "send failed" and invites
// a retry of a digest that was already delivered.
//
// So a `<staging>.sending` marker is written just before the SMTP body goes
// out (smtpSubmit's onBeforeData), and removed on a confirmed send. A marker
// still there for the same staging content means the last attempt's outcome
// is unknown: refuse, don't retry. Pre-DATA failures never write it, so those
// stay retryable. The marker is keyed on the staging content and expires, so
// tomorrow's different digest is never blocked by a stale one.
//
// Plugin-free so it can be tested without @opencode-ai/plugin.

import { readFile, writeFile, rm } from "node:fs/promises"
import { createHash } from "node:crypto"

const MAX_MARKER_AGE_MS = 12 * 3600 * 1000

export const sendingMarkerPath = (stagingPath) => `${stagingPath}.sending`

// `key` identifies what is being sent: the staging file's raw text plus the
// extra section's id (an extra-only day has no staging file at all).
export const sendKey = (...parts) =>
  createHash("sha256").update(parts.map((p) => String(p ?? "")).join("\u0000")).digest("hex")

/** Throws if an earlier attempt for this same `key` may have been delivered. */
export async function assertNotAlreadySending(stagingPath, key, now = Date.now()) {
  let marker
  try {
    marker = JSON.parse(await readFile(sendingMarkerPath(stagingPath), "utf8"))
  } catch {
    return // no marker, or an unreadable one: nothing proves a prior attempt
  }
  if (marker?.key !== key) return
  const age = now - Date.parse(marker.at || "")
  if (!(age >= 0 && age < MAX_MARKER_AGE_MS)) return
  throw new Error(
    "send outcome unknown, not retrying: an earlier send_digest_email attempt for this same digest " +
      `reached the SMTP DATA phase at ${marker.at} and then failed or timed out, so the message may ` +
      "already have been delivered. Do NOT call send_digest_email again; report the failure and stop."
  )
}

export async function markSending(stagingPath, key, now = Date.now()) {
  await writeFile(sendingMarkerPath(stagingPath), JSON.stringify({ key, at: new Date(now).toISOString() }))
}

export async function clearSending(stagingPath) {
  await rm(sendingMarkerPath(stagingPath), { force: true })
}
