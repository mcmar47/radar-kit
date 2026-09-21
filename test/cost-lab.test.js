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

test("buildCostLabReport accepts pre-built buildAgentCost results unchanged", () => {
  const pre = buildAgentCost({ name: "x", runs: [{ at: daysAgo(1), count: 1, costUsd: 0.4 }], weeks: 2, now: NOW })
  const report = buildCostLabReport({ agents: [pre], weeks: 2, now: NOW })
  assert.equal(report.agents[0], pre)
  assert.equal(report.fleet.allLogged, 0.4)
})

test("the rendered html is a full document, has no script tags, and is safe HTML", () => {
  const report = buildCostLabReport({
    agents: [{ name: 'a & "b"', runs: [{ at: daysAgo(1), count: 1, costUsd: 0.12 }] }],
    weeks: 3,
    now: NOW,
  })
  assert.match(report.html, /^<!doctype html>/)
  assert.match(report.html, /<\/html>\s*$/)
  assert.doesNotMatch(report.html, /<script/i)
  assert.match(report.html, /a &amp; &quot;b&quot;/)
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
