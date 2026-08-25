import { escapeHtml } from "./html.js"

// A "digest config" describes how one repo turns a flat item list into a
// grouped HTML+text digest. It's supplied once, in that repo's own plugin
// file, as fixed reviewed code — never generated fresh per run, same as
// everything else in this package.
//
//   pageTitle       — <h1> text and the digest's title-cased name
//   unitLabel       — singular noun for the default count line, e.g. "event"
//                      -> "3 new event(s)". Ignored if countLabel is given.
//   countLabel      — optional n => full count phrase, for wording the
//                      default can't produce — release-radar's "3 new/updated
//                      item(s)" isn't "N new item(s)", so it overrides this
//                      instead of forcing unitLabel to lie.
//   groupKey        — item => group id (e.g. item.category, item.company)
//   groupOrder      — optional fixed array of group ids in display order;
//                      omit to sort ids alphabetically from whatever's
//                      actually present in the data (job-radar's dynamic
//                      per-company grouping has no fixed order)
//   groupLabel      — group id => raw (unescaped) display label; this
//                      function escapes it once for HTML and reuses it raw
//                      in the text version, so callers never escape twice
//                      (default: the id itself)
//   sortWithinGroup — optional (a, b) => number comparator applied inside
//                      each group; release-radar uses this to list "new"
//                      items before "(UPDATED)" ones
//   renderItemHtml  — item => a complete <li>...</li> string
//   renderItemText  — item => a "- ..." block for the plain-text version
//   matchFields     — [{ key, escape }] — which item fields validateDigest
//                      (and the send-time guardrail in
//                      validateGmailSendPlugin.js) check for presence in
//                      the rendered HTML. `escape: false` for fields that
//                      are never HTML-escaped when rendered, e.g. a raw
//                      date string.

export function renderDigestContent(config, items, asOf) {
  const {
    pageTitle,
    unitLabel,
    countLabel = (n) => `${n} new ${unitLabel}(s)`,
    groupKey,
    groupOrder,
    groupLabel = (id) => id,
    sortWithinGroup,
    renderItemHtml,
    renderItemText,
  } = config

  const byGroup = {}
  for (const item of items) {
    ;(byGroup[groupKey(item)] ??= []).push(item)
  }
  const order = groupOrder ?? Object.keys(byGroup).sort()

  const count = countLabel(items.length)
  const htmlParts = [
    `<html><head><meta charset="utf-8"><title>${escapeHtml(pageTitle)}</title></head><body>`,
    `<h1>${escapeHtml(pageTitle)}</h1>`,
    `<p>${count} as of ${asOf}</p>`,
  ]
  const textParts = [`${pageTitle} — ${count} as of ${asOf}\n`]

  for (const id of order) {
    const group = byGroup[id]
    if (!group || group.length === 0) continue
    const ordered = sortWithinGroup ? [...group].sort(sortWithinGroup) : group
    const rawLabel = groupLabel(id)
    htmlParts.push(`<h2>${escapeHtml(rawLabel)}</h2>`, "<ul>")
    textParts.push(`\n${rawLabel}`)
    for (const item of ordered) {
      htmlParts.push(renderItemHtml(item))
      textParts.push(renderItemText(item))
    }
    htmlParts.push("</ul>")
  }
  htmlParts.push("</body></html>")

  return {
    html: htmlParts.join("\n"),
    text: textParts.join("\n"),
    itemCount: items.length,
    groupCount: Object.keys(byGroup).length,
  }
}

export function validateDigestContent(config, html, body, items) {
  const failures = []
  const trimmed = html.trim()

  if (!/<\/body>\s*<\/html>\s*$/i.test(trimmed)) {
    failures.push(
      "HTML does not end with a closing </body></html> — it may be truncated."
    )
  }

  for (const item of items) {
    for (const { key, escape = true } of config.matchFields) {
      const raw = item[key]
      const needle = escape ? escapeHtml(String(raw)) : String(raw)
      if (!html.includes(needle)) {
        failures.push(`Missing ${key} in HTML for "${item.title}": ${raw}`)
      }
    }
    if (!body.includes(String(item.title))) {
      failures.push(`Missing title in plain-text body: "${item.title}"`)
    }
  }

  const distinctGroups = new Set(items.map(config.groupKey)).size
  const headingCount = (html.match(/<h2[ >]/gi) || []).length
  if (headingCount !== distinctGroups) {
    failures.push(
      `Group heading count (${headingCount}) does not match the number of ` +
        `distinct groups in the items list (${distinctGroups}).`
    )
  }
  if (!body || body.trim().length < 100) {
    failures.push(
      "Plain-text body is missing, empty, or too short to be a real digest."
    )
  }

  return { pass: failures.length === 0, failures }
}
