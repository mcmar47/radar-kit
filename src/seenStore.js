import { readFile, writeFile, unlink } from "node:fs/promises"
import path from "node:path"

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
