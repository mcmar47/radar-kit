// Covers the framework-independent logic only (digest rendering/validation,
// key normalization, HTML escaping) — the tool.* factories depend on
// @opencode-ai/plugin, a peerDependency this package doesn't install for
// itself, so they're exercised indirectly via each consuming repo's own
// runs instead.
import { test } from "node:test"
import assert from "node:assert/strict"
import { escapeHtml } from "../src/html.js"
import { renderDigestContent, validateDigestContent } from "../src/digest.js"
import { makeKeyFn, normalizeField } from "../src/seenStore.js"

test("escapeHtml escapes the three unsafe characters only", () => {
  assert.equal(escapeHtml(`A & B <tag> "quoted"`), `A &amp; B &lt;tag&gt; "quoted"`)
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
