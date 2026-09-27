import { readFile, writeFile, unlink } from "node:fs/promises"
import path from "node:path"
import { writeFileAtomic } from "./atomicWrite.js"

export async function readJsonArray(directory, fileName) {
  const raw = await readFile(path.join(directory, fileName), "utf8")
  return JSON.parse(raw)
}

export async function writeJsonArray(directory, fileName, arr) {
  await writeFile(
    path.join(directory, fileName),
    JSON.stringify(arr, null, 2) + "\n",
    "utf8"
  )
}

export async function deleteIfExists(directory, fileName) {
  try {
    await unlink(path.join(directory, fileName))
  } catch (err) {
    if (err.code !== "ENOENT") throw err
  }
}

export function normalizeField(s) {
  return String(s ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
}

// Builds a composite dedup/match key from one or more fields, normalized
// (trimmed, case-folded, whitespace-collapsed) by default so a stray space
// or capitalization difference between two sources of the same item doesn't
// register as a new/different one. Pass `{ field, exact: true }` for a
// field like a release date where "TBD" and "Fall 2026" are genuinely
// different values, not different spellings of the same one — normalizing
// there would be wrong, not just unnecessary.
export function makeKeyFn(fields) {
  return (item) =>
    fields
      .map((f) => {
        const spec = typeof f === "string" ? { field: f } : f
        const raw = item[spec.field]
        return spec.exact ? String(raw ?? "").trim() : normalizeField(raw)
      })
      .join("|")
}

// ---------------------------------------------------------------------------
// Recording what was sent — from the staging file, never from retyped args
// ---------------------------------------------------------------------------
//
// render_digest writes the staging file (new-events.json, new-postings.json,
// …) and send_digest_email renders + sends straight from it, so the staging
// file IS what went out. The append tools used to take the item list as model
// arguments instead — the model retyping every item a second time — and a
// retyped title changes the dedup key, so the "same" item came back as new on
// a later run. And if the model sent the digest and then never called the
// append tool, the next run re-sent the whole digest.
// (fleet-docs/CODE-REVIEW-2026-09.md O3.)
//
// These two helpers close both: the append tools read the staging file, and
// the send tool can record the seen store itself the moment a send is
// confirmed (createSeenRecorder). Both paths skip keys already present, so
// running both — send records, the prompt's append call then finds nothing
// new and deletes the staging file — is the normal, idempotent case.
// Plugin-free, so this is unit-testable without @opencode-ai/plugin.


/**
 * The staged items render_digest wrote, or null when there is no usable
 * staging file (never rendered, or already appended and deleted).
 */
export async function readStagedItems(directory, stagingFileName) {
  try {
    const parsed = JSON.parse(await readFile(path.join(directory, stagingFileName), "utf8"))
    return Array.isArray(parsed) ? parsed : null
  } catch (err) {
    if (err.code === "ENOENT" || err instanceof SyntaxError) return null
    throw err
  }
}

/**
 * Append `items` to a seen-*.json array, skipping any key already present
 * (and duplicates within `items`). Written atomically. A missing store is
 * created. Returns { previousCount, added, newTotal }.
 */
export async function appendSeenItems({ directory, seenFileName, keyFields, items }) {
  const keyOf = makeKeyFn(keyFields)
  let seen
  try {
    seen = await readJsonArray(directory, seenFileName)
  } catch (err) {
    if (err.code !== "ENOENT") throw err
    seen = []
  }
  if (!Array.isArray(seen)) {
    throw new Error(`${seenFileName} is not a JSON array — refusing to append to it`)
  }
  const seenKeys = new Set(seen.map(keyOf))
  const previousCount = seen.length
  let added = 0
  for (const item of items) {
    const k = keyOf(item)
    if (seenKeys.has(k)) continue
    seen.push(item)
    seenKeys.add(k)
    added++
  }
  if (added > 0) {
    await writeFileAtomic(path.join(directory, seenFileName), JSON.stringify(seen, null, 2) + "\n")
  }
  return { previousCount, added, newTotal: seen.length }
}

/**
 * A `recordSent` hook for createSendDigestEmailTool: appends exactly the
 * items that were just sent to the seen store. Leaves the staging file in
 * place — the append tool still deletes it, which is what the wrappers'
 * "staging file left behind" guards key on.
 */
export function createSeenRecorder({ seenFileName, keyFields }) {
  return ({ items, directory }) => appendSeenItems({ directory, seenFileName, keyFields, items })
}
