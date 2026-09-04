// One-time repair for the marks written before markStore.js started
// recording { at, via } (radar-kit 1.7.0, shipped 2026-09-02, commit
// 7b7b9ab). A mark set before that is a bare `true`, which makes it
// invisible to scorecard.js's trailing-window count and unordered in
// calibration.js's recency sort.
//
// This script joins each bare-`true` key back to its record in the repo's
// seen/picks store — the SAME key function the repo's interest-server
// uses to write that key in the first place — and takes the record's own
// date as an approximate mark time. That date is clamped so it can never
// land after ROLLOUT_CUTOFF: every legacy mark provably predates the code
// that started timestamping marks, so a record date after that boundary
// (an event still in the future, a release-radar row whose last_updated
// was bumped by an unrelated re-classification) would otherwise produce a
// mark that claims to have happened after it possibly could have — which
// would then make scorecard.js's "marks in the trailing N days" window
// look artificially fresh forever. Clamping means "known to be legacy,
// exact date unrecoverable" degrades to "as of the rollout boundary",
// never to a fabricated recent date.
//
// Idempotent and safe to re-run: a mark that already carries { at, via }
// is left untouched, and a key with no matching record is left as bare
// `true` rather than guessed at.
//
// Run from inside the CONSUMING repo's server/ directory (not from here),
// so `radar-kit/markStore` and `radar-kit/seenStore` resolve through that
// repo's own node_modules — same resolution every interest-server already
// relies on. See the repo table below for BACKFILL_REPO values.
//
//   cd ~/Projects/feed-radar/server
//   BACKFILL_REPO=feed-radar node /tmp/backfill-mark-dates.js --dry-run
//   BACKFILL_REPO=feed-radar node /tmp/backfill-mark-dates.js
//
// job-radar is not listed: it has zero marks in either store as of
// 2026-09-03, so there is nothing for this script to do there.

import path from "node:path"
import { readMarks, writeMarks } from "radar-kit/markStore"
import { readJsonArray, makeKeyFn } from "radar-kit/seenStore"

// The instant radar-kit 1.7.0's markStore.js started writing { at, via }.
// No bare-`true` mark can be genuinely newer than this.
const ROLLOUT_CUTOFF = Date.parse("2026-09-02T00:00:00.000Z")

const CONFIGS = {
  "feed-radar": {
    recordsFile: "picks.json",
    // Miniflux entry id, matching interest-server.js's normalizeId.
    keyOf: (r) => String(r.id),
    // The digest-send date append_picks stamped on the pick.
    dateOf: (r) => r.sent,
  },
  "event-watch": {
    recordsFile: "seen-events.json",
    // Matches interest-server.js's keyOf = makeKeyFn(["title", "date"]).
    keyOf: makeKeyFn(["title", "date"]),
    // The event's own date. Often in the future relative to when it was
    // starred, which is exactly what ROLLOUT_CUTOFF exists to bound.
    dateOf: (r) => r.date,
  },
  "release-radar": {
    recordsFile: "seen-releases.json",
    // Matches interest-server.js's keyOf = makeKeyFn(["watch","type","title"]).
    keyOf: makeKeyFn(["watch", "type", "title"]),
    dateOf: (r) => r.last_updated,
  },
}

const repoName = process.env.BACKFILL_REPO
const config = CONFIGS[repoName]
if (!config) {
  console.error(`Set BACKFILL_REPO to one of: ${Object.keys(CONFIGS).join(", ")}`)
  process.exit(1)
}

const dryRun = process.argv.includes("--dry-run")
// server/ -> repo root, same as every interest-server.js's REPO_DIR.
const REPO_DIR = path.join(process.cwd(), "..")

const records = await readJsonArray(REPO_DIR, config.recordsFile)
const byKey = new Map()
for (const r of records) {
  const k = config.keyOf(r)
  if (!byKey.has(k)) byKey.set(k, r) // first record wins, same as calibration.js's joinMarks
}

async function backfillStore(fileName) {
  const storePath = path.join(REPO_DIR, fileName)
  const marks = await readMarks(storePath)
  let changed = 0
  let alreadyDated = 0
  let unjoined = 0
  const unjoinedKeys = []

  for (const [key, value] of Object.entries(marks)) {
    if (value && typeof value === "object") {
      alreadyDated++
      continue
    }
    const record = byKey.get(key)
    if (!record) {
      unjoined++
      unjoinedKeys.push(key)
      continue
    }
    const raw = config.dateOf(record)
    const parsed = raw ? Date.parse(raw) : NaN
    if (Number.isNaN(parsed)) {
      unjoined++
      unjoinedKeys.push(key)
      continue
    }
    const at = new Date(Math.min(parsed, ROLLOUT_CUTOFF)).toISOString()
    marks[key] = { at, via: "backfill" }
    changed++
  }

  console.log(
    `${fileName}: ${changed} backfilled, ${alreadyDated} already dated, ` +
      `${unjoined} left as legacy true (no joinable record)` +
      (unjoinedKeys.length ? ` [${unjoinedKeys.join(", ")}]` : "")
  )

  if (changed > 0 && !dryRun) {
    await writeMarks(storePath, marks)
  }
}

console.log(`${repoName}${dryRun ? " (dry run)" : ""} — records: ${records.length}`)
await backfillStore("interested.json")
await backfillStore("ignored.json")
