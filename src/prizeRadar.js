// Delivery glue for prize-radar (the `prize-radar` repo, SYNTHESIS-IDEAS.md
// #2 / SYNTHESIS-PLAN.md #4): read its `data/digest.json` and, if there is
// a fresh run's editorial framing waiting, return it as a digest section
// for feed-radar's render/send tools to fold in.
//
// Dependency-free on purpose — same discipline as researchDesk.js and
// serendipity.js.
//
// Unlike those two, there is no `onDelivered` callback here and no
// per-item delivery-tracking state at all. research-desk's desk.json and
// serendipity-radar's discoveries.json are both server-backed queues where
// an item can be marked delivered; prize-radar's data/digest.json is a
// git-committed weekly snapshot with no server and no per-item state to
// update. The freshness window alone is the guard against the same digest
// reappearing in two different feed-radar runs — prize-radar runs weekly
// (Thursday mornings) and rides that same morning's feed-radar digest, well
// inside the window below and nowhere near the following Thursday's run.

import { readFile } from "node:fs/promises"

const DEFAULT_MAX_AGE_HOURS = 48

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }
const escapeText = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c])

/**
 * @param {string} digestFilePath  absolute path to prize-radar's
 *        data/digest.json
 * @param {object} [opts]
 * @param {number} [opts.maxAgeHours=48]
 * @param {number} [opts.now]    epoch ms, injectable for tests
 * @returns {Promise<{id, html, text}|null>}
 */
export async function readPendingPrizeDigest(
  digestFilePath,
  { maxAgeHours = DEFAULT_MAX_AGE_HOURS, now = Date.now() } = {}
) {
  let digest
  try {
    digest = JSON.parse(await readFile(digestFilePath, "utf8"))
  } catch {
    return null
  }
  if (!digest || typeof digest !== "object") return null

  const generatedAt = Date.parse(digest.generatedAt || "")
  if (Number.isNaN(generatedAt)) return null
  const cutoff = now - maxAgeHours * 3600 * 1000
  if (generatedAt < cutoff) return null

  const movements = Array.isArray(digest.movements) ? digest.movements : []
  if (movements.length === 0) return null // a genuinely quiet week has nothing worth a digest section

  return {
    id: digest.generatedAt,
    ...renderSection(digest, movements),
  }
}

// A section with no <h1>/<h2> — the digest owns those, and
// validateDigestContent counts <h2> group headings.
function renderSection(digest, movements) {
  const htmlItems = movements
    .map((m) => {
      const sources = Array.isArray(m.sources) ? m.sources : []
      const sourceLinks = sources
        .filter((s) => s && /^https?:\/\//i.test(s.url || ""))
        .map((s) => `<a href="${escapeText(s.url)}">${escapeText(s.label)}</a>`)
        .join(" &middot; ")
      return (
        `<li><i>${escapeText(m.tag)}</i><br>` +
        `<b>${escapeText(m.headline)}</b><br>` +
        `${escapeText(m.body)}` +
        (sourceLinks ? `<br><small>${sourceLinks}</small>` : "") +
        `</li>`
      )
    })
    .join("")

  const html =
    `<hr>` +
    `<h3 style="margin-bottom:2px">Prize Watch</h3>` +
    `<p style="margin-top:0;margin-bottom:8px">${escapeText(digest.dek || "")}</p>` +
    `<ul style="padding-left:1.2em;margin-top:0">${htmlItems}</ul>`

  const textItems = movements
    .map((m) => `- ${m.tag}: ${m.headline}\n  ${m.body}\n`)
    .join("")
  const text = `\n—\nPrize Watch\n${digest.dek || ""}\n${textItems}`

  return { html, text }
}
