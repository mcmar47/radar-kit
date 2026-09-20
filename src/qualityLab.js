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
        unmarked: g.total - g.starred - g.rejected,
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

// A thin 100%-stacked composition bar: starred (good) / rejected (danger) /
// unmarked (neutral track), by flex-grow rather than computed percentages
// so rounding can never leave a sliver of unaccounted width. Bar *length*
// (vs. the track) additionally encodes this group's volume relative to the
// busiest group in the same radar, so a glance shows both "how much" and
// "how it went" — a zero-count segment is omitted outright rather than
// rendered as a zero-width flex item.
function renderBar(g, maxTotal) {
  const seg = (n, cls) => (n > 0 ? `<span class="seg ${cls}" style="flex-grow:${n}"></span>` : "")
  const widthPct = Math.max(8, Math.round((g.total / maxTotal) * 100))
  const title = `${g.starred} starred · ${g.rejected} rejected · ${g.unmarked} unmarked (${g.total} sent)`
  return (
    `<div class="bar-track" style="width:${widthPct}%" title="${escapeHtml(title)}">` +
    seg(g.starred, "star") +
    seg(g.rejected, "reject") +
    seg(g.unmarked, "unmarked") +
    `</div>`
  )
}

function renderRadarSection(r) {
  // A group with zero decided items has nothing to say yet — rendering a
  // row of dashes for it is the "horoscope" the spec warns against, and on
  // a long-tail radar (feed-radar's 50+ sources) it can be most of the
  // table. Collapse those into one line instead of one row each.
  const evidenced = r.groups.filter((g) => g.decided > 0)
  const noEvidence = r.groups.filter((g) => g.decided === 0)
  const maxTotal = Math.max(1, ...evidenced.map((g) => g.total))

  const groupRows = evidenced
    .map((g) => {
      const rateCell = g.suppressed
        ? `<span title="fewer than the minimum decided items — not enough evidence">—</span>`
        : showRate(g.rate)
      return (
        `<tr class="${g.suppressed ? "thin-evidence" : ""}">` +
        `<td class="group-label" title="${escapeHtml(g.label)}">${escapeHtml(g.label)}</td>` +
        `<td class="bar-cell">${renderBar(g, maxTotal)}</td>` +
        `<td class="rate-cell">${rateCell} <span class="denom">(${g.decided})</span></td>` +
        `</tr>`
      )
    })
    .join("")

  const noEvidenceLine = noEvidence.length
    ? `<p class="muted small">+${noEvidence.length} more ${escapeHtml((r.groupLabel ?? "group").toLowerCase())}${noEvidence.length === 1 ? "" : "s"} ` +
      `with no star/reject decisions yet (${noEvidence.reduce((n, g) => n + g.total, 0)} sent), omitted.</p>`
    : ""

  const groupTable = r.groups.length
    ? `<table>` +
      `<tr><th>${escapeHtml(r.groupLabel ?? "Group")}</th><th>Starred · rejected · unmarked</th><th>Star rate</th></tr>` +
      groupRows +
      `</table>` +
      noEvidenceLine
    : `<p class="muted small">No breakdown field configured for this radar.</p>`

  const flags = []
  if (r.duplicateItems > 0) {
    flags.push(`${r.duplicateItems} duplicate key${r.duplicateItems === 1 ? "" : "s"} (${r.duplicateExcess} excess record${r.duplicateExcess === 1 ? "" : "s"})`)
  }
  if (r.staleUnmarked > 0) {
    flags.push(`${r.staleUnmarked} stale unmarked`)
  }
  const flagsLine = flags.length
    ? `<p class="pills">${flags.map((f) => `<span class="pill warn">${escapeHtml(f)}</span>`).join(" ")}</p>`
    : ""

  return (
    `<section class="card">` +
    `<h2>${escapeHtml(r.name)}</h2>` +
    `<p class="stats">${r.delivered} delivered · <span class="good">${r.starred} starred</span> · ` +
    `<span class="danger">${r.rejected} rejected</span> · ${r.unmarked} unmarked · mark rate ` +
    `<strong>${showRate(r.markRate)}</strong> <span class="denom">(${r.starred + r.rejected}/${r.delivered})</span></p>` +
    flagsLine +
    groupTable +
    `</section>`
  )
}

function statTile(value, label, denom) {
  return (
    `<div class="stat">` +
    `<div class="stat-value">${escapeHtml(String(value))}</div>` +
    `<div class="stat-label">${escapeHtml(label)}${denom ? ` <span class="denom">${escapeHtml(denom)}</span>` : ""}</div>` +
    `</div>`
  )
}

function renderHtml(radars, fleet, now) {
  const sections = radars.map(renderRadarSection).join("\n")
  const generated = new Date(now).toISOString().slice(0, 16).replace("T", " ") + " UTC"
  const fleetFlags = fleet.duplicateItems + fleet.staleUnmarked
  const flagTile = fleetFlags > 0 ? statTile(fleetFlags, "Flagged", "duplicates + stale") : ""

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Radar Quality Lab</title>
<style>
  :root {
    --bg: #f7f7f8; --panel: #fff; --border: #e2e2e6;
    --text: #1c1c1f; --muted: #85858c; --track: #ececed;
    --good: #1a7f37; --danger: #b3261e; --warn: #a2760a; --warn-bg: #fff4d6;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #16161a; --panel: #202027; --border: #33333c;
      --text: #e9e9ec; --muted: #9a9aa2; --track: #2a2a30;
      --good: #6fd08c; --danger: #f2867d; --warn: #e6c34d; --warn-bg: #2c2717;
    }
  }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    max-width: 900px; margin: 0 auto; padding: 32px 16px 64px;
    background: var(--bg); color: var(--text);
  }
  h1 { font-size: 22px; margin: 0 0 2px; }
  h2 { font-size: 15px; margin: 0 0 10px; }
  .meta { color: var(--muted); font-size: 13px; margin: 0 0 24px; }
  .stats-row { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 28px; }
  .stat {
    background: var(--panel); border: 1px solid var(--border); border-radius: 10px;
    padding: 10px 16px; min-width: 130px; flex: 1 1 130px;
  }
  .stat-value { font-size: 22px; font-weight: 600; line-height: 1.2; }
  .stat-label { color: var(--muted); font-size: 12px; margin-top: 2px; }
  .card {
    background: var(--panel); border: 1px solid var(--border); border-radius: 10px;
    padding: 16px 18px; margin-bottom: 16px;
  }
  .stats { font-size: 13px; margin: 0 0 8px; }
  .good { color: var(--good); font-weight: 600; }
  .danger { color: var(--danger); font-weight: 600; }
  .muted { color: var(--muted); }
  .small { font-size: 12px; }
  .denom { color: var(--muted); font-weight: 400; }
  .pills { margin: 0 0 10px; }
  .pill {
    display: inline-block; font-size: 12px; padding: 2px 9px; border-radius: 999px;
    background: var(--warn-bg); color: var(--warn); margin-right: 6px;
  }
  table { border-collapse: collapse; font-size: 13px; width: 100%; table-layout: fixed; }
  th, td { padding: 4px 8px 4px 0; text-align: left; vertical-align: middle; }
  th {
    color: var(--muted); font-weight: 600; font-size: 11px; text-transform: uppercase;
    letter-spacing: .03em; border-bottom: 1px solid var(--border); padding-bottom: 6px;
  }
  th:first-child, td.group-label { width: 34%; }
  th:last-child, td.rate-cell { width: 90px; text-align: right; white-space: nowrap; }
  td.group-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  td.bar-cell { padding-top: 6px; padding-bottom: 6px; }
  .bar-track {
    display: flex; gap: 2px; height: 14px; border-radius: 4px; overflow: hidden;
    background: var(--track);
  }
  tr.thin-evidence .bar-track { opacity: .5; }
  .seg { display: block; height: 100%; }
  .seg.star { background: var(--good); }
  .seg.reject { background: var(--danger); }
  .seg.unmarked { background: var(--track); }
  @media (max-width: 480px) {
    th:first-child, td.group-label { width: 30%; }
    th:last-child, td.rate-cell { width: 70px; }
  }
</style>
</head>
<body>
<h1>Radar Quality Lab</h1>
<p class="meta">Generated ${escapeHtml(generated)}</p>
<div class="stats-row">
${statTile(fleet.delivered, "Delivered")}
${statTile(showRate(fleet.markRate), "Mark rate", `${fleet.starred + fleet.rejected}/${fleet.delivered}`)}
${statTile(showRate(fleet.starRate), "Star rate", `${fleet.starred}/${fleet.starred + fleet.rejected}`)}
${flagTile}
</div>
${sections}
</body>
</html>
`
}
