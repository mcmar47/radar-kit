// Escapes the five characters that can break out of an HTML text node OR a
// quoted attribute value. It used to cover & < > only, which was fine while
// every call site was a text node -- but all four digests render a scraped
// item link straight into href="...", and there the missing quote pair meant
// a link containing a single " could close the attribute and add its own:
//
//   link:     https://x.com/" onmouseover="..." data-x="
//   rendered: <a href="https://x.com/" onmouseover="..." data-x="">Apply</a>
//
// Escaping quotes here rather than in a separate attribute helper keeps one
// rule for both contexts, so a new call site can't pick the weaker one by
// accident. Note this changes the needles validateDigestContent builds for
// any matchField with `escape: true` -- they escape the same way, so the two
// stay in step, but a field whose rendered form is NOT escaped must be
// declared `escape: false` (see digest.js).
export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

// Item links are scraped off the open web, so the scheme is untrusted too --
// escaping quotes stops the attribute break-out above but does nothing about
// href="javascript:...". Anything that isn't plainly http(s) collapses to
// "#": a dead link in a digest is a much better failure than a live one that
// does something other than navigate.
//
// Returns the parsed/normalized href, which also percent-encodes anything
// stray still sitting in the URL. Always compose with escapeHtml at the call
// site -- this handles the scheme, that handles the markup.
export function safeUrl(s) {
  let parsed
  try {
    parsed = new URL(String(s ?? "").trim())
  } catch {
    return "#"
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : "#"
}
