// FUTURE-PROJECTS.md project 7's reader half: the analysis that was gated
// on ~50 timestamped marks landing in a trailing 30 days (cleared 2026-09,
// see markRate.js's shipped "mark rate" measurement — this is the next size
// up, not a replacement for it). This is the v1 cut: whole-store cohort
// rates with denominators, per-group (source/category/company/type)
// breakdowns, duplicate-key detection, and a staleness flag — not the full
// original 5-point spec. Time-to-mark is deliberately left out: only
// feed-radar's records carry a delivery timestamp (`sent`), so a fleet-wide
// figure would be built on three radars' worth of guesswork. Auto-drafted
// prompt/profile suggestions (point 5) are also left for a later pass — this
// module only measures, it does not recommend.
//
// Pure compute + render, free of fs and @opencode-ai/plugin, like
// scorecard.js and markRate.js — a caller (a script on the Pi, a test) does
// the disk reads and hands this module plain data.

import { makeKeyFn } from "./seenStore.js"
import { escapeHtml } from "./html.js"

const DAY_MS = 24 * 60 * 60 * 1000

const rate = (n, d) => (d > 0 ? Math.round((n / d) * 100) : null)
const showRate = (r) => (r === null ? "—" : `${r}%`)

/**
 * Per-radar quality stats: delivered/starred/rejected/unmarked, duplicate
 * keys, stale unmarked items, and an optional per-group breakdown.
 *
 * @param {object} opts
 * @param {string} opts.name
 * @param {object[]} opts.records        the seen-store array
 * @param {(string|{field,exact})[]} opts.keyFields  same shape as makeKeyFn/calibration.js
 * @param {object} opts.interested       mark store (key -> {at,via} | true)
 * @param {object} opts.ignored          mark store
 * @param {string} [opts.groupField]     record field to break down by, e.g. "source"
 * @param {string} [opts.groupLabel]     display label for that field, e.g. "Source"
 * @param {string} [opts.dateField]      record field holding a date relevant to staleness
 * @param {number} [opts.staleDays=30]   an unmarked item is stale once this field is
 *   this many days in the past — works for both a delivery date (feed-radar's `sent`)
 *   and an event/release/posting date, since a future date never exceeds the threshold
 * @param {number} [opts.minGroupDenominator=5]  suppress a group row with fewer
 *   decided (starred+rejected) items than this — a rate over 1/2 is noise, not signal
 * @param {number} [opts.now]
 */
export function buildRadarQuality({
  name,
  records = [],
  keyFields,
  interested = {},
  ignored = {},
  groupField,
  groupLabel,
  dateField,
  staleDays = 30,
  minGroupDenominator = 5,
  now = Date.now(),
} = {}) {
  if (typeof keyFields === "undefined") {
    throw new Error("buildRadarQuality: keyFields is required")
  }
  const keyOf = makeKeyFn(keyFields)

  // Group raw records by key first, so records sharing a key (duplicates)
  // are counted once for delivered/starred/rejected but still show up in
  // the duplicate count.
  const byKey = new Map()
  for (const record of records) {
    const key = keyOf(record)
    if (!key || key.replace(/\|/g, "") === "") continue
    if (!byKey.has(key)) byKey.set(key, [])
    byKey.get(key).push(record)
  }

  let starred = 0
  let rejected = 0
  let staleUnmarked = 0
  let duplicateItems = 0
  let duplicateExcess = 0
  const groups = new Map() // groupValue -> { total, starred, rejected }

  for (const [key, group] of byKey) {
    const first = group[0]
    if (group.length > 1) {
      duplicateItems++
      duplicateExcess += group.length - 1
    }

    const isStarred = Object.hasOwn(interested, key)
    const isRejected = !isStarred && Object.hasOwn(ignored, key)
    if (isStarred) starred++
    else if (isRejected) rejected++
    else if (dateField) {
      const t = Date.parse(first?.[dateField] ?? "")
      if (!Number.isNaN(t) && now - t > staleDays * DAY_MS) staleUnmarked++
    }

    if (groupField) {
      const label = String(first?.[groupField] ?? "").trim() || "(unknown)"
      if (!groups.has(label)) groups.set(label, { total: 0, starred: 0, rejected: 0 })
      const g = groups.get(label)
      g.total++
      if (isStarred) g.starred++
      else if (isRejected) g.rejected++
    }
  }

  const delivered = byKey.size
  const unmarked = delivered - starred - rejected

  const groupRows = [...groups.entries()]
    .map(([label, g]) => {
      const decided = g.starred + g.rejected
      return {
        label,
        total: g.total,
        starred: g.starred,
        rejected: g.rejected,
        decided,
        rate: rate(g.starred, decided),
        suppressed: decided < minGroupDenominator,
      }
    })
    .sort((a, b) => b.decided - a.decided || b.total - a.total)

  return {
    name,
    delivered,
    starred,
    rejected,
    unmarked,
    markRate: rate(starred + rejected, delivered),
    starRate: rate(starred, starred + rejected),
    duplicateItems,
    duplicateExcess,
    staleUnmarked,
    groupLabel: groupLabel ?? groupField ?? null,
    groups: groupRows,
  }
}

/**
 * Combine several `buildRadarQuality` results (or their raw inputs, one per
 * radar) into the fleet-wide report, and render it as a standalone HTML
 * page — this is a page of its own, not a digest section, so it renders a
 * full `<html>` document rather than a fragment.
 *
 * @param {object} opts
 * @param {object[]} opts.radars  either pre-built `buildRadarQuality()` results
 *   (each must carry a `name`) or raw inputs to that function — this
 *   normalizes by calling `buildRadarQuality` on anything with a `records` field
 * @param {number} [opts.now]
 */
export function buildQualityLabReport({ radars = [], now = Date.now() } = {}) {
  const built = radars.map((r) => (r.records ? buildRadarQuality({ ...r, now }) : r))

  const fleet = built.reduce(
    (a, r) => {
      a.delivered += r.delivered
      a.starred += r.starred
      a.rejected += r.rejected
      a.unmarked += r.unmarked
      a.duplicateItems += r.duplicateItems
      a.duplicateExcess += r.duplicateExcess
      a.staleUnmarked += r.staleUnmarked
      return a
    },
    { delivered: 0, starred: 0, rejected: 0, unmarked: 0, duplicateItems: 0, duplicateExcess: 0, staleUnmarked: 0 }
  )
  fleet.markRate = rate(fleet.starred + fleet.rejected, fleet.delivered)
  fleet.starRate = rate(fleet.starred, fleet.starred + fleet.rejected)

  return {
    radars: built,
    fleet,
    generatedAt: new Date(now).toISOString(),
    html: renderHtml(built, fleet, now),
  }
}

function renderRadarSection(r) {
  const groupRows = r.groups.length
    ? r.groups
        .map((g) => {
          const rateCell = g.suppressed
            ? `<span title="fewer than the minimum decided items — not enough evidence">—</span>`
            : showRate(g.rate)
          return (
            `<tr>` +
            `<td>${escapeHtml(g.label)}</td>` +
            `<td style="text-align:right">${g.total}</td>` +
            `<td style="text-align:right">${g.starred}</td>` +
            `<td style="text-align:right">${g.rejected}</td>` +
            `<td style="text-align:right">${rateCell} <span class="denom">(${g.decided})</span></td>` +
            `</tr>`
          )
        })
        .join("")
    : ""

  const groupTable = r.groups.length
    ? `<table>` +
      `<tr><th>${escapeHtml(r.groupLabel ?? "Group")}</th><th>Sent</th><th>★</th><th>✕</th><th>Star rate</th></tr>` +
      groupRows +
      `</table>`
    : `<p class="muted">No breakdown field configured for this radar.</p>`

  const flags = []
  if (r.duplicateItems > 0) {
    flags.push(`${r.duplicateItems} duplicate key${r.duplicateItems === 1 ? "" : "s"} (${r.duplicateExcess} excess record${r.duplicateExcess === 1 ? "" : "s"})`)
  }
  if (r.staleUnmarked > 0) {
    flags.push(`${r.staleUnmarked} stale unmarked`)
  }
  const flagsLine = flags.length
    ? `<p class="flag">${flags.map(escapeHtml).join(" · ")}</p>`
    : ""

  return (
    `<section>` +
    `<h2>${escapeHtml(r.name)}</h2>` +
    `<p class="stats">${r.delivered} delivered · ${r.starred} starred · ${r.rejected} rejected · ` +
    `${r.unmarked} unmarked · mark rate ${showRate(r.markRate)} <span class="denom">(${r.starred + r.rejected}/${r.delivered})</span></p>` +
    flagsLine +
    groupTable +
    `</section>`
  )
}

function renderHtml(radars, fleet, now) {
  const sections = radars.map(renderRadarSection).join("\n")
  const generated = new Date(now).toISOString().slice(0, 16).replace("T", " ") + " UTC"
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Radar Quality Lab</title>
<style>
  body { font-family: -apple-system, sans-serif; max-width: 860px; margin: 40px auto; padding: 0 16px; color: #223; }
  h1 { font-size: 20px; }
  h2 { font-size: 16px; margin-top: 40px; border-bottom: 1px solid #ddd; padding-bottom: 4px; }
  .meta { color: #889; font-size: 13px; }
  .stats { font-size: 14px; }
  .muted { color: #889; font-size: 13px; }
  .flag { color: #a55; font-size: 13px; }
  .denom { color: #889; }
  table { border-collapse: collapse; font-size: 13px; margin-top: 8px; width: 100%; }
  th, td { padding: 3px 10px 3px 0; text-align: left; }
  th { color: #667; font-weight: 600; border-bottom: 1px solid #ddd; }
</style>
</head>
<body>
<h1>Radar Quality Lab</h1>
<p class="meta">Generated ${escapeHtml(generated)} · fleet: ${fleet.delivered} delivered, mark rate ${showRate(fleet.markRate)} <span class="denom">(${fleet.starred + fleet.rejected}/${fleet.delivered})</span>, star rate ${showRate(fleet.starRate)} among decided items</p>
${sections}
</body>
</html>
`
}
