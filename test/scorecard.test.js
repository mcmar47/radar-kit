// The digest-footer scorecard: counting recent marks by their timestamp,
// totalling delivered items from the run log, and the footer wiring in
// renderDigestContent.

import { test } from "node:test"
import assert from "node:assert/strict"

import { buildScorecard, appendRun } from "../src/scorecard.js"
import { renderDigestContent } from "../src/digest.js"

const NOW = Date.parse("2026-09-10T12:00:00.000Z")
const daysAgo = (n) =>
  new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString()

test("counts only marks whose timestamp falls inside the window", () => {
  const sc = buildScorecard({
    interested: {
      a: { at: daysAgo(1), via: "app" },
      b: { at: daysAgo(6), via: "email" },
      c: { at: daysAgo(20), via: "web" }, // outside 7d
    },
    ignored: { d: { at: daysAgo(2), via: "web" } },
    days: 7,
    now: NOW,
  })
  assert.match(sc.line, /2 starred, 1 rejected/)
})

test("legacy bare-true marks never count toward the window", () => {
  const sc = buildScorecard({
    interested: { a: true, b: true, c: { at: daysAgo(1), via: "app" } },
    now: NOW,
  })
  assert.match(sc.line, /1 starred, 0 rejected/)
})

test("delivered total comes from run-log entries inside the window", () => {
  const sc = buildScorecard({
    runs: [
      { at: daysAgo(30), count: 99 }, // outside
      { at: daysAgo(5), count: 10 },
      { at: daysAgo(2), count: 6 },
    ],
    interested: { a: { at: daysAgo(1), via: "app" } },
    days: 7,
    noun: "picks",
    now: NOW,
  })
  assert.match(sc.line, /Last 7 days: 16 picks, 1 starred, 0 rejected/)
})

test("with no delivered history the line drops the picks clause", () => {
  const sc = buildScorecard({
    ignored: { a: { at: daysAgo(1), via: "web" } },
    now: NOW,
  })
  assert.match(sc.line, /^Last 7 days: 0 starred, 1 rejected$/)
})

test("model label is shortened to its last path segment; cost shown when given", () => {
  const sc = buildScorecard({
    interested: { a: { at: daysAgo(1), via: "app" } },
    model: "openrouter/z-ai/glm-5.3-flash",
    costUsd: 0.037,
    now: NOW,
  })
  assert.match(sc.line, /· glm-5\.3-flash · \$0\.04 this run$/)
})

test("a sub-cent cost renders as <$0.01, a zero cost as $0.00", () => {
  assert.match(
    buildScorecard({ model: "m", costUsd: 0.002, now: NOW }).line,
    /<\$0\.01 this run/
  )
  assert.match(
    buildScorecard({ model: "m", costUsd: 0, now: NOW }).line,
    /\$0\.00 this run/
  )
})

test("the html footer is safe to concatenate and adds no heading", () => {
  const sc = buildScorecard({ interested: { a: { at: daysAgo(1) } }, now: NOW })
  assert.doesNotMatch(sc.html, /<h2/i)
  assert.match(sc.html, /^<hr>/)
  assert.doesNotMatch(sc.html, /<script/i)
})

test("appendRun keeps newest last and caps length", () => {
  let runs = []
  for (let i = 0; i < 100; i++) {
    runs = appendRun(runs, { at: daysAgo(100 - i), count: i }, { keep: 90 })
  }
  assert.equal(runs.length, 90)
  assert.equal(runs.at(-1).count, 99)
  assert.equal(runs[0].count, 10, "the oldest 10 were dropped")
})

test("appendRun only stores costUsd when it is a number", () => {
  const [entry] = appendRun([], { count: 3, model: "m" })
  assert.equal(entry.model, "m")
  assert.ok(!("costUsd" in entry))
  const [withCost] = appendRun([], { count: 3, costUsd: 0.1 })
  assert.equal(withCost.costUsd, 0.1)
})

// ---------------------------------------------------------------------------
// renderDigestContent — the footer hook
// ---------------------------------------------------------------------------

const config = {
  pageTitle: "Test",
  unitLabel: "item",
  groupKey: (i) => i.group,
  renderItemHtml: (i) => `<li>${i.title}</li>`,
  renderItemText: (i) => `- ${i.title}`,
}
const items = [{ group: "a", title: "One" }]

test("a footer lands before </body></html> and at the end of the text", () => {
  const { html, text } = renderDigestContent(config, items, "2026-09-10", {
    footerHtml: '<hr><p>Last 7 days: 5 items</p>',
    footerText: "\n—\nLast 7 days: 5 items",
  })
  assert.match(html, /<hr><p>Last 7 days: 5 items<\/p>\s*<\/body><\/html>$/)
  assert.match(text, /Last 7 days: 5 items$/)
})

test("no footer options leaves the output exactly as before", () => {
  const { html } = renderDigestContent(config, items, "2026-09-10")
  assert.match(html, /<\/body><\/html>$/)
  assert.doesNotMatch(html, /<hr>/)
})
