// One push to the phone via ntfy.sh, for the single most time-critical row
// in a digest that just went out — an event or release imminent enough that
// waiting for the 06:00 / 09:00 email is too slow.
//
// Sibling of gmail.js: the other way this fleet reaches the phone, and like
// gmail.js it reads its one secret from a file on disk (the topic name — on
// a public ntfy topic that name is the only thing between a stranger and the
// notification tray) rather than taking it as a tool argument.
//
// This is a SECOND ntfy topic, deliberately separate from pi-ops/alert.sh's
// ops-alert topic (~/.config/pi-ops/ntfy-topic). Ops alerts must stay loud;
// this channel is designed to be nearly empty — NEW-IDEAS.md C4's tripwire:
// if it averages more than ~2 pushes a week the filter is wrong. Separate
// topics mean either can be muted on the phone without touching the other.
//
// Zero-dependency and plugin-free (the radar-kit/ntfy subpath, per the CI
// invariant): Node's global fetch and nothing else.

import { readFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"

export const PUSH_TOPIC_FILE = path.join(os.homedir(), ".config", "pi-ops", "ntfy-push-topic")

/**
 * The configured push topic (trimmed), or null when the file is absent or
 * empty — in which case the caller skips the push. Same "not configured →
 * no-op" posture as pi-ops/alert.sh.
 */
export async function readPushTopic(topicFile = PUSH_TOPIC_FILE) {
  try {
    const topic = (await readFile(topicFile, "utf8")).trim()
    return topic || null
  } catch (err) {
    if (err.code === "ENOENT") return null
    throw err
  }
}

// A header value can never carry a bare CR/LF — everything after one parses
// as a new header. Titles/messages here are built from scraped event and
// release titles, exactly the fields that pick up a stray newline. Same
// guard, same reason, as gmail.js's sanitizeHeaderValue.
const oneLine = (s) => String(s ?? "").replace(/[\r\n]+/g, " ").trim()

/**
 * POST one notification to ntfy.sh. Best-effort by contract: a push that
 * fails must never turn a delivered digest into a failed run, so every
 * caller either `.catch()`es this or ignores the rejection. Resolves true
 * on a 2xx, false otherwise (including a missing topic or a timeout).
 *
 * @param {object} opts
 * @param {string} opts.topic       ntfy topic, from readPushTopic()
 * @param {string} opts.title       notification title (one line)
 * @param {string} opts.message     notification body
 * @param {string} [opts.clickUrl]  a continuum:// deep link for the tap target
 * @param {string} [opts.priority="default"]
 * @param {string[]} [opts.tags=["calendar"]]  ntfy tag / emoji shortcodes
 * @param {number} [opts.timeoutMs=8000]
 */
export async function sendNtfyPush({
  topic,
  title,
  message,
  clickUrl,
  priority = "default",
  tags = ["calendar"],
  timeoutMs = 8000,
}) {
  if (!topic) return false

  const headers = {
    Title: oneLine(title),
    Priority: oneLine(priority),
    Tags: (Array.isArray(tags) ? tags : [tags]).map(oneLine).filter(Boolean).join(","),
  }
  if (clickUrl) headers.Click = oneLine(clickUrl)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
      method: "POST",
      headers,
      body: String(message ?? ""),
      signal: controller.signal,
    })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}
