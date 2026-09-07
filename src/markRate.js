// The fleet mark-rate report: a weekly read on whether the feedback loop the
// roadmap is built on is actually closing. For each radar and the fleet as a
// whole — of every item this radar has delivered (its seen store), what
// fraction has any star/reject decision — plus how many new marks landed in
// the last 7 days as the momentum signal.
//
// This is FUTURE-PROJECTS.md project 7's "the one measurement worth taking
// now": not pick quality, just mark rate. "That single number, tracked
// weekly, is what tells you whether the whole feedback premise of this
// roadmap holds. It needs a one-line report, not a lab."
//
// Why a whole-store cohort and not a trailing window: a mark's timestamp is
// when someone *decided*, which can be weeks after the item was delivered
// (the Inbox is built for exactly that backlog-clearing pattern). Dividing
// "marks made this week" by "items delivered this week" gave rates over
// 300%. The honest denominator is every delivered item; the honest
// numerator is how many of those carry a mark — the same join calibration.js
// does. Tracked weekly, the level itself is the trend.
//
// It rides feed-radar's digest once a week as a section (markRateSection.js
// does the disk reads and the once-a-week gate); this module is the pure
// compute + render half, free of any fs or @opencode-ai/plugin import.

import { countMarksSince } from "./scorecard.js"
import { makeKeyFn } from "./seenStore.js"

const DAY_MS = 24 * 60 * 60 * 1000

// Whole-percent rate, or null when the store is empty (0/0 is not 0%).
const rate = (n, d) => (d > 0 ? Math.round((n / d) * 100) : null)
const showRate = (r) => (r === null ? "—" : `${r}%`)

// A key that is only field separators (every field empty) identifies
// nothing — drop it rather than let a blank row count as a delivered item.
const isBlankKey = (k) => k.replace(/\|/g, "") === ""

/**
 * @param {object} opts
 * @param {{name, seen?, keyFields?, seenKeys?, interested?, ignored?}[]} opts.radars
 *   Either give `seen` (the store array) + `keyFields` (for makeKeyFn), or a
 *   precomputed `seenKeys` iterable. `interested` / `ignored` are the mark maps.
 * @param {number} [opts.days=7]  trailing window for the "new marks" figure
 * @param {number} [opts.now]     epoch ms, injectable for tests
 */
export function buildMarkRateReport({ radars = [], days = 7, now = Date.now() } = {}) {
  const weekCutoff = now - days * DAY_MS

  const rows = radars.map((r) => {
    const interested = r.interested || {}
    const ignored = r.ignored || {}

    const keys = new Set()
    if (r.seenKeys) {
      for (const k of r.seenKeys) if (k && !isBlankKey(k)) keys.add(k)
    } else {
      const keyOf = makeKeyFn(r.keyFields || [])
      for (const item of r.seen || []) {
        const k = keyOf(item)
        if (k && !isBlankKey(k)) keys.add(k)
      }
    }

    let decided = 0
    for (const k of keys) {
      if (Object.hasOwn(interested, k) || Object.hasOwn(ignored, k)) decided++
    }

    const newMarks =
      countMarksSince(interested, weekCutoff) + countMarksSince(ignored, weekCutoff)

    return {
      name: r.name,
      delivered: keys.size,
      decided,
      rate: rate(decided, keys.size),
      newMarks,
    }
  })

  const fleet = rows.reduce(
    (a, r) => {
      a.delivered += r.delivered
      a.decided += r.decided
      a.newMarks += r.newMarks
      return a
    },
    { name: "fleet", delivered: 0, decided: 0, newMarks: 0 }
  )
  fleet.rate = rate(fleet.decided, fleet.delivered)

  const headline =
    `${showRate(fleet.rate)} of delivered items have a star/reject decision ` +
    `(${fleet.decided}/${fleet.delivered}). ` +
    `+${fleet.newMarks} in the last ${days} days.`

  return {
    headline,
    rows,
    fleet,
    line: `Fleet mark rate — ${headline}`,
    html: renderHtml(headline, rows, days),
    text: renderText(headline, rows, days),
  }
}

// No <h1>/<h2> — the digest owns those and validateDigestContent counts
// <h2> group headings. Mirrors researchDesk.js's section shape.
function renderHtml(headline, rows, days) {
  const body = rows
    .map(
      (r) =>
        `<tr>` +
        `<td style="padding:1px 12px 1px 0">${escapeText(r.name)}</td>` +
        `<td style="padding:1px 12px 1px 0;text-align:right">${showRate(r.rate)}</td>` +
        `<td style="padding:1px 12px 1px 0;text-align:right;color:#889">${r.decided}/${r.delivered}</td>` +
        `<td style="padding:1px 0;text-align:right;color:#889">+${r.newMarks} / ${days}d</td>` +
        `</tr>`
    )
    .join("")
  return (
    `<hr>` +
    `<h3 style="margin-bottom:2px">Fleet mark rate</h3>` +
    `<p style="color:#667;font-style:italic;margin-top:0">${escapeText(headline)}</p>` +
    `<table style="color:#556;font-size:13px;border-collapse:collapse">${body}</table>`
  )
}

function renderText(headline, rows, days) {
  const width = Math.max(0, ...rows.map((r) => r.name.length))
  const lines = rows.map((r) => {
    const frac = `(${r.decided}/${r.delivered})`
    return `  ${r.name.padEnd(width)}  ${showRate(r.rate).padStart(4)} ${frac.padStart(10)}   +${r.newMarks} / ${days}d`
  })
  return `\n—\nFleet mark rate — ${headline}\n${lines.join("\n")}\n`
}

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }
const escapeText = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c])
