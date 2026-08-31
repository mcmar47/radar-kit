// The GET half of the mark endpoints: one-click star / reject links that go
// in the digest email itself, not only on each repo's web page.
//
// Why this is shared code rather than three copies, and why it matters more
// than its size suggests. The star mechanism shipped in event-watch and
// release-radar first, on their web pages only. Measured on 2026-08-30:
//
//   event-watch     264 events tracked,   0 marks
//   release-radar    79 releases tracked,  2 marks
//   feed-radar       57 picks tracked,    11 marks
//
// feed-radar is the only one that put the controls in the digest email, and
// it collected more signal in days than the other two had in their whole
// lifetimes. feed-tools.js predicted exactly this in a comment before the
// numbers existed: the page "is a place you have to decide to visit", the
// email is the thing that already gets opened. Calibration is the only
// training signal any of these agents has, so the controls have to live
// where the reading happens.
//
// This module is that route, factored out at the moment it would otherwise
// have been written a third time — the same threshold everything else in
// this package was extracted at.
//
// A GET that mutates is normally a mistake, because link prefetchers and
// mail-client scanners will fire it unbidden. Two things make it the right
// call here anyway: an email client cannot POST at all, so the alternative
// is no email controls; and feed-radar has run this exact route since
// 2026-08-28 with 11 marks against 57 picks — a prefetcher would have
// marked all 57. Keep the links Tailscale-only (they are), and keep this
// route set-only: it never clears a mark, so the worst case from a stray
// fetch is one wrong positive, correctable on the page.
//
// Kept free of any @opencode-ai/plugin import, like markStore.js and
// interestServer.js, so the servers can import it without dragging the
// plugin tree onto the Pi. See interestServer.js's note.

import { sendHtml, sendText } from "./interestServer.js"

// What the confirmation page calls each store. "ignored" is the store name,
// but "not interested" is what a person just clicked.
const DEFAULT_LABELS = {
  interested: "interested",
  ignored: "not interested",
}

export function notedPage(label) {
  return (
    `<!doctype html><meta charset="utf-8"><title>Noted</title>` +
    `<body style="font:16px/1.5 -apple-system,system-ui,sans-serif;padding:3rem;text-align:center">` +
    `<p>Marked <b>${label}</b>.</p>` +
    `<p style="color:#667">You can close this tab.</p>` +
    // Browsers only allow script-initiated window.close() on tabs with no
    // other history to go back to, which is exactly this case (opened fresh
    // by clicking an email link). Some browsers block it anyway -- the
    // "close this tab" text above is the fallback for that.
    `<script>setTimeout(() => window.close(), 800)</script>`
  )
}

/**
 * Build the one-click GET route for a repo's mark endpoint.
 *
 * @param {object}   marks   a createMarkStore() instance
 * @param {string[]} fields  query params that identify the item, in the
 *                           order keyOf expects them
 * @param {(params) => string|null} keyOf
 *        turns those params into the store key. MUST be the same key the
 *        repo's POST route and its read_calibration tool use, or the marks
 *        land under keys nothing ever joins back to a record. Return null
 *        to reject the request as malformed (feed-radar uses this to keep
 *        a non-numeric Miniflux id out of the key space entirely).
 * @param {string}   path    route path, default "/api/mark"
 * @param {object}   labels  store name -> what the confirmation page says
 * @param {(info: {store, params, key}) => void|Promise<void>} onMarked
 *        optional. Called once after a click's mark is written to disk, with
 *        the store name, the raw query params, and the computed key. For a
 *        downstream side effect of the mark — release-radar mirrors an
 *        "interested" release onto the shelf this way. Runs after the store
 *        write so a hook failure can't lose the mark, and is wrapped so a
 *        throw can't turn a successful click into an error page. The hook
 *        owns its own timeout/retry — this route only guarantees one call
 *        per set and does not block the response on slow work the hook
 *        chooses not to await.
 */
export function createOneClickMarkRoute({
  marks,
  fields,
  keyOf,
  path = "/api/mark",
  labels = DEFAULT_LABELS,
  onMarked = null,
}) {
  if (!marks || typeof marks.set !== "function") {
    throw new Error("createOneClickMarkRoute: needs a markStore")
  }
  if (!Array.isArray(fields) || fields.length === 0) {
    throw new Error("createOneClickMarkRoute: needs at least one key field")
  }
  if (typeof keyOf !== "function") {
    throw new Error("createOneClickMarkRoute: keyOf is required")
  }
  if (onMarked != null && typeof onMarked !== "function") {
    throw new Error("createOneClickMarkRoute: onMarked must be a function")
  }

  const usage =
    `expected ?` +
    fields.map((f) => `${f}=<${f}>`).join("&") +
    `&mark=${marks.names.join("|")}`

  return {
    method: "GET",
    path,
    handler: async ({ res, url }) => {
      const mark = url.searchParams.get("mark")
      if (!marks.isValidStore(mark)) {
        sendText(res, 400, usage)
        return
      }

      // Every key field must be present and non-empty. A missing one would
      // otherwise normalize to "" and quietly write a mark under a key that
      // matches some other half-specified item.
      const params = {}
      for (const field of fields) {
        const value = url.searchParams.get(field)
        if (!value) {
          sendText(res, 400, usage)
          return
        }
        params[field] = value
      }

      const key = keyOf(params)
      if (!key) {
        sendText(res, 400, usage)
        return
      }

      await marks.set({ store: mark, key, value: true })

      if (onMarked) {
        try {
          await onMarked({ store: mark, params, key })
        } catch (err) {
          console.error("createOneClickMarkRoute: onMarked hook threw:", err)
        }
      }

      sendHtml(res, 200, notedPage(labels[mark] ?? mark))
    },
  }
}

/**
 * The other half: build the link pair that goes in a digest.
 *
 * Returns { interested, ignored } absolute URLs for one item. Kept next to
 * the route so the query-string shape is written once — a plugin building
 * these by hand is exactly how the two ends drift apart.
 *
 * @param {string} baseUrl  scheme+host+port of the repo's nginx vhost
 * @param {object} params   the key fields, same names the route reads
 * @param {string} path     must match the route's path
 */
export function markUrls({ baseUrl, params, path = "/api/mark" }) {
  const build = (mark) => {
    const qs = new URLSearchParams({ ...params, mark })
    return `${baseUrl}${path}?${qs}`
  }
  return { interested: build("interested"), ignored: build("ignored") }
}
