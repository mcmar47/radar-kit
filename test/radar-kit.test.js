// Covers the framework-independent logic only (digest rendering/validation,
// key normalization, HTML escaping) — the tool.* factories depend on
// @opencode-ai/plugin, a peerDependency this package doesn't install for
// itself, so they're exercised indirectly via each consuming repo's own
// runs instead.
import { test } from "node:test"
import assert from "node:assert/strict"
import { escapeHtml, safeUrl } from "../src/html.js"
import { buildRawMimeMessage } from "../src/gmail.js"
import { renderDigestContent, validateDigestContent } from "../src/digest.js"
import { makeKeyFn, normalizeField } from "../src/seenStore.js"

test("escapeHtml escapes the five characters that break markup", () => {
  assert.equal(
    escapeHtml(`A & B <tag> "quoted" 'single'`),
    `A &amp; B &lt;tag&gt; &quot;quoted&quot; &#39;single&#39;`
  )
})

test("escapeHtml closes the href attribute break-out", () => {
  // The shape that made this a finding: a scraped link ending an attribute
  // early and starting its own.
  const link = 'https://x.com/" onmouseover="alert(1)" data-x="'
  const rendered = `<a href="${escapeHtml(safeUrl(link))}">Apply</a>`
  assert.ok(!rendered.includes('onmouseover="'), "attribute must not break out")
  assert.equal(rendered.match(/"/g).length, 2, "exactly the two href quotes")
})

test("safeUrl passes http(s) through and collapses everything else", () => {
  assert.equal(safeUrl("https://example.com/a?b=1&c=2"), "https://example.com/a?b=1&c=2")
  assert.equal(safeUrl("http://example.com/"), "http://example.com/")
  assert.equal(safeUrl("javascript:alert(1)"), "#")
  assert.equal(safeUrl("data:text/html,<script>alert(1)</script>"), "#")
  assert.equal(safeUrl("/relative/path"), "#")
  assert.equal(safeUrl(""), "#")
  assert.equal(safeUrl(null), "#")
  assert.equal(safeUrl(undefined), "#")
})

test("a CRLF in the subject cannot inject a header", () => {
  const raw = buildRawMimeMessage({
    to: "someone@example.com",
    subject: "Feed Radar\r\nBcc: attacker@example.com\r\nX-Injected: yes",
    text: "body",
    html: "<html><body>hi</body></html>",
    fromName: "CmarBot",
    fromAddress: "someone+cmarbot@example.com",
  })
  const headerBlock = raw.split("\r\n\r\n")[0]
  assert.ok(!/^Bcc:/im.test(headerBlock), "no injected Bcc header")
  assert.ok(!/^X-Injected:/im.test(headerBlock), "no injected X-Injected header")
  assert.ok(
    headerBlock.includes("Subject: Feed Radar Bcc: attacker@example.com X-Injected: yes"),
    "the text survives, flattened onto the one Subject line"
  )
})

test("a CRLF in the recipient cannot inject a header either", () => {
  const raw = buildRawMimeMessage({
    to: "someone@example.com\r\nBcc: attacker@example.com",
    subject: "Digest",
    text: "body",
    html: "<html><body>hi</body></html>",
    fromName: "CmarBot",
    fromAddress: "someone+cmarbot@example.com",
  })
  assert.ok(!/^Bcc:/im.test(raw.split("\r\n\r\n")[0]))
})

test("an escaped link still round-trips through render + validate", () => {
  // The regression this guards: flipping the anchor to escapeHtml(safeUrl(...))
  // changes what appears in the HTML, so feed-radar's link matchField had to
  // move to escape: true. A URL with & is the everyday case that would break.
  const config = {
    pageTitle: "Feed Radar",
    unitLabel: "pick",
    groupKey: (p) => p.theme,
    groupOrder: ["books"],
    groupLabel: () => "Books",
    renderItemHtml: (p) =>
      `<li>${escapeHtml(p.title)} <a href="${escapeHtml(safeUrl(p.link))}">${escapeHtml(p.link)}</a></li>`,
    renderItemText: (p) => `- ${p.title}\n  ${p.link}`,
    matchFields: [
      { key: "title", escape: true },
      { key: "link", escape: true },
    ],
  }
  const items = [
    { title: 'A "quoted" title & more', link: "https://example.com/x?a=1&b=2", theme: "books" },
  ]
  const { html, text } = renderDigestContent(config, items, "2026-08-28")
  const padded = text + "\n" + "x".repeat(120)
  const result = validateDigestContent(config, html, padded, items)
  assert.deepEqual(result.failures, [])
  assert.ok(result.pass)
})

test("renderDigestContent groups by a fixed order and skips empty groups", () => {
  const config = {
    pageTitle: "Test Digest",
    unitLabel: "item",
    groupKey: (i) => i.category,
    groupOrder: ["a", "b", "c"],
    groupLabel: (id) => `Group ${id.toUpperCase()}`,
    renderItemHtml: (i) => `<li>${i.title}</li>`,
    renderItemText: (i) => `- ${i.title}`,
  }
  const items = [
    { title: "One", category: "a" },
    { title: "Two", category: "c" },
  ]
  const { html, text, itemCount, groupCount } = renderDigestContent(config, items, "2026-08-25")

  assert.equal(itemCount, 2)
  assert.equal(groupCount, 2)
  // "b" has no items and must not produce a heading
  assert.equal((html.match(/<h2/g) || []).length, 2)
  assert.ok(html.indexOf("Group A") < html.indexOf("Group C"), "fixed order preserved")
  assert.ok(text.includes("- One"))
  assert.ok(html.trim().endsWith("</body></html>"))
})

test("countLabel overrides the default 'new X(s)' phrasing", () => {
  const config = {
    pageTitle: "Release Radar Digest",
    countLabel: (n) => `${n} new/updated item(s)`,
    groupKey: (i) => i.type,
    renderItemHtml: (i) => `<li>${i.title}</li>`,
    renderItemText: (i) => `- ${i.title}`,
  }
  const { html, text } = renderDigestContent(config, [{ title: "X", type: "book" }], "2026-08-25")
  assert.ok(html.includes("1 new/updated item(s) as of 2026-08-25"))
  assert.ok(text.includes("1 new/updated item(s) as of 2026-08-25"))
})

test("renderDigestContent falls back to alphabetical groups when no groupOrder given", () => {
  const config = {
    pageTitle: "Test",
    unitLabel: "item",
    groupKey: (i) => i.company,
    renderItemHtml: (i) => `<li>${i.title}</li>`,
    renderItemText: (i) => `- ${i.title}`,
  }
  const items = [
    { title: "X", company: "Zeta" },
    { title: "Y", company: "Acme" },
  ]
  const { html } = renderDigestContent(config, items, "2026-08-25")
  assert.ok(html.indexOf("Acme") < html.indexOf("Zeta"))
})

test("renderDigestContent applies sortWithinGroup", () => {
  const config = {
    pageTitle: "Test",
    unitLabel: "item",
    groupKey: (i) => i.type,
    groupOrder: ["book"],
    sortWithinGroup: (a, b) => (a.kind === "updated" ? 1 : 0) - (b.kind === "updated" ? 1 : 0),
    renderItemHtml: (i) => `<li>${i.title}</li>`,
    renderItemText: (i) => `- ${i.title}`,
  }
  const items = [
    { title: "Updated Book", type: "book", kind: "updated" },
    { title: "New Book", type: "book", kind: "new" },
  ]
  const { text } = renderDigestContent(config, items, "2026-08-25")
  assert.ok(text.indexOf("New Book") < text.indexOf("Updated Book"))
})

test("validateDigestContent passes for well-formed matching content", () => {
  const config = {
    groupKey: (i) => i.category,
    matchFields: [
      { key: "title", escape: true },
      { key: "date", escape: false },
    ],
  }
  const items = [{ title: "Café Night", date: "2026-09-01", category: "a" }]
  const html =
    `<html><body><h2>A</h2><li>${escapeHtml("Café Night")} 2026-09-01</li></body></html>`
  const body = "x".repeat(100) + " Café Night"
  const result = validateDigestContent(config, html, body, items)
  assert.deepEqual(result, { pass: true, failures: [] })
})

test("validateDigestContent flags a missing field, truncated HTML, and heading mismatch", () => {
  const config = {
    groupKey: (i) => i.category,
    matchFields: [{ key: "title", escape: true }],
  }
  const items = [
    { title: "Present", category: "a" },
    { title: "Absent", category: "b" },
  ]
  // No <h2> for category "b", HTML not closed, body too short.
  const html = `<html><body><h2>A</h2>Present`
  const body = "short"
  const { pass, failures } = validateDigestContent(config, html, body, items)
  assert.equal(pass, false)
  assert.ok(failures.some((f) => f.includes("closing")))
  assert.ok(failures.some((f) => f.includes('"Absent"')))
  assert.ok(failures.some((f) => f.includes("heading count")))
  assert.ok(failures.some((f) => f.includes("too short")))
})

test("normalizeField trims, case-folds, and collapses whitespace", () => {
  assert.equal(normalizeField("  Acme   Corp \n"), "acme corp")
})

test("makeKeyFn normalizes by default and preserves exact fields verbatim", () => {
  const keyOf = makeKeyFn(["title", { field: "release_date", exact: true }])
  assert.equal(
    keyOf({ title: "  My Book ", release_date: "TBD" }),
    "my book|TBD"
  )
  // Case/whitespace differences in the normalized field collapse to the
  // same key; the exact field must NOT be case-folded (a real bug this
  // guards against: "TBD" and "tbd" must stay distinguishable if a source
  // ever emits it that way, since exact fields are compared for meaning,
  // not spelling).
  assert.equal(keyOf({ title: "my   book", release_date: "TBD" }), "my book|TBD")
})
