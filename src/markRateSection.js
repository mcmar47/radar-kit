// The disk-reading half of the fleet mark-rate report (see markRate.js):
// resolve each radar's logs/digest-runs.json + interested.json +
// ignored.json, build the report, and hand it to feed-radar's digest as an
// `extraSection`-shaped { read }.
//
// Gated to once every ~7 days via a small Pi-local state file so it rides
// only one feed-radar digest a week. The gate is elapsed time since the
// last delivery, not day-of-week, so a feed-radar run that fails or is late
// just slips the report by a day rather than skipping the week. The state
// file is not load-bearing — losing it means at most one extra report on
// the next run — so pi-bootstrap does not back it up (same call as
// logs/digest-runs.json itself).
//
// Dependency-free beyond node:fs — never import @opencode-ai/plugin here,
// same as researchDesk.js, so feed-tools.js can pull it from the barrel.

import { readFile } from "node:fs/promises"
import path from "node:path"
import { buildMarkRateReport, INBOX_SHIPPED_ISO } from "./markRate.js"
import { readMarks } from "./markStore.js"
import { writeFileAtomic } from "./atomicWrite.js"

const DAY_MS = 24 * 60 * 60 * 1000
// A run exactly a week after the last one may fire a few minutes earlier;
// 2h of slack keeps the cadence at "every feed-radar run 7 days on" rather
// than occasionally slipping to 8.
const MIN_INTERVAL_SLACK_MS = 2 * 60 * 60 * 1000

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"))
  } catch (err) {
    if (err.code === "ENOENT") return fallback
    throw err
  }
}

/**
 * @param {object} opts
 * @param {{name:string, dir:string}[]} opts.radarDirs  absolute repo dirs to read
 * @param {string} [opts.sinceIso]        the trend anchor
 * @param {number} [opts.minIntervalDays=7]
 * @param {string} [opts.stateFileName="logs/mark-rate.json"]  relative to the digest's own dir
 * @param {() => number} [opts.now]       injectable clock, epoch ms
 * @returns {{read: (dir:string) => Promise<{id,html,text,onDelivered}|null>}}
 */
export function createMarkRateSection({
  radarDirs = [],
  sinceIso = INBOX_SHIPPED_ISO,
  minIntervalDays = 7,
  stateFileName = "logs/mark-rate.json",
  now = () => Date.now(),
} = {}) {
  return {
    read: async (dir) => {
      const statePath = path.join(dir, stateFileName)
      const nowMs = now()

      const state = await readJson(statePath, {})
      const lastSent = Date.parse(state?.lastSentAt ?? "")
      if (
        !Number.isNaN(lastSent) &&
        nowMs - lastSent < minIntervalDays * DAY_MS - MIN_INTERVAL_SLACK_MS
      ) {
        return null
      }

      const radars = []
      for (const { name, dir: repoDir } of radarDirs) {
        const [runs, interested, ignored] = await Promise.all([
          readJson(path.join(repoDir, "logs/digest-runs.json"), []),
          readMarks(path.join(repoDir, "interested.json")),
          readMarks(path.join(repoDir, "ignored.json")),
        ])
        radars.push({ name, runs, interested, ignored })
      }

      const report = buildMarkRateReport({ radars, sinceIso, now: nowMs })

      return {
        id: "mark-rate",
        html: report.html,
        text: report.text,
        onDelivered: async () => {
          try {
            await writeFileAtomic(
              statePath,
              JSON.stringify({ lastSentAt: new Date(nowMs).toISOString() }, null, 2) + "\n",
              { ensureDir: true }
            )
          } catch (err) {
            // Best-effort: a failed state write just means the report may
            // ride the next run too. Never fail a sent digest over it.
            console.error("markRateSection: could not write state file:", err)
          }
        },
      }
    },
  }
}
