// The fleet mark-rate report: per-radar and fleet-wide "fraction of
// delivered items decided", over a trailing window and a since-anchor;
// the once-a-week disk-reading section and its state-file gate; and the
// multi-section combinator feed-radar uses to carry it alongside the
// Research Desk answer.

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { buildMarkRateReport, INBOX_SHIPPED_ISO } from "../src/markRate.js"
import { countMarksSince, sumDeliveredSince } from "../src/scorecard.js"
import { createMarkRateSection } from "../src/markRateSection.js"
import { combineExtraSections } from "../src/combineExtraSections.js"

const NOW = Date.parse("2026-09-14T13:30:00.000Z")
const daysAgo = (n) => new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString()

// ---------------------------------------------------------------------------
// scorecard.js — the shared window helpers markRate reuses
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
  assert.equal(countMarksSince({}, NOW), 0)
  assert.equal(countMarksSince(undefined, NOW), 0)
})

test("sumDeliveredSince totals run counts at/after the cutoff", () => {
  const runs = [
    { at: daysAgo(30), count: 99 },
    { at: daysAgo(5), count: 10 },
    { at: daysAgo(2), count: 6 },
    { at: "not-a-date", count: 5 },
  ]
  assert.equal(sumDeliveredSince(runs, NOW - 7 * 86400000), 16)
  assert.equal(sumDeliveredSince([], NOW), 0)
  assert.equal(sumDeliveredSince(undefined, NOW), 0)
})

// ---------------------------------------------------------------------------
// buildMarkRateReport
// ---------------------------------------------------------------------------

const radars = () => [
  {
    name: "feed-radar",
    runs: [
      { at: daysAgo(10), count: 100 }, // outside 7d, inside since-anchor
      { at: daysAgo(5), count: 15 },
      { at: daysAgo(1), count: 15 },
    ],
    interested: { a: { at: daysAgo(2) }, b: { at: daysAgo(4) }, old: { at: daysAgo(10) } },
    ignored: { c: { at: daysAgo(3) } },
  },
  {
    name: "job-radar",
    runs: [{ at: daysAgo(4), count: 7 }],
    interested: {},
    ignored: {},
  },
]

test("per-radar rate is marks over delivered in the window", () => {
  const r = buildMarkRateReport({ radars: radars(), now: NOW })
  const feed = r.rows.find((x) => x.name === "feed-radar")
  assert.equal(feed.marks7, 3) // a, b, c — not `old`
  assert.equal(feed.delivered7, 30)
  assert.equal(feed.rate7, 10)
})

test("since-anchor window is wider than the trailing window", () => {
  const r = buildMarkRateReport({ radars: radars(), now: NOW })
  const feed = r.rows.find((x) => x.name === "feed-radar")
  assert.equal(feed.deliveredSince, 130)
  assert.equal(feed.marksSince, 4) // includes `old`
  assert.equal(feed.rateSince, 3)
})

test("a radar that delivered nothing in the window shows — not 0%", () => {
  const r = buildMarkRateReport({
    radars: [{ name: "quiet", runs: [], interested: {}, ignored: {} }],
    now: NOW,
  })
  assert.equal(r.rows[0].rate7, null)
  assert.match(r.text, /quiet\s+—/)
})

test("the fleet row totals every radar and drives the headline", () => {
  const r = buildMarkRateReport({ radars: radars(), now: NOW })
  assert.equal(r.fleet.marks7, 3)
  assert.equal(r.fleet.delivered7, 37)
  assert.equal(r.fleet.rate7, 8) // 3/37 → 8%
  assert.match(r.headline, /Last 7 days: 8% of delivered items decided \(3\/37\)/)
  assert.match(r.headline, /Since 2026-08-30:/)
  assert.match(r.line, /^Fleet mark rate — /)
})

test("html section carries no h1/h2 and is script-free", () => {
  const r = buildMarkRateReport({ radars: radars(), now: NOW })
  assert.doesNotMatch(r.html, /<h[12][\s>]/i)
  assert.doesNotMatch(r.html, /<script/i)
  assert.match(r.html, /^<hr>/)
  assert.match(r.html, /Fleet mark rate/)
})

test("default since-anchor is the Inbox ship date", () => {
  const r = buildMarkRateReport({ radars: radars(), now: NOW })
  assert.match(r.headline, /Since 2026-08-30/)
  assert.equal(INBOX_SHIPPED_ISO.slice(0, 10), "2026-08-30")
})

test("runs and marks before the since-anchor are excluded from the cumulative figure", () => {
  const r = buildMarkRateReport({
    radars: [
      {
        name: "old",
        runs: [
          { at: "2026-08-20T00:00:00Z", count: 500 }, // before the anchor
          { at: daysAgo(3), count: 10 },
        ],
        interested: { pre: { at: "2026-08-15T00:00:00Z" }, post: { at: daysAgo(2) } },
        ignored: {},
      },
    ],
    now: NOW,
  })
  assert.equal(r.rows[0].deliveredSince, 10)
  assert.equal(r.rows[0].marksSince, 1)
})

// ---------------------------------------------------------------------------
// createMarkRateSection — disk reads + weekly gate
// ---------------------------------------------------------------------------

async function fixtureRadar(root, name, { runs = [], interested = {}, ignored = {} }) {
  const dir = path.join(root, name)
  await mkdir(path.join(dir, "logs"), { recursive: true })
  await writeFile(path.join(dir, "logs/digest-runs.json"), JSON.stringify(runs))
  await writeFile(path.join(dir, "interested.json"), JSON.stringify(interested))
  await writeFile(path.join(dir, "ignored.json"), JSON.stringify(ignored))
  return { name, dir }
}

test("section reads sibling repos and emits on a first run (no state file)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "markrate-"))
  const feed = await fixtureRadar(root, "feed-radar", {
    runs: [{ at: daysAgo(1), count: 12 }],
    interested: { a: { at: daysAgo(1) }, b: { at: daysAgo(2) } },
  })
  const job = await fixtureRadar(root, "job-radar", { runs: [{ at: daysAgo(2), count: 6 }] })

  const section = createMarkRateSection({
    radarDirs: [feed, job],
    now: () => NOW,
  })
  const out = await section.read(feed.dir)
  assert.ok(out)
  assert.equal(out.id, "mark-rate")
  assert.match(out.text, /Fleet mark rate/)
  assert.match(out.text, /feed-radar/)
  assert.match(out.text, /job-radar/)
})

test("section is silent until minIntervalDays have passed, then emits again", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "markrate-"))
  const feed = await fixtureRadar(root, "feed-radar", {
    runs: [{ at: daysAgo(1), count: 12 }],
  })
  await writeFile(
    path.join(feed.dir, "logs/mark-rate.json"),
    JSON.stringify({ lastSentAt: daysAgo(3) })
  )
  const section = createMarkRateSection({ radarDirs: [feed], now: () => NOW })

  assert.equal(await section.read(feed.dir), null, "3 days later: still quiet")

  const later = createMarkRateSection({
    radarDirs: [feed],
    now: () => NOW + 5 * 86400000, // 8 days after lastSentAt
  })
  assert.ok(await later.read(feed.dir), "8 days later: emits")
})

test("onDelivered stamps the state file so the next run is gated", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "markrate-"))
  const feed = await fixtureRadar(root, "feed-radar", {
    runs: [{ at: daysAgo(1), count: 12 }],
  })
  const section = createMarkRateSection({ radarDirs: [feed], now: () => NOW })

  const out = await section.read(feed.dir)
  await out.onDelivered()

  const state = JSON.parse(await readFile(path.join(feed.dir, "logs/mark-rate.json"), "utf8"))
  assert.equal(state.lastSentAt, new Date(NOW).toISOString())

  assert.equal(await section.read(feed.dir), null, "gated right after delivery")
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
