// The "reviewed" store: a per-radar record of which items the Continuum iOS
// app has already shown you in its unified Inbox and you have swiped past
// without forming an opinion.
//
// This is deliberately NOT a calibration signal. interested.json / ignored.json
// are what the scheduled agents train on; "reviewed" only means "don't show
// this to me again in the Inbox". It was local-only on the phone until a
// bundle-id change wiped the app's container and took ~450 triage decisions
// with it — nothing on the Pi to restore them from. Giving it a store here
// makes it survive a reinstall and match across a future iPad / Mac build,
// the same way the marks already do, without the agents ever reading it.
//
// One route, POST /api/reviewed, with three body shapes:
//
//   { <fields>, reviewed: bool, via? }          — one item
//   { items: [{ <fields> }, ...], reviewed: bool, via? }
//                                               — a batch ("mark all as seen")
//   { clear: true }                             — wipe the whole store
//                                                 ("show seen items again")
//
// `fields` / `keyOf` are the same pair createOneClickMarkRoute takes, so the
// key written here matches the one the repo's mark routes use — feed-radar
// keys on the Miniflux id, the others on their normalized (title, date) /
// (watch, type, title) / (company, title, link) tuple.
//
// Plugin-free, like markStore.js and oneClickMark.js — a server imports it
// via "radar-kit/reviewedRoute" and never pulls @opencode-ai/plugin. See
// interestServer.js's note.

import { sendJson } from "./interestServer.js"

/**
 * Build the POST /api/reviewed route for a repo's interest-server.
 *
 * @param {object}   reviewed  a createMarkStore() instance with a single
 *                             non-exclusive store named "reviewed". It must
 *                             be its own instance, separate from the
 *                             interested/ignored store — sharing an
 *                             `exclusive` store would make marking something
 *                             reviewed clear its star.
 * @param {string[]} fields    body keys that identify an item, in the order
 *                             keyOf expects them
 * @param {(params) => string|null} keyOf
 *        turns those fields into the store key. MUST be the same key the
 *        repo's mark routes use. Return null to reject an item as malformed.
 * @param {string}   path      route path, default "/api/reviewed"
 * @param {string}   store     store name in the `reviewed` instance,
 *                             default "reviewed"
 */
export function createReviewedRoute({
  reviewed,
  fields,
  keyOf,
  path = "/api/reviewed",
  store = "reviewed",
}) {
  if (!reviewed || typeof reviewed.set !== "function" || typeof reviewed.clear !== "function") {
    throw new Error("createReviewedRoute: needs a markStore with set() and clear()")
  }
  if (!Array.isArray(fields) || fields.length === 0) {
    throw new Error("createReviewedRoute: needs at least one key field")
  }
  if (typeof keyOf !== "function") {
    throw new Error("createReviewedRoute: keyOf is required")
  }
  if (!reviewed.isValidStore(store)) {
    throw new Error(`createReviewedRoute: unknown store "${store}"`)
  }

  const usage =
    `expected { clear: true }, or ` +
    `{ ${fields.join(", ")}, reviewed: boolean }, or ` +
    `{ items: [{ ${fields.join(", ")} }, ...], reviewed: boolean }`

  // Pull the key fields out of one object, rejecting a missing/empty one the
  // same way createOneClickMarkRoute does — a blank field would normalize to
  // "" and collide with some other half-specified item.
  function keyFrom(source) {
    const params = {}
    for (const field of fields) {
      const value = source[field]
      if (value == null || value === "") return null
      params[field] = value
    }
    return keyOf(params)
  }

  return {
    method: "POST",
    path,
    body: true,
    handler: async ({ res, body }) => {
      if (body.clear === true) {
        const cleared = await reviewed.clear()
        sendJson(res, 200, { ok: true, cleared })
        return
      }

      if (typeof body.reviewed !== "boolean") {
        sendJson(res, 400, { error: usage })
        return
      }
      const value = body.reviewed

      // A bare POST is "web"; the iOS app — the only real client of this
      // route — sends "app".
      const via = typeof body.via === "string" && body.via ? body.via : "web"

      const rawItems = Array.isArray(body.items) ? body.items : [body]
      if (rawItems.length === 0) {
        sendJson(res, 400, { error: usage })
        return
      }

      const keys = []
      for (const item of rawItems) {
        const key = item && typeof item === "object" ? keyFrom(item) : null
        if (!key) {
          sendJson(res, 400, { error: usage })
          return
        }
        keys.push(key)
      }

      for (const key of keys) {
        await reviewed.set({ store, key, value, via })
      }

      sendJson(res, 200, { ok: true, reviewed: value, count: keys.length })
    },
  }
}
