// The digest footer's scorecard: a single line that puts recent pick
// quality — how many delivered items were starred vs. rejected over a
// trailing window — in front of you every time a digest lands, next to
// which model produced this run and (when known) what it cost.
//
// Why it exists: two agents moved to GLM 5.3 Flash on 2026-09-01 and there
// was no way to see what that did to pick quality without going and
// counting marks by hand. The star/reject marks are the only quality
// signal these agents have, and they were invisible between runs.
//
// This module is the render half and is deliberately free of any
// @opencode-ai/plugin import, like calibration.js and markStore.js, so an
// interest-server or a plain script can use it. The tool wiring that reads
// the mark files and the run log off disk lives in digestTools.js.
//
// The window counts marks by their `at` timestamp — the field markStore
// started recording in 2026-09. A mark from before that (a bare `true`,
// no timestamp) is never inside any window, which is correct: it predates
// the scorecard by definition.

import { markInfo } from "./markStore.js"

const DAY_MS = 24 * 60 * 60 * 1000

// How many marks in `store` were made within the last `days` days.
function countWithin(store, days, now) {
  const cutoff = now - days * DAY_MS
  let n = 0
  for (const value of Object.values(store)) {
    const at = markInfo(value).at
    if (at) {
      const t = Date.parse(at)
      if (!Number.isNaN(t) && t >= cutoff) n++
    }
  }
  return n
}

// Sum the `count` field of run-log entries whose `at` is within the window.
// The current run is not in the log yet when this is built, so this is
// genuinely "delivered previously", not including today.
function deliveredWithin(runs, days, now) {
  const cutoff = now - days * DAY_MS
  let total = 0
  for (const run of runs) {
    const t = Date.parse(run?.at ?? "")
    if (!Number.isNaN(t) && t >= cutoff) total += Number(run.count) || 0
  }
  return total
}

// Round a small dollar amount for display: cents for anything under $10,
// otherwise two decimals still (these runs cost well under a dollar).
function formatUsd(usd) {
  if (typeof usd !== "number" || !Number.isFinite(usd) || usd < 0) return null
  if (usd === 0) return "$0.00"
  if (usd < 0.01) return "<$0.01"
  return `$${usd.toFixed(2)}`
}

/**
 * Build the scorecard as `{ line, html, text }`.
 *
 * @param {object} interested  the "interested" mark store (from readMarks)
 * @param {object} ignored     the "ignored" mark store
 * @param {object[]} runs      the run log: `[{ at, count, model?, costUsd? }]`
 * @param {number} days        trailing window, default 7
 * @param {string} model       model id for THIS run, e.g. "openrouter/z-ai/glm-5.3-flash"
 * @param {number} costUsd     cost of THIS run in USD, if known; omitted otherwise
 * @param {number} now         epoch ms, injectable for tests
 * @param {string} noun        plural noun for delivered items, e.g. "picks"
 */
export function buildScorecard({
  interested = {},
  ignored = {},
  runs = [],
  days = 7,
  model,
  costUsd,
  now = Date.now(),
  noun = "delivered",
} = {}) {
  const delivered = deliveredWithin(runs, days, now)
  const starred = countWithin(interested, days, now)
  const rejected = countWithin(ignored, days, now)

  const counts =
    delivered > 0
      ? `${delivered} ${noun}, ${starred} starred, ${rejected} rejected`
      : `${starred} starred, ${rejected} rejected`

  // A short, human model label: drop the provider prefix, keep the rest.
  const modelLabel = model ? String(model).split("/").slice(-1)[0] : null
  const cost = formatUsd(costUsd)

  const tailParts = []
  if (modelLabel) tailParts.push(modelLabel)
  if (cost) tailParts.push(`${cost} this run`)
  const tail = tailParts.length ? ` · ${tailParts.join(" · ")}` : ""

  const line = `Last ${days} days: ${counts}${tail}`

  return {
    line,
    html:
      `<hr><p style="color:#667;font-size:13px;margin-top:24px">` +
      `${escapeText(line)}</p>`,
    text: `\n—\n${line}`,
  }
}

// A tiny local escaper — this module stays dependency-free and html.js is
// fine to import, but the scorecard line is plain generated text with at
// most an "&", so inline is clearer than a cross-module call here.
function escapeText(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
}

/**
 * Append one entry to a run log array, newest last, capped so the file
 * cannot grow without bound. Pure — returns the new array, does no IO.
 */
export function appendRun(runs, entry, { keep = 90 } = {}) {
  const next = Array.isArray(runs) ? [...runs] : []
  next.push({
    at: entry.at ?? new Date().toISOString(),
    count: Number(entry.count) || 0,
    ...(entry.model ? { model: entry.model } : {}),
    ...(typeof entry.costUsd === "number" ? { costUsd: entry.costUsd } : {}),
  })
  return next.slice(-keep)
}
