// Fleet Cost Lab: per-agent weekly spend buckets, fleet totals, and the
// rendered report — the first thing that sums and charts the costUsd
// figures scorecard.js's appendRun/recordRunCost have been logging per run
// all along (previously only ever shown as a single "last run" digest
// footer line).

import { test } from "node:test"
import assert from "node:assert/strict"

import { buildAgentCost, buildCostLabReport } from "../src/costLab.js"

const NOW = Date.parse("2026-09-21T12:00:00.000Z")
const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const daysAgo = (n) => new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString()

test("buildAgentCost buckets costUsd into trailing 7-day windows, oldest first", () => {
  const a = buildAgentCost({
    name: "feed-radar",
    runs: [
      { at: daysAgo(75), count: 10, costUsd: 0.5 }, // bucket 0 (10 weeks back)
      { at: daysAgo(3), count: 12, costUsd: 0.1 }, // bucket 10 (this week)
      { at: daysAgo(1), count: 12, costUsd: 0.05 }, // bucket 10 too
    ],
    weeks: 11,
    now: NOW,
  })
  assert.equal(a.buckets.length, 11)
  assert.equal(a.buckets[0], 0.5)
  assert.equal(Math.round(a.buckets.at(-1) * 100) / 100, 0.15)
  assert.equal(a.buckets.slice(1, 10).every((v) => v === 0), true)
})

test("buildAgentCost ignores run-log rows with no costUsd (unmeasurable runs)", () => {
  const a = buildAgentCost({
    name: "job-radar",
    runs: [{ at: daysAgo(1), count: 4 }, { at: daysAgo(1), count: 0, costUsd: 0.2 }],
    weeks: 2,
    now: NOW,
  })
  assert.equal(a.runCount, 1)
  assert.equal(a.buckets.at(-1), 0.2)
})

test("buildAgentCost computes last7d/last30d/allLogged and avg/last-run stats", () => {
  const a = buildAgentCost({
    name: "event-watch",
    runs: [
      { at: daysAgo(40), count: 5, costUsd: 1, model: "m/old" },
      { at: daysAgo(10), count: 5, costUsd: 0.2, model: "m/new" },
      { at: daysAgo(1), count: 5, costUsd: 0.1, model: "m/new" },
    ],
    weeks: 13,
    now: NOW,
  })
  assert.equal(a.runCount, 3)
  assert.equal(a.allLogged, 1.3)
  assert.equal(Math.round(a.last30d * 100) / 100, 0.3)
  assert.equal(a.last7d, 0.1)
  assert.equal(Math.round(a.avgPerRun * 1000) / 1000, Math.round((1.3 / 3) * 1000) / 1000)
  assert.equal(a.lastRunCost, 0.1)
  assert.equal(a.lastModel, "m/new")
})

test("buildAgentCost with an empty log reports zeros, not NaN", () => {
  const a = buildAgentCost({ name: "research-desk", runs: [], weeks: 4, now: NOW })
  assert.equal(a.runCount, 0)
  assert.equal(a.allLogged, 0)
  assert.equal(a.avgPerRun, null)
  assert.equal(a.lastRunCost, null)
  assert.deepEqual(a.buckets, [0, 0, 0, 0])
})

test("buildCostLabReport sums agents into a fleet total and per-bucket series", () => {
  const report = buildCostLabReport({
    agents: [
      { name: "a", runs: [{ at: daysAgo(1), count: 1, costUsd: 0.3 }] },
      { name: "b", runs: [{ at: daysAgo(1), count: 1, costUsd: 0.2 }] },
    ],
    weeks: 2,
    now: NOW,
  })
  assert.equal(report.fleet.last7d, 0.5)
  assert.equal(report.fleet.allLogged, 0.5)
  assert.equal(report.fleet.runCount, 2)
  assert.equal(report.fleet.buckets.at(-1), 0.5)
  assert.equal(report.fleet.buckets[0], 0)
})

test("buildCostLabReport auto-sizes the window to the data when weeks is omitted", () => {
  // A fleet ~2 weeks old: earliest costed run 12 days ago → clamps up to
  // the 4-week floor rather than rendering 1-2 mostly-empty bars.
  const young = buildCostLabReport({
    agents: [{ name: "a", runs: [{ at: daysAgo(12), count: 1, costUsd: 0.1 }] }],
    now: NOW,
  })
  assert.equal(young.agents[0].buckets.length, 4)

  // A fleet with 10 weeks of history clamps to that, not the 13-week ceiling.
  const older = buildCostLabReport({
    agents: [{ name: "a", runs: [{ at: daysAgo(68), count: 1, costUsd: 0.1 }] }],
    now: NOW,
  })
  assert.equal(older.agents[0].buckets.length, 11)

  // A fleet older than 13 weeks clamps to the ceiling, not an ever-growing chart.
  const ancient = buildCostLabReport({
    agents: [{ name: "a", runs: [{ at: daysAgo(365), count: 1, costUsd: 0.1 }] }],
    now: NOW,
  })
  assert.equal(ancient.agents[0].buckets.length, 13)

  // No costed runs at all: falls back to the 4-week floor, not zero.
  const empty = buildCostLabReport({ agents: [{ name: "a", runs: [] }], now: NOW })
  assert.equal(empty.agents[0].buckets.length, 4)
})

test("an explicit weeks still overrides auto-sizing", () => {
  const report = buildCostLabReport({
    agents: [{ name: "a", runs: [{ at: daysAgo(1), count: 1, costUsd: 0.1 }] }],
    weeks: 6,
    now: NOW,
  })
  assert.equal(report.agents[0].buckets.length, 6)
})

test("projected30d extrapolates the logged total across the history window", () => {
  // $1.40 logged over 14 days of history -> $0.10/day -> $3.00 projected.
  const report = buildCostLabReport({
    agents: [{ name: "a", runs: [{ at: daysAgo(14), count: 1, costUsd: 1.4 }] }],
    now: NOW,
  })
  assert.equal(report.historyDays, 14)
  assert.equal(Math.round(report.projected30d * 100) / 100, 3.0)
  assert.match(report.html, /Projected 30-day/)
  assert.match(report.html, /~\$3\.00/)
})

test("projected30d is null (and hidden) below MIN_PROJECTION_DAYS of history", () => {
  const report = buildCostLabReport({
    agents: [{ name: "a", runs: [{ at: daysAgo(2), count: 1, costUsd: 0.1 }] }],
    now: NOW,
  })
  assert.equal(report.projected30d, null)
  assert.doesNotMatch(report.html, /Projected 30-day/)
})

test("projected30d is null (and hidden) once real history reaches 30 days", () => {
  const report = buildCostLabReport({
    agents: [{ name: "a", runs: [{ at: daysAgo(30), count: 1, costUsd: 3 }] }],
    weeks: 5,
    now: NOW,
  })
  assert.equal(report.projected30d, null)
  assert.doesNotMatch(report.html, /Projected 30-day/)
})

test("with no costed runs at all, historyDays is 0 and there's no projection", () => {
  const report = buildCostLabReport({ agents: [{ name: "a", runs: [] }], now: NOW })
  assert.equal(report.historyDays, 0)
  assert.equal(report.projected30d, null)
})

test("buildCostLabReport accepts pre-built buildAgentCost results unchanged", () => {
  const pre = buildAgentCost({ name: "x", runs: [{ at: daysAgo(1), count: 1, costUsd: 0.4 }], weeks: 2, now: NOW })
  const report = buildCostLabReport({ agents: [pre], weeks: 2, now: NOW })
  assert.equal(report.agents[0], pre)
  assert.equal(report.fleet.allLogged, 0.4)
})

test("the rendered html is a full document with a safe, inline-only hover tooltip script", () => {
  const report = buildCostLabReport({
    agents: [{ name: 'a & "b"', runs: [{ at: daysAgo(1), count: 1, costUsd: 0.12 }] }],
    weeks: 3,
    now: NOW,
  })
  assert.match(report.html, /^<!doctype html>/)
  assert.match(report.html, /<\/html>\s*$/)
  // The chart's hover tooltip needs JS (the user asked for real
  // interactivity, not just a native title="" tooltip) — but it must stay
  // self-contained: no external script, no fetch/XHR, and dynamic data only
  // ever flows through data-tooltip attributes (rendered via escapeHtml,
  // read back with getAttribute/JSON.parse and written with textContent),
  // never concatenated into the script body itself.
  assert.doesNotMatch(report.html, /<script[^>]*\ssrc=/i)
  assert.doesNotMatch(report.html, /\bfetch\(|\bXMLHttpRequest\b/)
  assert.match(report.html, /textContent/)
  assert.doesNotMatch(report.html, /innerHTML/)
  const scriptBody = report.html.match(/<script>([\s\S]*?)<\/script>/)[1]
  assert.doesNotMatch(scriptBody, /a & "b"/, "agent data must not be concatenated into the script body")
  assert.match(report.html, /a &amp; &quot;b&quot;/)
  assert.match(report.html, /data-tooltip="[^"]*&quot;a &amp; \\&quot;b\\&quot;&quot;/)
})

test("hovering a bar's data-tooltip lists every agent in that week, sorted by spend, with a color per row", () => {
  const report = buildCostLabReport({
    agents: [
      { name: "small-spender", runs: [{ at: daysAgo(1), count: 1, costUsd: 0.05 }] },
      { name: "big-spender", runs: [{ at: daysAgo(1), count: 1, costUsd: 0.2 }] },
    ],
    weeks: 2,
    now: NOW,
  })
  const match = report.html.match(/data-tooltip="([^"]*total[^"]*\$0\.25[^"]*)"/)
  assert.ok(match, "the most recent bucket's tooltip should show the combined $0.25 total")
  const payload = JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&"))
  assert.equal(payload.rows.length, 2)
  assert.equal(payload.rows[0].name, "big-spender", "sorted by spend, highest first")
  assert.equal(payload.rows[0].amount, "$0.20")
  assert.equal(payload.rows[1].name, "small-spender")
  assert.match(payload.rows[0].color, /^var\(--series-\d\)$/)
  assert.notEqual(payload.rows[0].color, payload.rows[1].color)
})

test("a week with no spend gets an empty-rows tooltip, not one omitted entirely", () => {
  const report = buildCostLabReport({
    agents: [{ name: "a", runs: [{ at: daysAgo(1), count: 1, costUsd: 0.1 }] }],
    weeks: 3,
    now: NOW,
  })
  assert.match(report.html, /no spend logged/)
})

test("a zero-spend fleet still renders (niceMax degrades gracefully, no division by zero)", () => {
  const report = buildCostLabReport({
    agents: [{ name: "quiet-agent", runs: [] }],
    weeks: 3,
    now: NOW,
  })
  assert.doesNotMatch(report.html, /NaN/)
  assert.doesNotMatch(report.html, /Infinity/)
})
