// Radar Quality Lab v1 (FUTURE-PROJECTS.md project 7's reader half):
// per-radar delivered/starred/rejected/unmarked, duplicate-key detection,
// staleness, and a per-group breakdown with denominator suppression.

import { test } from "node:test"
import assert from "node:assert/strict"

import { buildRadarQuality, buildQualityLabReport } from "../src/qualityLab.js"

const NOW = Date.parse("2026-09-19T12:00:00.000Z")
const daysAgo = (n) => new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString()
const isoDaysAgo = (n) => daysAgo(n).slice(0, 10)

test("buildRadarQuality counts delivered/starred/rejected/unmarked by key", () => {
  const r = buildRadarQuality({
    name: "feed-radar",
    records: [
      { id: 1, source: "A" },
      { id: 2, source: "A" },
      { id: 3, source: "B" },
    ],
    keyFields: [{ field: "id", exact: true }],
    interested: { "1": { at: daysAgo(1) } },
    ignored: { "2": { at: daysAgo(1) } },
    now: NOW,
  })
  assert.equal(r.delivered, 3)
  assert.equal(r.starred, 1)
  assert.equal(r.rejected, 1)
  assert.equal(r.unmarked, 1)
  assert.equal(r.markRate, 67) // 2/3
  assert.equal(r.starRate, 50) // 1/2
})

test("records sharing a key count as one delivered item but are flagged as a duplicate", () => {
  const r = buildRadarQuality({
    name: "event-watch",
    records: [
      { title: "a reading", date: "2026-10-01" },
      { title: "a reading", date: "2026-10-01" }, // exact dup, e.g. re-scraped
      { title: "another event", date: "2026-10-02" },
    ],
    keyFields: ["title", "date"],
    interested: {},
    ignored: {},
    now: NOW,
  })
  assert.equal(r.delivered, 2)
  assert.equal(r.duplicateItems, 1)
  assert.equal(r.duplicateExcess, 1)
})

test("a blank-key record (every field empty) is dropped, not counted as delivered", () => {
  const r = buildRadarQuality({
    name: "release-radar",
    records: [{ watch: "", type: "", title: "" }, { watch: "x", type: "book", title: "y" }],
    keyFields: ["watch", "type", "title"],
    now: NOW,
  })
  assert.equal(r.delivered, 1)
})

test("an unmarked item is stale once its date field is more than staleDays in the past", () => {
  const r = buildRadarQuality({
    name: "job-radar",
    records: [
      { link: "a", posted: isoDaysAgo(60) }, // stale
      { link: "b", posted: isoDaysAgo(5) }, // fresh
      { link: "c", posted: isoDaysAgo(90) }, // would be stale, but marked
    ],
    keyFields: [{ field: "link", exact: true }],
    interested: { c: { at: daysAgo(1) } },
    dateField: "posted",
    staleDays: 30,
    now: NOW,
  })
  assert.equal(r.staleUnmarked, 1)
})

test("a future date never counts as stale, however aggressive staleDays is", () => {
  const r = buildRadarQuality({
    name: "release-radar",
    records: [{ link: "a", release_date: "2030-01-01" }],
    keyFields: [{ field: "link", exact: true }],
    dateField: "release_date",
    staleDays: 0,
    now: NOW,
  })
  assert.equal(r.staleUnmarked, 0)
})

test("an unparseable date field is not counted as stale", () => {
  const r = buildRadarQuality({
    name: "release-radar",
    records: [{ link: "a", release_date: "TBD" }],
    keyFields: [{ field: "link", exact: true }],
    dateField: "release_date",
    staleDays: 1,
    now: NOW,
  })
  assert.equal(r.staleUnmarked, 0)
})

test("per-group breakdown reports a rate with its denominator, and suppresses thin groups", () => {
  const records = [
    { id: 1, source: "A" },
    { id: 2, source: "A" },
    { id: 3, source: "A" },
    { id: 4, source: "A" },
    { id: 5, source: "A" },
    { id: 6, source: "A" },
    { id: 7, source: "B" }, // only one decided mark -> suppressed
  ]
  const interested = { "1": {}, "2": {}, "3": {} }
  const ignored = { "4": {}, "5": {}, "7": {} }
  const r = buildRadarQuality({
    name: "feed-radar",
    records,
    keyFields: [{ field: "id", exact: true }],
    interested,
    ignored,
    groupField: "source",
    groupLabel: "Source",
    minGroupDenominator: 5,
    now: NOW,
  })
  const a = r.groups.find((g) => g.label === "A")
  const b = r.groups.find((g) => g.label === "B")
  assert.equal(a.total, 6)
  assert.equal(a.decided, 5)
  assert.equal(a.rate, 60) // 3 starred / 5 decided
  assert.equal(a.suppressed, false)
  assert.equal(b.decided, 1)
  assert.equal(b.suppressed, true)
})

test("a record missing the group field lands in an explicit (unknown) group", () => {
  const r = buildRadarQuality({
    name: "feed-radar",
    records: [{ id: 1 }],
    keyFields: [{ field: "id", exact: true }],
    groupField: "source",
    now: NOW,
  })
  assert.equal(r.groups[0].label, "(unknown)")
})

test("a legacy bare-true mark still counts as decided, same as {at,via}", () => {
  const r = buildRadarQuality({
    name: "feed-radar",
    records: [{ id: 1 }],
    keyFields: [{ field: "id", exact: true }],
    interested: { "1": true },
    now: NOW,
  })
  assert.equal(r.starred, 1)
  assert.equal(r.unmarked, 0)
})

test("buildQualityLabReport rolls up fleet totals and renders one HTML page", () => {
  const report = buildQualityLabReport({
    radars: [
      {
        name: "feed-radar",
        records: [{ id: 1, source: "A" }, { id: 2, source: "A" }],
        keyFields: [{ field: "id", exact: true }],
        interested: { "1": { at: daysAgo(1) } },
        groupField: "source",
        groupLabel: "Source",
      },
      {
        name: "job-radar",
        records: [{ link: "a" }],
        keyFields: [{ field: "link", exact: true }],
        ignored: { a: { at: daysAgo(1) } },
      },
    ],
    now: NOW,
  })
  assert.equal(report.fleet.delivered, 3)
  assert.equal(report.fleet.starred, 1)
  assert.equal(report.fleet.rejected, 1)
  assert.equal(report.fleet.unmarked, 1)
  assert.match(report.html, /<title>Radar Quality Lab<\/title>/)
  assert.match(report.html, /feed-radar/)
  assert.match(report.html, /job-radar/)
  // A radar with no groupField configured says so instead of an empty table.
  assert.match(report.html, /No breakdown field configured/)
})

test("buildQualityLabReport accepts pre-built buildRadarQuality results too", () => {
  const pre = buildRadarQuality({
    name: "feed-radar",
    records: [{ id: 1 }],
    keyFields: [{ field: "id", exact: true }],
    now: NOW,
  })
  const report = buildQualityLabReport({ radars: [pre], now: NOW })
  assert.equal(report.fleet.delivered, 1)
})

test("HTML output escapes a hostile source/label value", () => {
  const report = buildQualityLabReport({
    radars: [
      {
        name: "feed-radar",
        records: [{ id: 1, source: '<img src=x onerror=alert(1)>' }],
        keyFields: [{ field: "id", exact: true }],
        interested: { "1": {} },
        ignored: { "2": {} },
        groupField: "source",
      },
    ],
    now: NOW,
  })
  assert.doesNotMatch(report.html, /<img src=x/)
  assert.match(report.html, /&lt;img/)
})
