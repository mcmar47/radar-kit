// Recording what was sent from the staging file, not from retyped tool args
// (fleet-docs/CODE-REVIEW-2026-09.md O3): readStagedItems, appendSeenItems,
// createSeenRecorder.

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { readStagedItems, appendSeenItems, createSeenRecorder } from "../src/seenStore.js"

async function tempDir() {
  return mkdtemp(path.join(tmpdir(), "radar-kit-seen-"))
}

const KEY = ["title", "date"]
const ev = (title, date = "2026-10-01") => ({ title, date, category: "x" })

test("readStagedItems: the staged array, or null when absent or unusable", async () => {
  const dir = await tempDir()
  assert.equal(await readStagedItems(dir, "new-events.json"), null)

  await writeFile(path.join(dir, "new-events.json"), JSON.stringify([ev("A")]))
  assert.deepEqual(await readStagedItems(dir, "new-events.json"), [ev("A")])

  await writeFile(path.join(dir, "new-events.json"), '{"not": "an array"}')
  assert.equal(await readStagedItems(dir, "new-events.json"), null)

  await writeFile(path.join(dir, "new-events.json"), "[{")
  assert.equal(await readStagedItems(dir, "new-events.json"), null)
})

test("appendSeenItems creates the store, skips known keys, and dedups within a batch", async () => {
  const dir = await tempDir()
  const first = await appendSeenItems({
    directory: dir,
    seenFileName: "seen-events.json",
    keyFields: KEY,
    items: [ev("A"), ev("B"), ev("a ")], // "a " normalizes to the same key as "A"
  })
  assert.deepEqual(first, { previousCount: 0, added: 2, newTotal: 2 })

  const second = await appendSeenItems({
    directory: dir,
    seenFileName: "seen-events.json",
    keyFields: KEY,
    items: [ev("B"), ev("C")],
  })
  assert.deepEqual(second, { previousCount: 2, added: 1, newTotal: 3 })

  const onDisk = JSON.parse(await readFile(path.join(dir, "seen-events.json"), "utf8"))
  assert.deepEqual(onDisk.map((e) => e.title), ["A", "B", "C"])
})

test("appendSeenItems refuses to append to a store that isn't an array", async () => {
  const dir = await tempDir()
  await writeFile(path.join(dir, "seen-events.json"), '{"oops": true}')
  await assert.rejects(
    appendSeenItems({ directory: dir, seenFileName: "seen-events.json", keyFields: KEY, items: [ev("A")] }),
    /not a JSON array/
  )
  assert.equal(await readFile(path.join(dir, "seen-events.json"), "utf8"), '{"oops": true}')
})

test("record-on-send then the prompt's append call is idempotent", async () => {
  const dir = await tempDir()
  const record = createSeenRecorder({ seenFileName: "seen-events.json", keyFields: KEY })
  const sent = [ev("A"), ev("B")]

  // send_digest_email's hook, right after a confirmed send.
  assert.equal((await record({ items: sent, directory: dir })).added, 2)
  // The append tool later reads the same staged items — nothing new.
  assert.equal((await record({ items: sent, directory: dir })).added, 0)

  const onDisk = JSON.parse(await readFile(path.join(dir, "seen-events.json"), "utf8"))
  assert.equal(onDisk.length, 2)
})
