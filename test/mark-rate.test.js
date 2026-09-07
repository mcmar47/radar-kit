// The fleet mark-rate report: the whole-store cohort join (what fraction of
// every delivered item carries a decision) plus the "new marks this week"
// momentum figure; the once-a-week disk-reading section and its state-file
// gate; and the multi-section combinator feed-radar uses to carry it
// alongside the Research Desk answer.

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { buildMarkRateReport } from "../src/markRate.js"
import { countMarksSince, sumDeliveredSince } from "../src/scorecard.js"
import { createMarkRateSection } from "../src/markRateSection.js"
import { combineExtraSections } from "../src/combineExtraSections.js"

const NOW = Date.parse("2026-09-14T13:30:00.000Z")
const daysAgo = (n) => new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString()

// ---------------------------------------------------------------------------
// scorecard.js — the shared window helper markRate reuses for "new this week"
// ---------------------------------------------------------------------------

test("countMarksSince counts timestamped marks at/after the cutoff, never bare true", () => {
  const store = {
    a: { at: daysAgo(1), via: "app" },
    b: { at: daysAgo(6), via: "email" },
    c: { at: daysAgo(30), via: "web" },
    d: true, // legacy, no timestamp
  }
  assert.equal(countMarksSince(store, NOW - 7 * 86400000), 2)
  assert.equal(countMarksSince(store, NOW - 40 * 86400000), 3)
  assert.equal(countMarksSince(undefined, NOW), 0)
})

test("sumDeliveredSince still totals run counts at/after the cutoff", () => {
  const runs = [
    { at: daysAgo(30), count: 99 },
    { at: daysAgo(5), count: 10 },
    { at: daysAgo(2), count: 6 },
  ]
  assert.equal(sumDeliveredSince(runs, NOW - 7 * 86400000), 16)
})

// ---------------------------------------------------------------------------
// buildMarkRateReport — the cohort join
// ---------------------------------------------------------------------------

const radars = () => [
  {
    name: "feed-radar",
    seen: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }],
    keyFields: ["id"],
    interested: { "1": { at: daysAgo(2) }, "2": { at: daysAgo(30) } },
    ignored: { "3": { at: daysAgo(1) } },
  },
  {
    name: "job-radar",
    seen: [
      { company: "Acme", title: "SWE", link: "http://x/1" },
      { company: "Beta", title: "SRE", link: "http://x/2" },
    ],
    keyFields: ["company", "title", "link"],
    interested: {},
    ignored: {},
  },
]

test("rate is decided-items over distinct delivered items in the seen store", () => {
  const r = buildMarkRateReport({ radars: radars(), now: NOW })
  const feed = r.rows.find((x) => x.name === "feed-radar")
  assert.equal(feed.delivered, 4)
  assert.equal(feed.decided, 3) // ids 1, 2, 3 marked; 4 not
  assert.equal(feed.rate, 75)
})

test("newMarks counts only marks whose timestamp is inside the trailing window", () => {
  const r = buildMarkRateReport({ radars: radars(), now: NOW })
  const feed = r.rows.find((x) => x.name === "feed-radar")
  assert.equal(feed.newMarks, 2) // id 1 (2d) + id 3 (1d); id 2 is 30d out
})

test("a mark for an item no longer in the seen store does not inflate the rate", () => {
  const r = buildMarkRateReport({
    radars: [
      {
        name: "x",
        seen: [{ id: 1 }],
        keyFields: ["id"],
        interested: { "1": { at: daysAgo(1) }, "999": { at: daysAgo(1) } },
        ignored: {},
      },
    ],
    now: NOW,
  })
  assert.equal(r.rows[0].delivered, 1)
  assert.equal(r.rows[0].decided, 1)
  assert.equal(r.rows[0].rate, 100)
})

test("an empty seen store shows — not 0%, and does not divide by zero", () => {
  const r = buildMarkRateReport({
    radars: [{ name: "new", seen: [], keyFields: ["id"], interested: {}, ignored: {} }],
    now: NOW,
  })
  assert.equal(r.rows[0].rate, null)
  assert.match(r.text, /new\s+—/)
})

test("keys are normalized like the interest-server (case/space-folded, dedup)", () => {
  const r = buildMarkRateReport({
    radars: [
      {
        name: "ev",
        seen: [
          { title: "Book  Fair", date: "2026-09-20" },
          { title: "book fair", date: "2026-09-20" }, // same key after normalize
        ],
        keyFields: ["title", "date"],
        interested: { "book fair|2026-09-20": { at: daysAgo(1) } },
        ignored: {},
      },
    ],
    now: NOW,
  })
  assert.equal(r.rows[0].delivered, 1, "the two rows collapse to one distinct item")
  assert.equal(r.rows[0].decided, 1)
})

test("a blank-every-field row is not counted as a delivered item", () => {
  const r = buildMarkRateReport({
    radars: [
      {
        name: "ev",
        seen: [{ title: "", date: "" }, { title: "Real", date: "2026-09-20" }],
        keyFields: ["title", "date"],
        interested: {},
        ignored: {},
      },
    ],
    now: NOW,
  })
  assert.equal(r.rows[0].delivered, 1)
})

test("the fleet row totals every radar and drives the headline", () => {
  const r = buildMarkRateReport({ radars: radars(), now: NOW })
  assert.equal(r.fleet.delivered, 6) // 4 feed + 2 job
  assert.equal(r.fleet.decided, 3)
  assert.equal(r.fleet.rate, 50)
  assert.match(r.headline, /50% of delivered items have a star\/reject decision \(3\/6\)/)
  assert.match(r.headline, /\+2 in the last 7 days/)
  assert.match(r.line, /^Fleet mark rate — /)
})

test("html section carries no h1/h2 and is script-free", () => {
  const r = buildMarkRateReport({ radars: radars(), now: NOW })
  assert.doesNotMatch(r.html, /<h[12][\s>]/i)
  assert.doesNotMatch(r.html, /<script/i)
  assert.match(r.html, /^<hr>/)
  assert.match(r.html, /Fleet mark rate/)
})

test("precomputed seenKeys is an accepted alternative to seen + keyFields", () => {
  const r = buildMarkRateReport({
    radars: [
      {
        name: "x",
        seenKeys: ["a", "b", "c"],
        interested: { a: { at: daysAgo(1) } },
        ignored: { b: { at: daysAgo(1) } },
      },
    ],
    now: NOW,
  })
  assert.equal(r.rows[0].delivered, 3)
  assert.equal(r.rows[0].decided, 2)
})

// ---------------------------------------------------------------------------
// createMarkRateSection — disk reads + weekly gate
// ---------------------------------------------------------------------------

async function fixtureRadar(root, name, { seenFile, seen = [], interested = {}, ignored = {} }) {
  const dir = path.join(root, name)
  await mkdir(path.join(dir, "logs"), { recursive: true })
  await writeFile(path.join(dir, seenFile), JSON.stringify(seen))
  await writeFile(path.join(dir, "interested.json"), JSON.stringify(interested))
  await writeFile(path.join(dir, "ignored.json"), JSON.stringify(ignored))
  return { name, dir, seenFile }
}

test("section reads each radar's seen store and emits on a first run (no state file)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "markrate-"))
  const feed = await fixtureRadar(root, "feed-radar", {
    seenFile: "picks.json",
    seen: [{ id: 1 }, { id: 2 }],
    interested: { "1": { at: daysAgo(1) } },
  })
  const job = await fixtureRadar(root, "job-radar", {
    seenFile: "seen-jobs.json",
    seen: [{ company: "A", title: "T", link: "L" }],
  })

  const section = createMarkRateSection({
    radarDirs: [
      { ...feed, keyFields: ["id"] },
      { ...job, keyFields: ["company", "title", "link"] },
    ],
    now: () => NOW,
  })
  const out = await section.read(feed.dir)
  assert.ok(out)
  assert.equal(out.id, "mark-rate")
  assert.match(out.text, /feed-radar\s+50%\s+\(1\/2\)/)
  assert.match(out.text, /job-radar\s+0%\s+\(0\/1\)/)
})

test("section is silent until minIntervalDays have passed, then emits again", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "markrate-"))
  const feed = await fixtureRadar(root, "feed-radar", { seenFile: "picks.json", seen: [{ id: 1 }] })
  await writeFile(
    path.join(feed.dir, "logs/mark-rate.json"),
    JSON.stringify({ lastSentAt: daysAgo(3) })
  )
  const radarDirs = [{ ...feed, keyFields: ["id"] }]

  assert.equal(
    await createMarkRateSection({ radarDirs, now: () => NOW }).read(feed.dir),
    null,
    "3 days later: still quiet"
  )
  assert.ok(
    await createMarkRateSection({ radarDirs, now: () => NOW + 5 * 86400000 }).read(feed.dir),
    "8 days later: emits"
  )
})

test("onDelivered stamps the state file so the next run is gated", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "markrate-"))
  const feed = await fixtureRadar(root, "feed-radar", { seenFile: "picks.json", seen: [{ id: 1 }] })
  const section = createMarkRateSection({
    radarDirs: [{ ...feed, keyFields: ["id"] }],
    now: () => NOW,
  })

  const out = await section.read(feed.dir)
  await out.onDelivered()

  const state = JSON.parse(await readFile(path.join(feed.dir, "logs/mark-rate.json"), "utf8"))
  assert.equal(state.lastSentAt, new Date(NOW).toISOString())
  assert.equal(await section.read(feed.dir), null, "gated right after delivery")
})

test("a missing seen file degrades to zero delivered, not a crash", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "markrate-"))
  await mkdir(path.join(root, "feed-radar", "logs"), { recursive: true })
  const section = createMarkRateSection({
    radarDirs: [
      { name: "feed-radar", dir: path.join(root, "feed-radar"), seenFile: "picks.json", keyFields: ["id"] },
    ],
    now: () => NOW,
  })
  const out = await section.read(path.join(root, "feed-radar"))
  assert.ok(out)
  assert.match(out.text, /feed-radar\s+—/)
})

// ---------------------------------------------------------------------------
// combineExtraSections
// ---------------------------------------------------------------------------

test("combines non-null sections in order and fans out onDelivered", async () => {
  const calls = []
  const combined = combineExtraSections([
    { read: async () => ({ id: "research", html: "<p>R</p>", text: "\nR", onDelivered: async () => calls.push("research") }) },
    { read: async () => ({ id: "mark-rate", html: "<p>M</p>", text: "\nM", onDelivered: async () => calls.push("mark-rate") }) },
  ])
  const out = await combined.read("/x")
  assert.equal(out.id, "research+mark-rate")
  assert.equal(out.html, "<p>R</p><p>M</p>")
  assert.equal(out.text, "\nR\nM")
  await out.onDelivered()
  assert.deepEqual(calls, ["research", "mark-rate"])
})

test("all-null sections combine to null; a throwing section is skipped", async () => {
  assert.equal(
    await combineExtraSections([{ read: async () => null }, { read: async () => null }]).read("/x"),
    null
  )
  const out = await combineExtraSections([
    { read: async () => { throw new Error("boom") } },
    { read: async () => ({ id: "mark-rate", html: "<p>M</p>", text: "M" }) },
  ]).read("/x")
  assert.equal(out.id, "mark-rate")
})
