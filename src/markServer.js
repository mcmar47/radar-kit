// createMarkServer: a radar's whole interest-server from one declaration.
//
// The four original radars (event-watch, release-radar, feed-radar,
// job-radar) each had a ~150-line server/interest-server.js that was the same
// file modulo its key fields: exclusive interested/ignored stores, a
// reviewed store, the email's one-click GET, POST toggles, the reviewed
// route, health, and (since 2026-09-28) the run trigger. That's the
// "config-driven mark site" step of the unification verdict (fleet-docs
// UNIFICATION-PROS-CONS.md, L1.5 step 2), server half only: the three mark
// pages are genuinely different UIs, not duplicated boilerplate.
//
//   createMarkServer({
//     name: "event-watch interest-server",
//     port: 8013,
//     repoDir,                         // stores live at the repo root
//     keyFields: KEY_FIELDS,           // from the repo's markKey.mjs
//     runUnit: "event-watch.service",  // optional: POST /api/run
//   }).listen()
//
// Request/response shapes are exactly what the pages and the Continuum app
// already send, in two styles:
//   api: "toggle" (default)  POST /api/interested and /api/ignored with
//                            { <key fields>, interested|ignored: bool, via? }
//                            -> { ok: true, <store>: bool }
//   api: "mark"              POST /api/mark with { <key fields>, mark, value, via? }
//                            -> { ok: true, <key fields>, mark, value }   (feed-radar)
// Plus, always: GET /api/mark (the digest email's one-click links),
// POST /api/reviewed, GET /api/health.
//
// Options for the per-radar differences:
//   keyOf       custom key function (feed-radar validates a numeric id); it
//               returns null for an invalid item, which answers 400. Defaults
//               to makeKeyFn(keyFields).
//   onMarked    ({ store, value, item, key }) after any mark write
//               (release-radar mirrors a star onto the shelf). Never awaited
//               for the response, and a throw is logged, not fatal.
//   extraRoutes appended after the standard ones.
//
// Plugin-free: a server imports it via "radar-kit/markServer".

import path from "node:path"
import { createInterestServer, sendJson } from "./interestServer.js"
import { createMarkStore } from "./markStore.js"
import { createOneClickMarkRoute } from "./oneClickMark.js"
import { createReviewedRoute } from "./reviewedRoute.js"
import { createHealthRoute } from "./healthRoute.js"
import { createRunRoute } from "./runRoute.js"
import { makeKeyFn } from "./seenStore.js"

const fieldName = (f) => (typeof f === "string" ? f : f.field)

export function createMarkServer({
  name,
  port,
  repoDir,
  keyFields,
  keyOf = null,
  api = "toggle",
  runUnit = null,
  onMarked = null,
  extraRoutes = [],
  host,
} = {}) {
  if (!name || !repoDir || !Array.isArray(keyFields) || keyFields.length === 0) {
    throw new Error("createMarkServer: name, repoDir and a non-empty keyFields are required")
  }
  if (api !== "toggle" && api !== "mark") {
    throw new Error(`createMarkServer: api must be "toggle" or "mark", got ${JSON.stringify(api)}`)
  }
  const fields = keyFields.map(fieldName)
  const key = keyOf ?? makeKeyFn(keyFields)

  // An item cannot be both starred and rejected: that would feed the agent's
  // calibration contradictory examples.
  const marks = createMarkStore({
    paths: {
      interested: path.join(repoDir, "interested.json"),
      ignored: path.join(repoDir, "ignored.json"),
    },
    exclusive: true,
  })
  // The Continuum app's Inbox "seen" set: its own non-exclusive store, never
  // read by the agent (see reviewedRoute.js).
  const reviewed = createMarkStore({
    paths: { reviewed: path.join(repoDir, "reviewed.json") },
  })

  const notify = (event) => {
    if (!onMarked) return
    Promise.resolve()
      .then(() => onMarked(event))
      .catch((err) => console.error(`${name}: onMarked hook threw:`, err))
  }

  // Pick exactly the key fields off a body; null if any is missing or the
  // key function rejects the item.
  const itemFrom = (body) => {
    const item = {}
    for (const f of fields) {
      if (body?.[f] === undefined || body[f] === null || body[f] === "") return null
      item[f] = body[f]
    }
    return key(item) ? item : null
  }
  const viaOf = (body) => (typeof body?.via === "string" && body.via ? body.via : "web")

  const toggleRoute = (store) => ({
    method: "POST",
    path: `/api/${store}`,
    body: true,
    handler: async ({ res, body }) => {
      const item = itemFrom(body)
      const value = body?.[store]
      if (!item || typeof value !== "boolean") {
        sendJson(res, 400, { error: `expected {${fields.join(", ")}, ${store}: boolean}` })
        return
      }
      const k = key(item)
      await marks.set({ store, key: k, value, via: viaOf(body) })
      notify({ store, value, item, key: k })
      sendJson(res, 200, { ok: true, [store]: value })
    },
  })

  const markRoute = {
    method: "POST",
    path: "/api/mark",
    body: true,
    handler: async ({ res, body }) => {
      const item = itemFrom(body)
      const { mark, value } = body ?? {}
      if (!item || !marks.isValidStore(mark) || typeof value !== "boolean") {
        sendJson(res, 400, {
          error: `expected {${fields.join(", ")}, mark: 'interested'|'ignored', value: boolean}`,
        })
        return
      }
      const k = key(item)
      await marks.set({ store: mark, key: k, value, via: viaOf(body) })
      notify({ store: mark, value, item, key: k })
      // Echo the key fields as the route always did (feed-radar: { id }), in
      // their normalized form when the key is a single field.
      const echo = fields.length === 1 ? { [fields[0]]: k } : item
      sendJson(res, 200, { ok: true, ...echo, mark, value })
    },
  }

  const routes = [
    ...(runUnit ? [createRunRoute({ unit: runUnit })] : []),
    createHealthRoute({ name }),
    createOneClickMarkRoute({
      marks,
      fields,
      keyOf: key,
      onMarked: ({ store, params, key: k }) => notify({ store, value: true, item: params, key: k }),
    }),
    ...(api === "toggle" ? [toggleRoute("interested"), toggleRoute("ignored")] : [markRoute]),
    createReviewedRoute({ reviewed, fields, keyOf: key }),
    ...extraRoutes,
  ]

  const server = createInterestServer({ name, port, routes, ...(host ? { host } : {}) })
  return { ...server, marks, reviewed, routes }
}
