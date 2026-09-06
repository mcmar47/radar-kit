// readPendingResearchAnswer (src/researchDesk.js) + renderDigestContent's
// extra-section handling. Both are plugin-free; the send/render tool
// factories that use them are exercised through feed-radar's own runs.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { readPendingResearchAnswer } from "../src/researchDesk.js"
import { renderDigestContent } from "../src/digest.js"

const NOW = Date.parse("2026-09-07T06:30:00Z")

async function deskFile(items) {
  const dir = await mkdtemp(path.join(tmpdir(), "desk-"))
  const file = path.join(dir, "desk.json")
  await writeFile(file, JSON.stringify({ items }))
  return { file, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

const answered = (over = {}) => ({
  id: "q-1",
  question: "What changed?",
  status: "answered",
  answeredAt: "2026-09-07T03:45:00Z",
  answerMarkdown: "It changed a lot.",
  answerHtml: "<p>It changed a lot.</p>",
  sources: ["https://example.com/a"],
  deliveredAt: null,
  ...over,
})

test("returns the freshest answered, undelivered, in-window item", async () => {
  const { file, cleanup } = await deskFile([
    answered({ id: "old", answeredAt: "2026-09-06T03:45:00Z" }), // >22h → stale
    answered({ id: "new", answeredAt: "2026-09-07T03:45:00Z" }),
  ])
  const section = await readPendingResearchAnswer(file, { now: NOW })
  assert.equal(section.id, "new")
  assert.match(section.html, /<hr><h3[^>]*>Research Desk<\/h3>/)
  assert.match(section.html, /It changed a lot\./)
  assert.match(section.text, /Research Desk\nWhat changed\?/)
  assert.match(section.text, /Sources:\n {2}https:\/\/example\.com\/a/)
  assert.equal(typeof section.onDelivered, "function")
  await cleanup()
})

test("skips delivered, non-answered, and out-of-window items → null", async () => {
  for (const items of [
    [answered({ deliveredAt: "2026-09-07T06:30:00Z" })],
    [answered({ status: "running" })],
    [answered({ status: "error" })],
    [answered({ answeredAt: "2026-09-05T00:00:00Z" })],
    [],
  ]) {
    const { file, cleanup } = await deskFile(items)
    assert.equal(await readPendingResearchAnswer(file, { now: NOW }), null)
    await cleanup()
  }
})

test("a missing or unreadable desk file is null, never a throw", async () => {
  assert.equal(await readPendingResearchAnswer("/no/such/desk.json", { now: NOW }), null)
})

test("the rendered section carries no <h2> (would break the digest validator)", async () => {
  const { file, cleanup } = await deskFile([answered()])
  const section = await readPendingResearchAnswer(file, { now: NOW })
  assert.equal(/<h2[ >]/i.test(section.html), false)
  await cleanup()
})

test("falls back to escaped markdown when answerHtml is missing", async () => {
  const { file, cleanup } = await deskFile([
    answered({ answerHtml: null, answerMarkdown: "raw <b>text</b> & more" }),
  ])
  const section = await readPendingResearchAnswer(file, { now: NOW })
  assert.match(section.html, /raw &lt;b&gt;text&lt;\/b&gt; &amp; more/)
  await cleanup()
})

// --- renderDigestContent extra-section ---

const config = {
  pageTitle: "Feed Radar",
  unitLabel: "pick",
  groupKey: (i) => i.theme,
  renderItemHtml: (i) => `<li>${i.title}</li>`,
  renderItemText: (i) => `- ${i.title}`,
}

test("extra section lands after groups, before the footer, before </body>", () => {
  const { html, text } = renderDigestContent(config, [{ theme: "ai", title: "One" }], "2026-09-07", {
    extraHtml: "<hr><h3>Research Desk</h3><p>answer</p>",
    extraText: "\n—\nResearch Desk\nanswer",
    footerHtml: "<hr><p>Last 7 days: 3 picks</p>",
    footerText: "\n—\nLast 7 days: 3 picks",
  })
  assert.match(html, /<li>One<\/li>[\s\S]*Research Desk[\s\S]*Last 7 days[\s\S]*<\/body><\/html>$/)
  assert.match(text, /Research Desk\nanswer[\s\S]*Last 7 days/)
})

test("with zero items and an extra section, the count line is dropped, not '0 new pick(s)'", () => {
  const { html, text } = renderDigestContent(config, [], "2026-09-07", {
    extraHtml: "<hr><h3>Research Desk</h3><p>answer</p>",
    extraText: "\n—\nResearch Desk\nanswer",
  })
  assert.doesNotMatch(html, /0 new pick/)
  assert.match(html, /<p>as of 2026-09-07<\/p>/)
  assert.match(html, /Research Desk[\s\S]*<\/body><\/html>$/)
  assert.match(text, /Feed Radar — as of 2026-09-07/)
})

test("no extra options leaves output byte-identical to before", () => {
  const { html } = renderDigestContent(config, [{ theme: "ai", title: "One" }], "2026-09-07")
  assert.match(html, /<p>1 new pick\(s\) as of 2026-09-07<\/p>/)
  assert.doesNotMatch(html, /<hr>/)
})
