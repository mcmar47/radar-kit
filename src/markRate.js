// The fleet mark-rate report: a weekly read on whether the feedback loop
// the roadmap is built on is actually closing. For each radar, and for the
// fleet as a whole, what fraction of delivered digest items got any
// star/reject decision — over the last 7 days, and cumulatively since the
// Continuum Inbox shipped (2026-08-30) as the trend anchor.
//
// This is FUTURE-PROJECTS.md project 7's "the one measurement worth taking
// now": not pick quality, just mark rate. "That single number, tracked
// weekly, is what tells you whether the whole feedback premise of this
// roadmap holds. It needs a one-line report, not a lab."
//
// It rides feed-radar's digest once a week as a section
// (markRateSection.js does the disk reads and the once-a-week gate); this
// module is the pure compute + render half, free of any fs or
// @opencode-ai/plugin import, exactly like scorecard.js — which it is the
// fleet-wide, mark-rate-shaped generalization of. Numerator and denominator
// come from the same two sources the digest footer scorecard already uses:
// interested.json + ignored.json for marks (counted by their { at }
// timestamp — a legacy bare `true` never counts), logs/digest-runs.json for
// delivered totals.

import { countMarksSince, sumDeliveredSince } from "./scorecard.js"

const DAY_MS = 24 * 60 * 60 * 1000
export const INBOX_SHIPPED_ISO = "2026-08-30T00:00:00Z"

// Whole-percent rate, or null when nothing was delivered (0/0 is not 0%).
function rate(marks, delivered) {
  return delivered > 0 ? Math.round((marks / delivered) * 100) : null
}

const showRate = (r) => (r === null ? "—" : `${r}%`)

/**
 * @param {object} opts
 * @param {{name:string, runs?:object[], interested?:object, ignored?:object}[]} opts.radars
 * @param {string} [opts.sinceIso]  the trend anchor, default the Inbox ship date
 * @param {number} [opts.days=7]    trailing window
 * @param {number} [opts.now]       epoch ms, injectable for tests
 * @returns {{headline:string, rows:object[], fleet:object, line:string, html:string, text:string}}
 */
export function buildMarkRateReport({
  radars = [],
  sinceIso = INBOX_SHIPPED_ISO,
  days = 7,
  now = Date.now(),
} = {}) {
  const weekCutoff = now - days * DAY_MS
  const parsedSince = Date.parse(sinceIso)
  const sinceCutoff = Number.isNaN(parsedSince) ? Date.parse(INBOX_SHIPPED_ISO) : parsedSince
  const sinceLabel = new Date(sinceCutoff).toISOString().slice(0, 10)

  const rows = radars.map((r) => {
    const marks7 =
      countMarksSince(r.interested, weekCutoff) + countMarksSince(r.ignored, weekCutoff)
    const delivered7 = sumDeliveredSince(r.runs, weekCutoff)
    const marksSince =
      countMarksSince(r.interested, sinceCutoff) + countMarksSince(r.ignored, sinceCutoff)
    const deliveredSince = sumDeliveredSince(r.runs, sinceCutoff)
    return {
      name: r.name,
      marks7,
      delivered7,
      rate7: rate(marks7, delivered7),
      marksSince,
      deliveredSince,
      rateSince: rate(marksSince, deliveredSince),
    }
  })

  const fleet = rows.reduce(
    (a, r) => {
      a.marks7 += r.marks7
      a.delivered7 += r.delivered7
      a.marksSince += r.marksSince
      a.deliveredSince += r.deliveredSince
      return a
    },
    { name: "fleet", marks7: 0, delivered7: 0, marksSince: 0, deliveredSince: 0 }
  )
  fleet.rate7 = rate(fleet.marks7, fleet.delivered7)
  fleet.rateSince = rate(fleet.marksSince, fleet.deliveredSince)

  const headline =
    `Last ${days} days: ${showRate(fleet.rate7)} of delivered items decided ` +
    `(${fleet.marks7}/${fleet.delivered7}). ` +
    `Since ${sinceLabel}: ${showRate(fleet.rateSince)} (${fleet.marksSince}/${fleet.deliveredSince}).`

  return {
    headline,
    rows,
    fleet,
    line: `Fleet mark rate — ${headline}`,
    html: renderHtml(headline, rows),
    text: renderText(headline, rows),
  }
}

// No <h1>/<h2> — the digest owns those and validateDigestContent counts
// <h2> group headings. Mirrors researchDesk.js's section shape.
function renderHtml(headline, rows) {
  const body = rows
    .map(
      (r) =>
        `<tr>` +
        `<td style="padding:1px 12px 1px 0">${escapeText(r.name)}</td>` +
        `<td style="padding:1px 12px 1px 0;text-align:right">${showRate(r.rate7)}</td>` +
        `<td style="padding:1px 12px 1px 0;text-align:right;color:#889">${r.marks7}/${r.delivered7}</td>` +
        `<td style="padding:1px 0;text-align:right;color:#889">since ${showRate(r.rateSince)}</td>` +
        `</tr>`
    )
    .join("")
  return (
    `<hr>` +
    `<h3 style="margin-bottom:2px">Fleet mark rate</h3>` +
    `<p style="color:#667;font-style:italic;margin-top:0">` +
    `${escapeText(headline)}</p>` +
    `<table style="color:#556;font-size:13px;border-collapse:collapse">${body}</table>`
  )
}

function renderText(headline, rows) {
  const width = Math.max(0, ...rows.map((r) => r.name.length))
  const lines = rows.map((r) => {
    const frac = `(${r.marks7}/${r.delivered7})`
    return `  ${r.name.padEnd(width)}  ${showRate(r.rate7).padStart(4)} ${frac.padStart(8)}   since ${showRate(r.rateSince).padStart(4)}`
  })
  return `\n—\nFleet mark rate — ${headline}\n${lines.join("\n")}\n`
}

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }
const escapeText = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c])
