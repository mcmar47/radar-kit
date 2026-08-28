// The on-disk half of the interest/ignored marks that event-watch,
// release-radar and feed-radar all persist: a flat JSON object of
// `key -> true`, written atomically, read defensively.
//
// This file exists because its two core functions were byte-identical in
// all three repos' server/interest-server.js, and the same crash class had
// to be fixed by hand in each of them on the same day (see each repo's
// git log for 2026-08-28). That is the threshold this package documents
// for extraction: not "these look similar" but "this exact bug already
// needed fixing more than once."
//
// Deliberately zero-dependency, and deliberately NOT re-exported from
// index.js — importing this module must never pull @opencode-ai/plugin's
// tree in behind it. See package.json's "exports" map and the note in
// interestServer.js.

import { open, readFile, rename } from "node:fs/promises"

// A store is a flat object of string keys to `true`. Anything else on disk
// — an array, a string, null, a number — is corruption as far as this code
// is concerned, even though it parses as valid JSON.
//
// The three original copies only guarded against a *parse* failure, which
// left a real gap: a store containing `"x"` or `null` parsed fine, then
// silently swallowed every write (assigning a property to a string is a
// no-op in sloppy mode, and JSON.stringify wrote the same bad value back).
// Marks appeared to save and then vanished, with nothing logged. Treat a
// wrong-shaped store exactly like an unparseable one.
function isPlainMarkObject(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  )
}

// Move a bad store aside rather than deleting it, so the marks stay
// recoverable by hand, and report the path we moved it to.
async function quarantine(storePath, reason) {
  const quarantined = `${storePath}.corrupt-${Date.now()}`
  try {
    await rename(storePath, quarantined)
  } catch {
    // Best-effort: if even the rename fails, starting from empty and
    // staying up still beats crash-looping.
  }
  console.error(
    `readMarks: ${storePath} ${reason} — moved it to ${quarantined} ` +
      `and starting from empty`
  )
}

export async function readMarks(storePath) {
  let raw
  try {
    raw = await readFile(storePath, "utf8")
  } catch (err) {
    if (err.code === "ENOENT") return {}
    throw err
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    // A store left half-written by a power cut used to take this endpoint
    // down for good: the parse threw, nothing caught it, the process
    // exited, systemd restarted it, and the very next request re-read the
    // same bad bytes and died again — with no request ever succeeding in
    // between to repair the file.
    await quarantine(storePath, `is not valid JSON (${err.message})`)
    return {}
  }

  if (!isPlainMarkObject(parsed)) {
    await quarantine(storePath, `parsed as ${describe(parsed)}, not an object`)
    return {}
  }

  // JSON.parse produces an ordinary object, so a literal "__proto__" key in
  // the file lands as a real own property rather than touching the
  // prototype. Copying onto a null-prototype object keeps it that way for
  // every later `key in marks` / `marks[key]` in the server, so a crafted
  // store can never make an inherited member look like a mark.
  return Object.assign(Object.create(null), parsed)
}

function describe(value) {
  if (value === null) return "null"
  if (Array.isArray(value)) return "an array"
  return `a ${typeof value}`
}

// Write to a sibling temp file, flush it to disk, then rename into place.
// rename(2) is atomic within a directory, so a reader (or a power cut) sees
// either the whole old file or the whole new one, never a truncated file —
// which is what produced the crash loop readMarks() defends against.
// The fsync matters on the Pi specifically: without it the rename can land
// while the bytes are still only in page cache.
export async function writeMarks(storePath, marks) {
  const tmp = `${storePath}.tmp`
  const handle = await open(tmp, "w")
  try {
    await handle.writeFile(JSON.stringify(marks, null, 2) + "\n", "utf8")
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(tmp, storePath)
}

// A named set of stores — `{ interested: "/path/interested.json", ... }` —
// with the lookup guard and the optional mutual-exclusion rule that each
// repo otherwise has to remember to implement itself.
//
// `exclusive: true` means an item can carry at most one of these marks, so
// setting one clears the others. feed-radar has always done this by hand
// ("an article cannot be both starred and rejected, and letting both be
// true would feed the scorer contradictory calibration examples"); it is
// offered here as a flag because that reasoning is not feed-radar's alone
// — it applies to any store set whose marks are fed back to a model as
// positive and negative examples.
export function createMarkStore({ paths, exclusive = false }) {
  const names = Object.keys(paths)
  if (names.length === 0) {
    throw new Error("createMarkStore: needs at least one named store path")
  }

  // `name` arrives straight off a query string or JSON body, and a plain
  // object literal resolves every name on Object.prototype too:
  // "constructor", "toString" and "__proto__" all come back truthy, sail
  // through a `!paths[name]` guard, and then hand readFile a function
  // instead of a path — which killed the process outright. Own keys only.
  function isValidStore(name) {
    return typeof name === "string" && Object.hasOwn(paths, name)
  }

  function pathFor(name) {
    if (!isValidStore(name)) {
      throw new Error(`createMarkStore: unknown store "${name}"`)
    }
    return paths[name]
  }

  return {
    names,
    isValidStore,

    read: (name) => readMarks(pathFor(name)),

    // Set or clear one mark. Returns the stores it actually touched, so a
    // caller can log or assert on the exclusivity side effect.
    async set({ store, key, value }) {
      const touched = []
      const marks = await readMarks(pathFor(store))

      if (value) marks[key] = true
      else delete marks[key]
      await writeMarks(pathFor(store), marks)
      touched.push(store)

      // Clearing a mark can't contradict anything, so only a set needs to
      // sweep the others.
      if (value && exclusive) {
        for (const other of names) {
          if (other === store) continue
          const otherMarks = await readMarks(pathFor(other))
          if (otherMarks[key]) {
            delete otherMarks[key]
            await writeMarks(pathFor(other), otherMarks)
            touched.push(other)
          }
        }
      }

      return { touched }
    },
  }
}
