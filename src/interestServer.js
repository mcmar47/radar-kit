// The HTTP half of the interest-server that event-watch, release-radar and
// feed-radar each ran their own near-identical copy of: plain node:http, no
// framework, a couple of routes, and one very important catch-all.
//
// What stayed in each repo is what genuinely differs — the key shape
// ((title, date) vs (watch, type, title) vs a Miniflux entry id), the
// request schema, and feed-radar's HTML response for one-click links from
// the digest email. What moved here is the part that was the same in all
// three, and the part that took the process down when it was wrong.
//
// IMPORTANT — why this is not exported from index.js:
// index.js re-exports the tool factories, which import
// @opencode-ai/plugin/tool. A server importing the barrel would load that
// whole tree, which is why release-radar's server/package.json used to say
// "No dependencies on purpose". Two things fix that and both are required:
//
//   1. package.json's "exports" map gives this file its own subpath
//      ("radar-kit/server"), so `import ... from "radar-kit/server"` never
//      evaluates index.js and never reaches the tool modules.
//   2. @opencode-ai/plugin is marked optional in peerDependenciesMeta, so
//      npm no longer auto-installs it for a consumer that only wants this.
//
// Keep this module and markStore.js free of any import that reaches the
// plugin package, or that objection comes straight back.

import { createServer } from "node:http"

const MAX_BODY_BYTES = 64 * 1024

// Read and JSON-parse a request body. An empty body is `{}` rather than a
// parse error, matching what all three originals did.
async function readJsonBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    // These endpoints take a handful of short fields. A body larger than
    // this is not a real toggle, and buffering it unbounded would let one
    // request exhaust memory on a Pi.
    if (total > MAX_BODY_BYTES) {
      const err = new Error("request body too large")
      err.statusCode = 413
      throw err
    }
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")
}

export function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(payload))
}

export function sendHtml(res, status, html) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" }).end(html)
}

export function sendText(res, status, text) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" }).end(text)
}

// routes: [{ method, path, body?, handler }]
//
//   method  — "GET" or "POST"
//   path    — exact pathname, query string ignored
//   body    — true to parse a JSON body and pass it as `body`; a malformed
//             body is answered 400 before the handler ever runs, so no
//             handler has to repeat that check
//   handler — async ({ req, res, url, body }) => void
//
// The handler owns its own response. Anything it throws is caught by the
// backstop below and answered 500.
export function createInterestServer({
  name = "interest-server",
  port,
  host = "127.0.0.1",
  routes,
}) {
  if (!Array.isArray(routes) || routes.length === 0) {
    throw new Error("createInterestServer: needs at least one route")
  }

  async function handleRequest(req, res) {
    // A relative req.url needs a base to parse against; the host here is a
    // throwaway, only pathname and searchParams are ever read.
    let url
    try {
      url = new URL(req.url, "http://localhost")
    } catch {
      sendJson(res, 400, { error: "malformed request URL" })
      return
    }

    const route = routes.find(
      (r) => r.method === req.method && r.path === url.pathname
    )
    if (!route) {
      res.writeHead(404).end()
      return
    }

    let body
    if (route.body) {
      try {
        body = await readJsonBody(req)
      } catch (err) {
        if (err.statusCode === 413) {
          sendJson(res, 413, { error: "request body too large" })
          return
        }
        sendJson(res, 400, { error: "invalid JSON body" })
        return
      }
    }

    await route.handler({ req, res, url, body })
  }

  // Nothing below the handler is allowed to take the process down. An async
  // handler that throws becomes an unhandled rejection, which Node turns
  // into an immediate exit — so a single bad request, or one unreadable
  // file, used to kill the server outright rather than failing the one
  // request. This is the backstop; each route's own validation stops the
  // known ways in.
  const server = createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      console.error(`${name}: request failed:`, err)
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" })
      }
      res.end(JSON.stringify({ error: "internal error" }))
    })
  })

  return {
    server,
    listen(cb) {
      server.listen(port, host, () => {
        console.log(`${name} listening on ${host}:${port}`)
        if (cb) cb()
      })
      return server
    },
  }
}
