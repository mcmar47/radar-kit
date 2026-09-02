// A shared `GET /api/health` route for the long-running servers in this
// fleet — the three interest-servers and shelf-server.
//
// Why it exists: pi-ops has two watchdog mechanisms and both only cover the
// scheduled oneshots (a run's `OnFailure=` and a staleness check on its
// heartbeat file). A service that is supposed to be up *all the time* — a
// mark-writer, or shelf-server, which is the single writer of the one
// irreplaceable file — had nothing watching it at all. eink-app already
// solved this for itself with its own `/api/health`; this is that pattern
// made shareable so the other four don't each reinvent it.
//
// Modelled on eink-app's endpoint: unauthenticated (the response carries
// no keys, no config, just liveness and timestamps, so a curl check or an
// uptime probe needs no credential), plain JSON, and one `status` field
// worth alerting on.
//
// Plugin-free, like markStore.js and interestServer.js — a server imports
// it via "radar-kit/health" and never pulls @opencode-ai/plugin. See
// interestServer.js's note.

import { sendJson } from "./interestServer.js"

// Process start, captured at import. `uptimeSec` in the response is the
// cheapest possible "did this process just restart?" signal.
const startedAt = Date.now()

/**
 * Build the health route.
 *
 * @param {string} name  service name, echoed in the response
 * @param {() => (Check[] | Promise<Check[]>)} checks
 *        optional. Each `Check` is `{ name, ok, detail? }`. Any `ok: false`
 *        turns the overall status "degraded" and the response code 503, so
 *        a probe that only looks at the status line still catches it. A
 *        throw from `checks` is caught and reported as a single failed
 *        check rather than 500-ing the endpoint.
 * @param {string} path  route path, default "/api/health"
 */
export function createHealthRoute({ name, checks = null, path = "/api/health" }) {
  return {
    method: "GET",
    path,
    handler: async ({ res }) => {
      let results = []
      if (checks) {
        try {
          results = (await checks()) ?? []
        } catch (err) {
          results = [
            { name: "checks", ok: false, detail: String(err?.message ?? err) },
          ]
        }
      }

      const ok = results.every((c) => c && c.ok)
      sendJson(res, ok ? 200 : 503, {
        status: ok ? "ok" : "degraded",
        name,
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        now: new Date().toISOString(),
        ...(results.length ? { checks: results } : {}),
      })
    },
  }
}

/**
 * A ready-made check: every named store in a `createMarkStore()` instance
 * reads back without throwing. `readMarks` quarantines a corrupt store and
 * carries on, so this mostly catches a filesystem-level problem (a
 * permissions change, an unreadable mount) — the kind of failure where the
 * process is up but its writes are silently going nowhere.
 */
export function markStoreCheck(marks) {
  return async () => {
    const out = []
    for (const store of marks.names) {
      try {
        await marks.read(store)
        out.push({ name: `store:${store}`, ok: true })
      } catch (err) {
        out.push({
          name: `store:${store}`,
          ok: false,
          detail: String(err?.message ?? err),
        })
      }
    }
    return out
  }
}
