// Delivery glue for the Serendipity Radar (the `serendipity-radar` repo,
// FUTURE-PROJECTS.md #4): read its `data/discoveries.json` and, if there is
// a fresh, undelivered batch of discoveries waiting, return it as a digest
// section for feed-radar's render/send tools to fold in.
//
// Dependency-free on purpose — same discipline as researchDesk.js.
//
// Store shape is a FLAT ARRAY of discovery records, each carrying its own
// batchId/generatedAt/deliveredAt — deliberately NOT a `{ batches: [...] }`
// wrapper. A nested-batch store is incompatible with radar-kit's existing
// mark-rate report (silently coerced to an empty array — the non-array
// shape fails `Array.isArray`) and its calibration tool (`for...of` over a
// plain object throws). Keeping the store flat means this radar's marks and
// calibration work with the exact same `markRateSection.js` /
// `calibrationTool.js` every other radar uses, no changes needed there.
//
// The freshness window is the real backstop against sending the same batch
// twice: this radar runs twice weekly (Wed + Sat 05:00) and rides that same morning's
// 06:30 feed-radar digest, well over 26h before the next run's
// batch could be mistaken for it. `deliveredAt` (stamped via onDelivered
// after a confirmed send) is belt-and-suspenders on top of that.

import { readFile, writeFile, rename } from "node:fs/promises"
import { safeUrl } from "./html.js"

const DEFAULT_MAX_AGE_HOURS = 26

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }
const escapeText = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c])

/**
 * @param {string} discoveriesFilePath  absolute path to
 *        serendipity-radar's data/discoveries.json (a flat array)
 * @param {object} [opts]
 * @param {number} [opts.maxAgeHours=26]
 * @param {string} [opts.port]   serendipity-radar server port for the
 *        delivered callback
 * @param {number} [opts.now]    epoch ms, injectable for tests
 * @param {string} [opts.heading="Serendipity"]  section heading (the free-model
 *        shadow trial passes a "(trial)" heading)
 * @param {boolean} [opts.links=true]  render the star/ignore/add-to-shelf
 *        links; the trial turns them off so its picks can't write marks into
 *        the real radar's stores
 * @param {boolean} [opts.shelfLinks=links]  render just the "+ add to
 *        shelf" link even when `links` is off -- the trial keeps it, since
 *        adding to the shelf writes nothing into the radar's mark stores
 * @param {boolean} [opts.stampFile=false]  on delivery, stamp deliveredAt
 *        straight into the file instead of POSTing to the server (the trial's
 *        server only runs during its own run)
 * @returns {Promise<{id, html, text, onDelivered}|null>}
 */
export async function readPendingSerendipityDiscoveries(
  discoveriesFilePath,
  {
    maxAgeHours = DEFAULT_MAX_AGE_HOURS,
    port = process.env.SERENDIPITY_RADAR_PORT || "8025",
    now = Date.now(),
    heading = "Serendipity",
    links = true,
    shelfLinks = links,
    stampFile = false,
  } = {}
) {
  let records
  try {
    const data = JSON.parse(await readFile(discoveriesFilePath, "utf8"))
    records = Array.isArray(data) ? data : []
  } catch (err) {
    if (err.code !== "ENOENT") console.error("serendipity section: could not read", discoveriesFilePath, err)
    return null
  }
  const cutoff = now - maxAgeHours * 3600 * 1000

  // Group undelivered records by batchId, then pick the freshest batch
  // whose generatedAt falls inside the freshness window.
  const byBatch = new Map()
  for (const r of records) {
    if (!r || r.deliveredAt || !r.batchId || r.trialSeed) continue
    const t = Date.parse(r.generatedAt || "")
    if (Number.isNaN(t) || t < cutoff) continue
    if (!byBatch.has(r.batchId)) byBatch.set(r.batchId, { generatedAt: t, items: [] })
    byBatch.get(r.batchId).items.push(r)
  }

  let pickedBatchId = null
  let pickedAt = 0
  for (const [batchId, batch] of byBatch) {
    if (batch.generatedAt > pickedAt) {
      pickedBatchId = batchId
      pickedAt = batch.generatedAt
    }
  }
  if (!pickedBatchId) return null

  const items = byBatch.get(pickedBatchId).items

  return {
    id: pickedBatchId,
    ...renderSection(items, { heading, links, shelfLinks }),
    onDelivered: async () => {
      if (stampFile) {
        try {
          const all = JSON.parse(await readFile(discoveriesFilePath, "utf8"))
          const stamp = new Date(now).toISOString()
          for (const r of all) if (r?.batchId === pickedBatchId && !r.deliveredAt) r.deliveredAt = stamp
          await writeFile(discoveriesFilePath + ".tmp", JSON.stringify(all, null, 2))
          await rename(discoveriesFilePath + ".tmp", discoveriesFilePath)
        } catch {
          // Best-effort, like the POST below.
        }
        return
      }
      try {
        await fetch(`http://127.0.0.1:${port}/api/delivered`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ batchId: pickedBatchId }),
        })
      } catch {
        // Best-effort. The freshness window still stops a re-send next week.
      }
    },
  }
}

// Kinds the shelf can hold as a "want" (serendipity-radar/src/shelf.js).
const SHELF_KINDS = new Set(["book", "game"])

const KIND_LABELS = {
  exhibition: "Exhibition",
  game: "Game",
  book: "Book",
  outing: "Outing",
  publication: "Publication",
  audio: "Audio",
  other: "Discovery",
}

// Shows only the pitch: why_it_connects / why_it_is_unexpected are the agent's
// private reasoning (records from before 2026-10-20 have no pitch and fall back).
// A section with no <h1>/<h2> — the digest owns those, and
// validateDigestContent counts <h2> group headings.
function renderSection(items, { heading, links, shelfLinks = links }) {
  const base = process.env.SERENDIPITY_RADAR_BASE_URL || "http://100.79.18.117:8024"

  const htmlItems = items
    .map((it) => {
      const qs = new URLSearchParams({ kind: it.kind ?? "", title: it.title ?? "" })
      const parts = []
      if (links) {
        parts.push(`<a href="${escapeText(`${base}/api/mark?${qs}&mark=interested`)}">&#9733; more like this</a>`)
        parts.push(`<a href="${escapeText(`${base}/api/mark?${qs}&mark=ignored`)}">&#10005; not for me</a>`)
      }
      if (shelfLinks && SHELF_KINDS.has(it.kind)) {
        parts.push(`<a href="${escapeText(`${base}/api/shelf-want?${qs}`)}">&#43; add to shelf</a>`)
      }
      const linkRow = parts.length ? `<br><small>${parts.join(" &nbsp;·&nbsp; ")}</small>` : ""
      const label = KIND_LABELS[it.kind] || KIND_LABELS.other
      // Discoveries come from LLM/web output: only http(s) links survive.
      const link = it.link ? safeUrl(it.link) : "#"
      return (
        `<li><b>${escapeText(it.title)}</b> <i>(${escapeText(label)})</i><br>` +
        (it.pitch
          ? `${escapeText(it.pitch)}<br>`
          : `${escapeText(it.why_it_connects)}<br><i>${escapeText(it.why_it_is_unexpected)}</i><br>`) +
        (link !== "#" ? `<a href="${escapeText(link)}">Link</a>` : "") +
        (it.availability ? ` &mdash; ${escapeText(it.availability)}` : "") +
        `${linkRow}</li>`
      )
    })
    .join("")

  const html =
    `<hr>` +
    `<h3 style="margin-bottom:2px">${escapeText(heading)}</h3>` +
    `<ul style="padding-left:1.2em;margin-top:0">${htmlItems}</ul>`

  const textItems = items
    .map((it) => {
      const label = KIND_LABELS[it.kind] || KIND_LABELS.other
      return (
        `- ${it.title} (${label})\n` +
        (it.pitch ? `  ${it.pitch}\n` : `  ${it.why_it_connects}\n  ${it.why_it_is_unexpected}\n`) +
        (it.link && safeUrl(it.link) !== "#" ? `  ${it.link}\n` : "")
      )
    })
    .join("")
  const text = `\n—\n${heading}\n${textItems}`

  return { html, text }
}
