// readPendingPrizeDigest (src/prizeRadar.js). Mirrors research-desk.test.js
// and serendipity.test.js's shape, adapted for a git-committed weekly
// snapshot file with no onDelivered/queue semantics — freshness alone gates
// re-delivery, there's no per-item delivered state.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { readPendingPrizeDigest } from "../src/prizeRadar.js"

const NOW = Date.parse("2026-09-20T06:30:00Z")

async function digestFile(digest) {
  const dir = await mkdtemp(path.join(tmpdir(), "prize-digest-"))
  const file = path.join(dir, "digest.json")
  await writeFile(file, JSON.stringify(digest))
  return { file, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

const baseDigest = (over = {}) => ({
  schemaVersion: 1,
  generatedAt: "2026-09-20T05:30:00Z",
  headline: "The Booker shortlist landed.",
  dek: "6 titles remain, down from 13.",
  movements: [
    {
      tag: "Booker Prize",
      headline: "Shortlist announced",
      body: "6 of 13 titles advanced.",
      sources: [{ label: "The Booker Prizes", url: "https://thebookerprizes.com/x" }],
    },
  ],
  nextCheck: "2026-09-27",
  ...over,
})

test("returns a fresh digest with movements as a Prize Watch section", async () => {
  const { file, cleanup } = await digestFile(baseDigest())
  const section = await readPendingPrizeDigest(file, { now: NOW })
  assert.equal(section.id, "2026-09-20T05:30:00Z")
  assert.match(section.html, /<hr><h3[^>]*>Prize Watch<\/h3>/)
  assert.match(section.html, /Shortlist announced/)
  assert.match(section.html, /6 of 13 titles advanced\./)
  assert.match(section.html, /The Booker Prizes/)
  assert.match(section.text, /Prize Watch/)
  assert.match(section.text, /- Booker Prize: Shortlist announced/)
  assert.equal(section.onDelivered, undefined, "no per-item delivery state for a git-committed snapshot")
  await cleanup()
})

test("escapes html-unsafe characters in movement text", async () => {
  const { file, cleanup } = await digestFile(
    baseDigest({
      movements: [{ tag: "<script>", headline: "A & B", body: "\"quoted\"", sources: [] }],
    })
  )
  const section = await readPendingPrizeDigest(file, { now: NOW })
  assert.ok(!section.html.includes("<script>"))
  assert.match(section.html, /&lt;script&gt;/)
  assert.match(section.html, /A &amp; B/)
  await cleanup()
})

test("a quiet week (no movements) is null even if fresh", async () => {
  const { file, cleanup } = await digestFile(baseDigest({ movements: [] }))
  assert.equal(await readPendingPrizeDigest(file, { now: NOW }), null)
  await cleanup()
})

test("a stale digest (past the freshness window) is null", async () => {
  const { file, cleanup } = await digestFile(baseDigest({ generatedAt: "2026-09-10T05:30:00Z" }))
  assert.equal(await readPendingPrizeDigest(file, { now: NOW }), null)
  await cleanup()
})

test("a malformed generatedAt is null, never a throw", async () => {
  const { file, cleanup } = await digestFile(baseDigest({ generatedAt: "not-a-date" }))
  assert.equal(await readPendingPrizeDigest(file, { now: NOW }), null)
  await cleanup()
})

test("a missing or unreadable file is null, never a throw", async () => {
  assert.equal(await readPendingPrizeDigest("/no/such/digest.json", { now: NOW }), null)
})

test("a non-object or malformed JSON is null, never a throw", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "prize-digest-"))
  const file = path.join(dir, "digest.json")
  await writeFile(file, "null")
  assert.equal(await readPendingPrizeDigest(file, { now: NOW }), null)
  await rm(dir, { recursive: true, force: true })
})
