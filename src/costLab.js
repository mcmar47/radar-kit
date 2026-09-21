// Fleet Cost Lab — per-invocation OpenRouter spend for the scheduled
// agents, charted over time. Scoped deliberately to *scheduled* spend only:
// each agent's own run-log file (digest-runs.json / recognize-runs.json,
// written by scorecard.js's appendRun + recordRunCost, or run-cost.js's
// wrapper around a plain vision script) already carries one costUsd per
// run. That figure has only ever been shown as a single "last run" line in
// a digest footer (buildScorecard) — this module is the first thing that
// sums and charts it, across every agent in the fleet at once.
//
// Pure compute + render, free of fs and @opencode-ai/plugin, like
// qualityLab.js and scorecard.js — a caller (a script on the Pi, a test)
// does the disk reads and hands this module each agent's raw run-log array.
//
// Buckets are rolling 7-day windows ending "now", not calendar weeks — the
// fleet mixes daily (event-watch, feed-radar), weekly (job-radar,
// release-radar, serendipity-radar), monthly-ish (resale-radar) and
// on-demand (research-desk, shelf-recognize) cadences, so calendar-week
// alignment buys nothing and a plain trailing window is simpler to reason
// about and to test.

import { escapeHtml } from "./html.js"
import { sumCostSince } from "./scorecard.js"

const DAY_MS = 24 * 60 * 60 * 1000
const WEEK_MS = 7 * DAY_MS

// The chart's trailing window auto-sizes to how far back the data actually
// goes, clamped to this range — a fleet a month old shouldn't render 13
// mostly-empty weeks, and a fleet with a year of history shouldn't render
// an unreadable 50-bar chart. MIN_WEEKS keeps a very young fleet's chart
// from looking like one or two bars adrift in empty space.
const MIN_WEEKS = 4
const MAX_WEEKS = 13

// A 30-day projection needs at least this many days of real history before
// it's worth showing — below it, one weekly/monthly agent's single run can
// swing a naive daily rate wildly (see projected30d below).
const MIN_PROJECTION_DAYS = 7

// The earliest costed run across every agent, epoch ms or null if none.
// Only looks at raw `{ runs }` inputs — a caller passing pre-built
// buildAgentCost() results already picked its own window and has no raw
// `runs` left to scan.
function earliestCostedRunMs(agents) {
  let earliest = null
  for (const a of agents) {
    if (a.buckets) continue
    for (const r of a.runs || []) {
      if (typeof r?.costUsd !== "number") continue
      const t = Date.parse(r.at ?? "")
      if (!Number.isNaN(t) && (earliest === null || t < earliest)) earliest = t
    }
  }
  return earliest
}

// The earliest costed run, in whole trailing weeks (+1 so that run isn't
// flush against the chart's left edge), clamped to [MIN_WEEKS, MAX_WEEKS].
function autoWeeks(agents, now) {
  const earliest = earliestCostedRunMs(agents)
  if (earliest === null) return MIN_WEEKS
  const ageWeeks = Math.ceil((now - earliest) / WEEK_MS) + 1
  return Math.min(MAX_WEEKS, Math.max(MIN_WEEKS, ageWeeks))
}

/**
 * A rough 30-day spend projection for a fleet that doesn't have 30 real
 * days of history yet: linear extrapolation of the logged total over the
 * whole history window (not just a trailing few days) — with cadences from
 * daily to monthly, the full history is more likely to have caught at
 * least one run from every agent than a short recent slice would. Returns
 * null once real history reaches 30 days (the actual last30d figure is
 * better by then, so this shouldn't linger) or before MIN_PROJECTION_DAYS
 * of history exists (too little data for even a rough rate).
 *
 * @param {number} allLoggedUsd  fleet.allLogged
 * @param {number} historyDays
 */
function projectMonthlySpend(allLoggedUsd, historyDays) {
  if (historyDays < MIN_PROJECTION_DAYS || historyDays >= 30) return null
  return (allLoggedUsd / historyDays) * 30
}

// The categorical palette's 8 slots, in fixed order (dataviz skill,
// references/palette.md) — validated for adjacent-pair CVD/contrast on
// stacked bars specifically. Slot order encodes identity and must stay
// fixed across regenerations regardless of which agents have spend in the
// current window, so assignment is by AGENT order, not by rank/volume.
const SLOTS = [
  { light: "#2a78d6", dark: "#3987e5" }, // 1 blue
  { light: "#eb6834", dark: "#d95926" }, // 2 orange
  { light: "#1baf7a", dark: "#199e70" }, // 3 aqua
  { light: "#eda100", dark: "#c98500" }, // 4 yellow
  { light: "#e87ba4", dark: "#d55181" }, // 5 magenta
  { light: "#008300", dark: "#008300" }, // 6 green
  { light: "#4a3aa7", dark: "#9085e9" }, // 7 violet
  { light: "#e34948", dark: "#e66767" }, // 8 red
]

function formatUsd(usd) {
  if (typeof usd !== "number" || !Number.isFinite(usd)) return "—"
  if (usd === 0) return "$0.00"
  if (usd < 0.01) return "<$0.01"
  return `$${usd.toFixed(2)}`
}

// A "nice" axis max at or above `max`, so gridline labels are round numbers
// (0 / 0.25 / 0.50 / ...) rather than whatever the data happens to peak at.
function niceMax(max) {
  if (max <= 0) return 1
  const steps = [1, 2, 2.5, 5]
  let mag = 10 ** Math.floor(Math.log10(max))
  for (;;) {
    for (const s of steps) {
      const candidate = s * mag
      if (candidate >= max) return candidate
    }
    mag *= 10
  }
}

/**
 * One agent's spend stats + weekly bucket series.
 *
 * @param {object} opts
 * @param {string} opts.name
 * @param {object[]} opts.runs   raw run-log array: [{ at, count, model?, costUsd? }]
 * @param {number} opts.weeks    how many trailing 7-day buckets to build
 * @param {number} opts.now
 */
export function buildAgentCost({ name, runs = [], weeks = 13, now = Date.now() } = {}) {
  const costedRuns = (runs || []).filter((r) => typeof r?.costUsd === "number")
  const runCount = costedRuns.length

  const buckets = []
  for (let i = weeks - 1; i >= 0; i--) {
    const end = now - i * WEEK_MS
    const start = end - WEEK_MS
    let sum = 0
    for (const r of costedRuns) {
      const t = Date.parse(r.at ?? "")
      if (!Number.isNaN(t) && t >= start && t < end) sum += r.costUsd
    }
    buckets.push(sum)
  }

  const last7d = sumCostSince(runs, now - WEEK_MS)
  const last30d = sumCostSince(runs, now - 30 * DAY_MS)
  const allLogged = sumCostSince(runs, -Infinity)
  const totalCost = costedRuns.reduce((a, r) => a + r.costUsd, 0)
  const avgPerRun = runCount > 0 ? totalCost / runCount : null

  let last = null
  for (const r of runs || []) {
    if (typeof r?.costUsd !== "number") continue
    if (!last || Date.parse(r.at ?? "") > Date.parse(last.at ?? "")) last = r
  }

  return {
    name,
    buckets,
    last7d,
    last30d,
    allLogged,
    runCount,
    avgPerRun,
    lastRunAt: last?.at ?? null,
    lastRunCost: last?.costUsd ?? null,
    lastModel: last?.model ?? null,
  }
}

/**
 * Combine several agents' cost stats into the fleet report and render it as
 * a standalone static HTML page (own <html> document). Unlike qualityLab.js's
 * page, this one ships a small inline hover-tooltip script for the chart —
 * still fully pre-rendered and self-contained (no fetch/XHR, no external
 * script, no build step), just not JS-free.
 *
 * @param {object} opts
 * @param {object[]} opts.agents  either raw `{ name, runs }` (normalized via
 *   buildAgentCost) or pre-built buildAgentCost() results (must carry `buckets`)
 * @param {number} [opts.weeks]  trailing window; omit to auto-size to the data
 *   (earliest costed run, clamped to [4, 13] weeks) — see autoWeeks
 * @param {number} [opts.now]
 */
export function buildCostLabReport({ agents = [], weeks, now = Date.now() } = {}) {
  const effectiveWeeks = weeks ?? autoWeeks(agents, now)
  const built = agents.map((a) =>
    a.buckets ? a : buildAgentCost({ ...a, weeks: effectiveWeeks, now })
  )

  const fleet = built.reduce(
    (acc, a) => {
      acc.last7d += a.last7d
      acc.last30d += a.last30d
      acc.allLogged += a.allLogged
      acc.runCount += a.runCount
      return acc
    },
    { last7d: 0, last30d: 0, allLogged: 0, runCount: 0 }
  )
  fleet.buckets = Array.from({ length: effectiveWeeks }, (_, i) =>
    built.reduce((sum, a) => sum + (a.buckets[i] || 0), 0)
  )

  const earliest = earliestCostedRunMs(agents)
  const historyDays = earliest === null ? 0 : Math.max(1, Math.round((now - earliest) / DAY_MS))
  const projected30d = projectMonthlySpend(fleet.allLogged, historyDays)

  return {
    agents: built,
    fleet,
    historyDays,
    projected30d,
    generatedAt: new Date(now).toISOString(),
    html: renderHtml(built, fleet, effectiveWeeks, now, { historyDays, projected30d }),
  }
}

// A rounded-top rect path — 4px radius on the two top corners only, square
// at the base. Used for the topmost non-zero segment of a stacked bar (the
// mark's one outward-facing end); every other segment is a plain <rect>.
function roundedTopRectPath(x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h)
  return (
    `M${x},${y + h} ` +
    `V${y + rr} ` +
    `Q${x},${y} ${x + rr},${y} ` +
    `H${x + w - rr} ` +
    `Q${x + w},${y} ${x + w},${y + rr} ` +
    `V${y + h} ` +
    `Z`
  )
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

// "Sep 8–14" (same month) or "Sep 29 – Oct 5" (spans a month boundary), for
// the tooltip header — endMsExclusive is the bucket's exclusive end, so the
// displayed last day is one day earlier.
function formatWeekRange(startMs, endMsExclusive) {
  const start = new Date(startMs)
  const end = new Date(endMsExclusive - DAY_MS)
  const sameMonth =
    start.getUTCMonth() === end.getUTCMonth() && start.getUTCFullYear() === end.getUTCFullYear()
  return sameMonth
    ? `${MONTHS[start.getUTCMonth()]} ${start.getUTCDate()}–${end.getUTCDate()}`
    : `${MONTHS[start.getUTCMonth()]} ${start.getUTCDate()} – ${MONTHS[end.getUTCMonth()]} ${end.getUTCDate()}`
}

function renderChart(built, fleet, weeks, now) {
  const W = 820
  const H = 260
  const padL = 46
  const padB = 22
  const padT = 10
  const plotW = W - padL - 8
  const plotH = H - padT - padB

  const bandW = plotW / weeks
  const barW = Math.min(24, bandW - 4)
  const gap = 2 // surface-color gap between stacked segments

  const yMax = niceMax(Math.max(...fleet.buckets, 0.01))
  const yOf = (usd) => padT + plotH - (usd / yMax) * plotH

  // Gridlines at 0 / 1/4 / 1/2 / 3/4 / max, rounded to whole cents.
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(yMax * f * 100) / 100)
  const gridlines = ticks
    .map((t) => {
      const y = yOf(t)
      return (
        `<line x1="${padL}" x2="${W - 8}" y1="${y}" y2="${y}" class="grid"/>` +
        `<text x="${padL - 6}" y="${y + 3}" class="tick" text-anchor="end">${escapeHtml(formatUsd(t))}</text>`
      )
    })
    .join("")

  // Bars carry no pointer events of their own — the invisible per-column
  // hit rect below is the hit target (dataviz skill: "the mark is the hit
  // target... bigger than the mark"), and it answers "which key is this"
  // for the whole column at once ("one tooltip, every series") rather than
  // requiring the pointer to land on one thin segment.
  const bars = []
  const hits = []
  for (let i = 0; i < weeks; i++) {
    const bandX = padL + i * bandW
    const x = bandX + (bandW - barW) / 2
    let yCursor = padT + plotH // bottom, grows upward
    const segsForBar = built
      .map((a, ai) => ({ a, ai, v: a.buckets[i] || 0 }))
      .filter((s) => s.v > 0)
    segsForBar.forEach((s, si) => {
      const segH = (s.v / yMax) * plotH
      const top = yCursor - segH
      const isTopmost = si === segsForBar.length - 1
      const drawH = Math.max(0, segH - (isTopmost ? 0 : gap))
      const fill = `var(--series-${s.ai + 1})`
      if (isTopmost) {
        bars.push(`<path d="${roundedTopRectPath(x, top, barW, drawH, 4)}" fill="${fill}" pointer-events="none"/>`)
      } else {
        bars.push(
          `<rect x="${x}" y="${top + gap}" width="${barW}" height="${Math.max(0, drawH - gap)}" fill="${fill}" pointer-events="none"/>`
        )
      }
      yCursor = top
    })

    const end = now - (weeks - 1 - i) * WEEK_MS
    const start = end - WEEK_MS
    const weekLabel = formatWeekRange(start, end)
    const total = segsForBar.reduce((sum, s) => sum + s.v, 0)
    const rows = [...segsForBar]
      .sort((a, b) => b.v - a.v)
      .map((s) => ({ name: s.a.name, amount: formatUsd(s.v), color: `var(--series-${s.ai + 1})` }))
    const tooltip = escapeHtml(JSON.stringify({ label: weekLabel, total: formatUsd(total), rows }))
    const summary =
      rows.length > 0
        ? `${weekLabel}: total ${formatUsd(total)} — ${rows.map((r) => `${r.name} ${r.amount}`).join(", ")}`
        : `${weekLabel}: no spend logged`
    hits.push(
      `<rect class="hit" x="${bandX}" y="${padT}" width="${bandW}" height="${plotH}" ` +
        `tabindex="0" role="img" aria-label="${escapeHtml(summary)}" data-tooltip="${tooltip}">` +
        `<title>${escapeHtml(summary)}</title></rect>`
    )
  }

  // X-axis labels: every bucket when there's room (a short, auto-sized
  // window), otherwise a tick every 4th bucket (roughly monthly) plus "now"
  // on the last, so a long window doesn't crowd 820px with date labels.
  const labelEvery = weeks <= 7 ? 1 : 4
  const xLabels = []
  for (let i = 0; i < weeks; i++) {
    if (i % labelEvery !== 0 && i !== weeks - 1) continue
    const end = now - (weeks - 1 - i) * WEEK_MS
    const label = i === weeks - 1 ? "now" : new Date(end).toISOString().slice(0, 10)
    const bandX = padL + i * bandW
    xLabels.push(
      `<text x="${bandX + bandW / 2}" y="${H - 4}" class="tick" text-anchor="middle">${escapeHtml(label)}</text>`
    )
  }

  return (
    `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Weekly OpenRouter spend by agent, trailing ${weeks} weeks">` +
    gridlines +
    bars.join("") +
    hits.join("") +
    xLabels.join("") +
    `</svg>`
  )
}

function legend(built) {
  return (
    `<div class="legend">` +
    built
      .map(
        (a, i) =>
          `<span class="legend-item"><span class="swatch" style="background:var(--series-${i + 1})"></span>${escapeHtml(a.name)}</span>`
      )
      .join("") +
    `</div>`
  )
}

function statTile(value, label, denom, estimate) {
  return (
    `<div class="stat${estimate ? " estimate" : ""}">` +
    `<div class="stat-value">${escapeHtml(String(value))}</div>` +
    `<div class="stat-label">${escapeHtml(label)}${denom ? ` <span class="denom">${escapeHtml(denom)}</span>` : ""}</div>` +
    `</div>`
  )
}

function agentRow(a) {
  const lastAt = a.lastRunAt ? a.lastRunAt.slice(0, 10) : "—"
  return (
    `<tr>` +
    `<td class="agent-label">${escapeHtml(a.name)}</td>` +
    `<td class="num">${a.runCount}</td>` +
    `<td class="num">${escapeHtml(formatUsd(a.allLogged))}</td>` +
    `<td class="num">${escapeHtml(formatUsd(a.avgPerRun))}</td>` +
    `<td class="num">${escapeHtml(formatUsd(a.lastRunCost))} <span class="denom">${escapeHtml(lastAt)}</span></td>` +
    `<td class="model">${a.lastModel ? escapeHtml(a.lastModel.split("/").slice(-1)[0]) : "—"}</td>` +
    `</tr>`
  )
}

function renderHtml(built, fleet, weeks, now, projection) {
  const { historyDays, projected30d } = projection ?? {}
  const generated = new Date(now).toISOString().slice(0, 16).replace("T", " ") + " UTC"
  const seriesVars = SLOTS.map(
    (s, i) => `--series-${i + 1}: ${s.light};`
  ).join(" ")
  const seriesVarsDark = SLOTS.map(
    (s, i) => `--series-${i + 1}: ${s.dark};`
  ).join(" ")

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Fleet Cost Lab</title>
<style>
  :root {
    --bg: #f7f7f8; --panel: #fff; --border: #e2e2e6;
    --text: #1c1c1f; --muted: #85858c; --grid: #e2e2e6;
    ${seriesVars}
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #16161a; --panel: #202027; --border: #33333c;
      --text: #e9e9ec; --muted: #9a9aa2; --grid: #33333c;
      ${seriesVarsDark}
    }
  }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    max-width: 900px; margin: 0 auto; padding: 32px 16px 64px;
    background: var(--bg); color: var(--text);
  }
  h1 { font-size: 22px; margin: 0 0 2px; }
  h2 { font-size: 15px; margin: 24px 0 10px; }
  .meta { color: var(--muted); font-size: 13px; margin: 0 0 24px; }
  .meta.small { font-size: 12px; margin: 0 0 24px; max-width: 640px; }
  .stats-row { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 10px; }
  .stat {
    background: var(--panel); border: 1px solid var(--border); border-radius: 10px;
    padding: 10px 16px; min-width: 130px; flex: 1 1 130px;
  }
  .stat.estimate { border-style: dashed; }
  .stat-value { font-size: 22px; font-weight: 600; line-height: 1.2; }
  .stat-label { color: var(--muted); font-size: 12px; margin-top: 2px; }
  .denom { color: var(--muted); font-weight: 400; }
  .card {
    background: var(--panel); border: 1px solid var(--border); border-radius: 10px;
    padding: 16px 18px 8px; margin-bottom: 20px;
  }
  svg { width: 100%; height: auto; display: block; overflow: visible; }
  .grid { stroke: var(--grid); stroke-width: 1; }
  .tick { fill: var(--muted); font-size: 10px; }
  .hit { fill: transparent; cursor: pointer; }
  .hit:hover, .hit:focus-visible { fill: var(--grid); fill-opacity: .5; }
  .hit:focus-visible { outline: 1px solid var(--muted); outline-offset: -1px; }
  .legend { display: flex; flex-wrap: wrap; gap: 10px 16px; margin: 10px 2px 2px; }
  .legend-item { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); }
  .swatch { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
  .cl-tooltip {
    position: fixed; z-index: 10; pointer-events: none;
    background: var(--panel); border: 1px solid var(--border); border-radius: 8px;
    padding: 8px 10px; font-size: 12px; box-shadow: 0 4px 16px rgba(0,0,0,.18);
    max-width: 240px;
  }
  .cl-tooltip[hidden] { display: none; }
  .cl-tooltip-header { font-weight: 600; color: var(--text); margin-bottom: 4px; white-space: nowrap; }
  .cl-tooltip-row { display: flex; align-items: center; gap: 6px; padding: 1px 0; }
  .cl-tooltip-key { width: 8px; height: 8px; border-radius: 2px; flex: none; }
  .cl-tooltip-name { color: var(--muted); flex: 1; margin-right: 8px; }
  .cl-tooltip-amt { color: var(--text); font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
  table { border-collapse: collapse; font-size: 13px; width: 100%; }
  th, td { padding: 6px 10px 6px 0; text-align: left; vertical-align: middle; }
  th {
    color: var(--muted); font-weight: 600; font-size: 11px; text-transform: uppercase;
    letter-spacing: .03em; border-bottom: 1px solid var(--border); padding-bottom: 6px;
  }
  td.num, th.num, td.model, th:not(:first-child) { text-align: right; }
  td.agent-label { font-weight: 500; }
  tbody tr + tr td { border-top: 1px solid var(--border); }
</style>
</head>
<body>
<h1>Fleet Cost Lab</h1>
<p class="meta">Generated ${escapeHtml(generated)} — scheduled-process OpenRouter spend only, never ad-hoc CLI use</p>
<div class="stats-row">
${statTile(formatUsd(fleet.last7d), "Last 7 days")}
${statTile(formatUsd(fleet.last30d), "Last 30 days")}
${statTile(formatUsd(fleet.allLogged), "Logged all-time", `${fleet.runCount} runs`)}
${typeof projected30d === "number" ? statTile(`~${formatUsd(projected30d)}`, "Projected 30-day", `from ${historyDays}d`, true) : ""}
</div>
${
  typeof projected30d === "number"
    ? `<p class="meta small">Projected 30-day extrapolates the ${escapeHtml(formatUsd(fleet.allLogged))} logged so far across ${historyDays} day${historyDays === 1 ? "" : "s"} of history — a rough linear estimate, not a bill. Replaced by the real Last 30 days figure once that much history exists.</p>`
    : ""
}
<div class="card">
<h2>Weekly spend by agent, trailing ${weeks} weeks</h2>
${renderChart(built, fleet, weeks, now)}
${legend(built)}
</div>
<div class="card">
<table>
<tr><th>Agent</th><th class="num">Runs</th><th class="num">Total</th><th class="num">Avg/run</th><th class="num">Last run</th><th class="model">Model</th></tr>
${built.map(agentRow).join("")}
</table>
</div>
<div id="clTooltip" class="cl-tooltip" role="tooltip" hidden></div>
<script>
(function () {
  var tip = document.getElementById("clTooltip");
  function render(data) {
    tip.textContent = "";
    var header = document.createElement("div");
    header.className = "cl-tooltip-header";
    header.textContent = data.label + " · " + data.total;
    tip.appendChild(header);
    data.rows.forEach(function (r) {
      var row = document.createElement("div");
      row.className = "cl-tooltip-row";
      var key = document.createElement("span");
      key.className = "cl-tooltip-key";
      key.style.background = r.color;
      var name = document.createElement("span");
      name.className = "cl-tooltip-name";
      name.textContent = r.name;
      var amt = document.createElement("span");
      amt.className = "cl-tooltip-amt";
      amt.textContent = r.amount;
      row.appendChild(key);
      row.appendChild(name);
      row.appendChild(amt);
      tip.appendChild(row);
    });
    if (data.rows.length === 0) {
      var none = document.createElement("div");
      none.className = "cl-tooltip-row cl-tooltip-name";
      none.textContent = "No spend logged this week";
      tip.appendChild(none);
    }
  }
  function position(x, y) {
    var pad = 14;
    tip.style.left = "0px";
    tip.style.top = "0px";
    var tw = tip.offsetWidth, th = tip.offsetHeight;
    var left = x + pad, top = y + pad;
    if (left + tw > window.innerWidth - 8) left = x - tw - pad;
    if (top + th > window.innerHeight - 8) top = y - th - pad;
    tip.style.left = Math.max(8, left) + "px";
    tip.style.top = Math.max(8, top) + "px";
  }
  function show(el, x, y) {
    var data;
    try {
      data = JSON.parse(el.getAttribute("data-tooltip"));
    } catch (err) {
      return;
    }
    render(data);
    tip.hidden = false;
    position(x, y);
  }
  function hide() {
    tip.hidden = true;
  }
  var hits = document.querySelectorAll(".hit");
  for (var i = 0; i < hits.length; i++) {
    (function (el) {
      el.addEventListener("pointermove", function (e) {
        show(el, e.clientX, e.clientY);
      });
      el.addEventListener("pointerdown", function (e) {
        show(el, e.clientX, e.clientY);
      });
      el.addEventListener("pointerleave", hide);
      el.addEventListener("focus", function () {
        var r = el.getBoundingClientRect();
        show(el, r.left + r.width / 2, r.top);
      });
      el.addEventListener("blur", hide);
    })(hits[i]);
  }
})();
</script>
</body>
</html>
`
}
