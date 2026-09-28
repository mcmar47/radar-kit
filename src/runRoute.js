// POST /api/run: start a radar's scheduled run now instead of waiting for its
// timer. The "run a radar early" gap from GPT-SUGGESTIONS #8 (Tailnet Command
// Palette), built 2026-09-28 as one route on each radar's own interest-server
// rather than a new app. Callers: curl over the tailnet, an iOS Shortcut, or
// (someday) a Fleet Deck key.
//
//   curl -X POST -H 'content-type: application/json' http://continuum...:<port>/api/run
//
// It starts the radar's systemd oneshot with `sudo -n systemctl start
// --no-block`, the same way research-desk's server triggers its on-demand run
// (this process runs as mcmar, who has passwordless sudo on the Pi; -n fails
// fast instead of hanging if that ever changes). --no-block matters: a oneshot's
// plain `start` waits for the whole run, up to 45 minutes.
//
// A run is paid (an LLM agent) and sends a real digest email, so the route is
// guarded against the accidental cases:
//   - 415 unless the request says content-type: application/json. A plain
//     form or text POST from some web page open on a tailnet device would be a
//     "simple" cross-origin request that the browser sends without asking;
//     requiring JSON forces a CORS preflight this server never answers, so the
//     browser never sends the POST at all.
//   - 409 if the unit is already running (systemd would coalesce the start
//     anyway, but saying so beats a silent no-op).
//   - 429 within `cooldownMinutes` of the last trigger from this route, so a
//     double tap or a retry loop can't queue up back-to-back paid runs.
//
// Plugin-free, like the other route modules: a server imports it via
// "radar-kit/runRoute".

import { execFile } from "node:child_process"
import { sendJson } from "./interestServer.js"

function runCommand(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15_000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout).trim(), stderr: String(stderr).trim() })
    })
  })
}

/**
 * @param {object} opts
 * @param {string} opts.unit              systemd unit to start, e.g. "event-watch.service"
 * @param {number} [opts.cooldownMinutes] minimum gap between triggers (default 30)
 * @param {Function} [opts.run]           (cmd, args) => Promise<{code, stdout, stderr}>; injectable for tests
 * @param {Function} [opts.now]           () => epoch ms; injectable for tests
 */
export function createRunRoute({ unit, cooldownMinutes = 30, run = runCommand, now = Date.now } = {}) {
  if (!unit || !/^[A-Za-z0-9@._-]+\.service$/.test(unit)) {
    throw new Error(`createRunRoute: unit must be a plain *.service name, got ${JSON.stringify(unit)}`)
  }
  let lastTriggeredAt = null

  return {
    method: "POST",
    path: "/api/run",
    handler: async ({ req, res }) => {
      const ctype = String(req.headers["content-type"] || "").toLowerCase()
      if (!ctype.startsWith("application/json")) {
        sendJson(res, 415, { error: "send content-type: application/json" })
        return
      }

      const t = now()
      if (lastTriggeredAt !== null && t - lastTriggeredAt < cooldownMinutes * 60_000) {
        const retryAfterSec = Math.ceil((lastTriggeredAt + cooldownMinutes * 60_000 - t) / 1000)
        sendJson(res, 429, { error: `triggered less than ${cooldownMinutes} minutes ago`, unit, retryAfterSec })
        return
      }

      const state = (await run("systemctl", ["is-active", unit])).stdout
      if (state === "active" || state === "activating") {
        sendJson(res, 409, { error: "already running", unit, state })
        return
      }

      const started = await run("sudo", ["-n", "systemctl", "start", "--no-block", unit])
      if (started.code !== 0) {
        sendJson(res, 500, { error: "could not start the run", unit, detail: started.stderr.slice(0, 200) })
        return
      }
      lastTriggeredAt = t
      sendJson(res, 202, { ok: true, unit, started: new Date(t).toISOString() })
    },
  }
}
