// Delivery glue for the Overnight Research Desk (the `research-desk` repo,
// GPT-SUGGESTIONS.md #2): read its `data/desk.json` and, if there is an
// answered question waiting that hasn't been delivered yet, return it as a
// digest section for feed-radar's render/send tools to fold in.
//
// Dependency-free on purpose — feed-radar's plugin imports this from the
// barrel, but nothing here reaches @opencode-ai/plugin, and it's small
// enough that a future consumer could import it on its own subpath.
//
// `deliveredAt` (stamped via onDelivered after a confirmed send) is what
// stops the same answer going out twice. The freshness window is the backstop
// for a failed callback and for ancient unanswered-then-answered rows. It is
// 30h, not 24h or less: research-desk is on-demand now, so an answer can land
// any time, and one finishing just after a ~06:30 digest is 22-24h old at the
// next one and used to be skipped for good.

import { readFile } from "node:fs/promises"

const DEFAULT_MAX_AGE_HOURS = 30

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }
const escapeText = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c])

/**
 * @param {string} deskFilePath  absolute path to research-desk's data/desk.json
 * @param {object} [opts]
 * @param {number} [opts.maxAgeHours=30]
 * @param {string} [opts.port]   desk server port for the delivered callback
 * @param {number} [opts.now]    epoch ms, injectable for tests
 * @returns {Promise<{id, html, text, onDelivered}|null>}
 */
export async function readPendingResearchAnswer(
  deskFilePath,
  { maxAgeHours = DEFAULT_MAX_AGE_HOURS, port = process.env.RESEARCH_DESK_PORT || "8023", now = Date.now() } = {}
) {
  let data
  try {
    data = JSON.parse(await readFile(deskFilePath, "utf8"))
  } catch (err) {
    // A missing file just means nothing to deliver; anything else (corrupt
    // JSON, permissions) is worth a log line. Still non-fatal either way.
    if (err.code !== "ENOENT") console.error("research-desk section: could not read", deskFilePath, err)
    return null
  }
  const items = Array.isArray(data?.items) ? data.items : []
  const cutoff = now - maxAgeHours * 3600 * 1000

  let picked = null
  let pickedAt = 0
  for (const it of items) {
    if (!it || it.status !== "answered" || it.deliveredAt) continue
    const t = Date.parse(it.answeredAt || "")
    if (Number.isNaN(t) || t < cutoff) continue
    if (t > pickedAt) {
      picked = it
      pickedAt = t
    }
  }
  if (!picked) return null

  return {
    id: picked.id,
    ...renderSection(picked),
    onDelivered: async () => {
      try {
        await fetch(`http://127.0.0.1:${port}/api/delivered`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: picked.id }),
        })
      } catch {
        // Best-effort. Without deliveredAt only the 30h window limits a re-send.
      }
    },
  }
}

// A section with no <h1>/<h2> — the digest owns those, and
// validateDigestContent counts <h2> group headings.
function renderSection(item) {
  const answerHtml =
    typeof item.answerHtml === "string" && item.answerHtml.trim()
      ? item.answerHtml
      : `<p>${escapeText(item.answerMarkdown)}</p>`

  const html =
    `<hr>` +
    `<h3 style="margin-bottom:2px">Research Desk</h3>` +
    `<p style="color:#667;font-style:italic;margin-top:0">${escapeText(item.question)}</p>` +
    answerHtml

  const sourcesText =
    Array.isArray(item.sources) && item.sources.length
      ? `\n\nSources:\n${item.sources.map((s) => `  ${s}`).join("\n")}`
      : ""
  const text = `\n—\nResearch Desk\n${item.question}\n\n${item.answerMarkdown ?? ""}${sourcesText}\n`

  return { html, text }
}
