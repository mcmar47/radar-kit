// writeFileAtomic — the one durable write shared by markStore, shelf's
// store, and digestTools' run log. The markStore tests already exercise it
// end to end (0644 under a restrictive umask, no temp file left behind);
// these cover it directly.

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, readdir, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { writeFileAtomic } from "../src/atomicWrite.js"

async function tempDir() {
  return mkdtemp(path.join(tmpdir(), "radar-kit-aw-"))
}

test("writes the content and leaves no temp file", async () => {
  const dir = await tempDir()
  const file = path.join(dir, "store.json")
  await writeFileAtomic(file, '{"a":1}\n')
  assert.equal(await readFile(file, "utf8"), '{"a":1}\n')
  assert.deepEqual(await readdir(dir), ["store.json"])
})

test("the result is 0644 even under a 0077 umask", async () => {
  const dir = await tempDir()
  const file = path.join(dir, "store.json")
  const prev = process.umask(0o077)
  try {
    await writeFileAtomic(file, "x")
  } finally {
    process.umask(prev)
  }
  assert.equal((await stat(file)).mode & 0o777, 0o644)
})

test("mode is overridable", async () => {
  const dir = await tempDir()
  const file = path.join(dir, "store.json")
  await writeFileAtomic(file, "x", { mode: 0o600 })
  assert.equal((await stat(file)).mode & 0o777, 0o600)
})

test("ensureDir creates missing parents", async () => {
  const dir = await tempDir()
  const file = path.join(dir, "logs", "nested", "runs.json")
  await writeFileAtomic(file, "[]\n", { ensureDir: true })
  assert.equal(await readFile(file, "utf8"), "[]\n")
})

test("without ensureDir a missing parent throws", async () => {
  const dir = await tempDir()
  await assert.rejects(
    () => writeFileAtomic(path.join(dir, "nope", "x.json"), "x"),
    /ENOENT/
  )
})

test("an existing file is replaced whole", async () => {
  const dir = await tempDir()
  const file = path.join(dir, "store.json")
  await writeFileAtomic(file, "old contents that are longer")
  await writeFileAtomic(file, "new")
  assert.equal(await readFile(file, "utf8"), "new")
})
