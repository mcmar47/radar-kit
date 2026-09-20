// readPendingSerendipityDiscoveries (src/serendipity.js). Mirrors
// research-desk.test.js's shape, adapted for the flat-array/batchId
// grouping this store uses instead of a { batches: [...] } wrapper.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { readPendingSerendipityDiscoveries } from "../src/serendipity.js"

const NOW = Date.parse("2026-09-19T06:30:00Z")

async function discoveriesFile(records) {
  const dir = await mkdtemp(path.join(tmpdir(), "discoveries-"))
  const file = path.join(dir, "discoveries.json")
  await writeFile(file, JSON.stringify(records))
  return { file, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

const discovery = (over = {}) => ({
  id: "d-1",
  batchId: "b-2026-09-19",
  generatedAt: "2026-09-19T05:00:00Z",
  deliveredAt: null,
  kind: "exhibition",
  title: "A show about deep-sea creatures",
  why_it_connects: "You keep reading about archaeology and natural history.",
  why_it_is_unexpected: "You have never marked anything about marine biology.",
  link: "https://example.com/exhibit",
  availability: "Through November",
  discoveredAt: "2026-09-19T05:00:00Z",
  ...over,
})

test("returns the freshest undelivered, in-window batch, grouped", async () => {
  const { file, cleanup } = await discoveriesFile([
    discovery({ id: "old-1", batchId: "b-old", generatedAt: "2026-09-12T05:00:00Z" }), // >26h → stale
    discovery({ id: "new-1", batchId: "b-new", generatedAt: "2026-09-19T05:00:00Z", title: "First" }),
    discovery({ id: "new-2", batchId: "b-new", generatedAt: "2026-09-19T05:00:00Z", title: "Second" }),
  ])
  const section = await readPendingSerendipityDiscoveries(file, { now: NOW })
  assert.equal(section.id, "b-new")
  assert.match(section.html, /<hr><h3[^>]*>Serendipity<\/h3>/)
  assert.match(section.html, /First/)
  assert.match(section.html, /Second/)
  assert.match(section.text, /Serendipity\n- First/)
  assert.equal(typeof section.onDelivered, "function")
  await cleanup()
})

test("skips delivered, un-batched, and out-of-window records → null", async () => {
  for (const records of [
    [discovery({ deliveredAt: "2026-09-19T06:30:00Z" })],
    [discovery({ batchId: null })],
    [discovery({ generatedAt: "2026-09-10T00:00:00Z" })],
    [],
  ]) {
    const { file, cleanup } = await discoveriesFile(records)
    assert.equal(await readPendingSerendipityDiscoveries(file, { now: NOW }), null)
    await cleanup()
  }
})

test("a missing or unreadable store is null, never a throw", async () => {
  assert.equal(
    await readPendingSerendipityDiscoveries("/no/such/discoveries.json", { now: NOW }),
    null
  )
})

test("a non-array store (e.g. legacy or corrupt) is treated as empty, never throws", async () => {
  const { file, cleanup } = await discoveriesFile({ batches: [] })
  assert.equal(await readPendingSerendipityDiscoveries(file, { now: NOW }), null)
  await cleanup()
})

test("the rendered section carries no <h2> (would break the digest validator)", async () => {
  const { file, cleanup } = await discoveriesFile([discovery()])
  const section = await readPendingSerendipityDiscoveries(file, { now: NOW })
  assert.equal(/<h2[ >]/i.test(section.html), false)
  await cleanup()
})

test("one-click links carry the kind+title key and both mark endpoints", async () => {
  const { file, cleanup } = await discoveriesFile([discovery({ kind: "game", title: "Weird & Wonderful" })])
  const section = await readPendingSerendipityDiscoveries(file, { now: NOW })
  assert.match(section.html, /mark=interested/)
  assert.match(section.html, /mark=ignored/)
  assert.match(section.html, /kind=game/)
  await cleanup()
})
