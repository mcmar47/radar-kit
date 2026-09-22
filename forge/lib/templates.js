// Radar Forge's template layer — pure functions from a filled-in profile
// to file contents. No fs here; forge/create-radar.js does all the writing.
//
// What's templated vs. left as a TODO for the person follows FUTURE-PROJECTS.md
// #9's own restraint: standardize the parts that were genuinely identical
// across event-watch / job-radar / release-radar / feed-radar / serendipity-radar
// / prize-radar / skyline-radar (the wrapper shape, the CLAUDE.md "scheduling
// lives on the Pi" section, the record_outcome / generatedAt-advanced
// completion guard, the mark-key-as-exported-code contract) and leave the
// genuinely domain-specific parts (the search prompt, the store's real
// fields, what counts as "changed") as clearly marked TODOs rather than
// guessing at them.

const SCHEDULING_SECTION = `## Scheduling lives on the Pi — never on the Mac

The Pi (\`continuum\`) is the canonical and only home for scheduled agent runs.
When working in this repo, never:

- register a macOS **LaunchAgent** or drop a \`.plist\` into \`~/Library/LaunchAgents\`
- \`launchctl load\` / \`launchctl bootstrap\` any \`.plist\`
- add a \`cron\`, \`at\`, or other login/startup item on the Mac
- wire \`launchd/run-{{NAME}}-opencode.sh\` (or any agent run) into a local scheduler

The \`launchd/\` directory is dead history, kept for reference only — the Pi's systemd timer is
what actually runs. If something needs scheduling, add a systemd unit + timer under \`pi-ops\`
and deploy it to the Pi. See \`pi-ops/FLEET.md\`.
`

function fillName(str, name) {
  return str.replaceAll("{{NAME}}", name)
}

export function buildFiles(opts) {
  const {
    name, // kebab, e.g. "signal-radar"
    camel, // e.g. "signalRadar"
    pascal, // e.g. "SignalRadar"
    description,
    archetype, // "server" | "static"
    keyFields, // string[]
    keyFieldsJs, // JS array literal string
    port, // number | null (server only)
    model,
    onCalendar, // systemd OnCalendar value
    cadenceNote, // one-line human explanation of the chosen slot
    delivery, // "digest" | "static-board" | "none"
    pluginPin, // @opencode-ai/plugin version string to pin
  } = opts

  const isServer = archetype === "server"
  const files = {}

  // ---------------------------------------------------------------------
  // .gitignore
  // ---------------------------------------------------------------------
  {
    let lines = [
      "node_modules/",
      "logs/",
      ".DS_Store",
      "",
      "# radar-kit is pinned only by `github:mcmar47/radar-kit` (no tag) — a",
      "# committed lock pins a commit, and update-radar-kit.sh moves the fleet to",
      "# HEAD anyway, so a stale lock would make a disaster-recovery `npm install`",
      "# resolve a broken old radar-kit. Same reasoning as every other repo.",
      ".opencode/package-lock.json",
    ]
    if (isServer) {
      lines.push(
        "server/package-lock.json",
        "",
        `# The ${name} store + mark files. Pi-local and gitignored — same`,
        "# decoupling every interest-server's mark files use (no scheduled git",
        "# pull/commit racing a write in the same working copy). pi-bootstrap",
        "# backs these up weekly through the generic AGENT_REPOS loop — see",
        "# DEPLOY-CHECKLIST.md.",
        `data/${camel}.json`,
        "interested.json",
        "ignored.json",
        "reviewed.json",
        "",
        "# Crash-safety artifacts from writeFileAtomic: the temp file an atomic",
        "# write renames into place, and any store quarantined after failing to",
        "# parse.",
        `data/${camel}.json.*`,
        "interested.json.*",
        "ignored.json.*",
        "reviewed.json.*"
      )
    } else {
      lines.push(
        "",
        "# data/state.json and data/digest.json are git-committed, NOT gitignored",
        "# — this archetype has no server and no Pi-local store; the weekly run",
        "# commits+pushes them itself, the same posture as prize-radar/skyline-radar."
      )
    }
    files[".gitignore"] = lines.join("\n") + "\n"
  }

  // ---------------------------------------------------------------------
  // package.json / opencode.json / .opencode/package.json
  // ---------------------------------------------------------------------
  files["package.json"] = JSON.stringify(
    {
      name,
      version: "0.1.0",
      type: "module",
      private: true,
      description,
      scripts: { test: "node --test" },
    },
    null,
    2
  ) + "\n"

  files["opencode.json"] = JSON.stringify(
    { $schema: "https://opencode.ai/config.json", model },
    null,
    2
  ) + "\n"

  files[".opencode/package.json"] = JSON.stringify(
    {
      type: "module",
      dependencies: {
        "@opencode-ai/plugin": pluginPin,
        "radar-kit": "github:mcmar47/radar-kit",
      },
    },
    null,
    2
  ) + "\n"

  if (isServer) {
    files["server/package.json"] = JSON.stringify(
      {
        name: `${name}-server`,
        version: "0.1.0",
        type: "module",
        private: true,
        dependencies: { "radar-kit": "github:mcmar47/radar-kit" },
      },
      null,
      2
    ) + "\n"
  }

  // ---------------------------------------------------------------------
  // src/<camel>Key.js — THE forge restraint: every radar ships its
  // mark-key function as exported code, never a convention reimplemented
  // per caller. See FUTURE-PROJECTS.md #9's "one piece of evidence it
  // should already absorb."
  // ---------------------------------------------------------------------
  files[`src/${camel}Key.js`] = `// The mark-key for ${name} — turns a record into the same string its
// mark routes${isServer ? " (server/server.js)" : ""}, its calibration join, and radar-kit's
// mark-rate / quality-lab readers all key by. Exported as code, not left
// as a convention each caller reimplements inline — every radar built
// before Radar Forge invented its own key in 2-3 places and the shapes
// drifted (radar-kit CLAUDE.md, FUTURE-PROJECTS.md #9). Every module in
// this repo that needs a key imports keyOf from here; nothing redefines it.
//
// TODO: KEY_FIELDS was set from --key-fields at generation time. Revisit
// it if the fields that make a record unique turn out to be wrong — e.g.
// two genuinely different records collapsing onto one key, or the same
// real-world item getting two different keys because of formatting drift
// in one field (that's what makeKeyFn's normalization exists to prevent,
// but only for the fields you actually list here).
//
// If this radar's real identity is a single exact field (an id, not a
// human-typed title) rather than a normalized combination — see
// feed-radar's \`{ field: "id", exact: true }\` shape in radar-kit's
// README "Calibration" table — replace makeKeyFn's argument accordingly;
// the generator does not guess at that, it only wires the common case.

import { makeKeyFn } from "radar-kit/seenStore"

export const KEY_FIELDS = ${keyFieldsJs}

export const keyOf = makeKeyFn(KEY_FIELDS)
`

  // ---------------------------------------------------------------------
  // src/<camel>Store.js — pure logic skeleton (genuinely domain-specific;
  // generated as a well-commented starting shape, not full logic).
  // ---------------------------------------------------------------------
  if (isServer) {
    files[`src/${camel}Store.js`] = `// Pure operations on the ${name} store — TODO: decide the store shape.
//
// The proven default (serendipity-radar, built by hand before this
// generator existed) is a FLAT ARRAY of records, each carrying its own
// batch/generated/delivered stamps inline — NOT a { batches: [...] }
// wrapper. A nested-batch wrapper breaks radar-kit's mark-rate report
// (Array.isArray check) and throws in its calibration tool (a for...of
// over a plain object). Keep this flat unless you have a specific reason
// not to; if you do, you are on your own for compatibility with
// radar-kit/markRate and radar-kit/calibration — re-read
// serendipity-radar/src/discoveries.js's header comment first.
//
// server/server.js is this store's single writer, over HTTP — this module
// holds the state transitions so they're unit-testable without a running
// process (mirrors research-desk/src/desk.js and
// serendipity-radar/src/discoveries.js's split). Keep this file free of
// any radar-kit / @opencode-ai/plugin import — pure logic only, same
// discipline every sibling repo's src/ holds to.

import { keyOf } from "./${camel}Key.js"

const MAX_RECORDS = 200

export class ${pascal}Error extends Error {
  constructor(message, statusCode = 400) {
    super(message)
    this.statusCode = statusCode
  }
}

export function emptyStore() {
  return []
}

export function normalizeStore(raw) {
  return Array.isArray(raw) ? raw.filter((r) => r && typeof r.id === "string") : emptyStore()
}

function newBatchId(now) {
  return \`b-\${now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}\`
}

/**
 * TODO: fill in the real validation for this radar's record shape — this
 * starting point only checks the fields keyOf() needs to exist, dedupes by
 * keyOf against the WHOLE store (delivered or not, mirroring
 * serendipity-radar's addBatch), assigns id/batchId/generatedAt, and caps
 * the store at MAX_RECORDS.
 */
export function addBatch(records, newItems, { now = new Date() } = {}) {
  if (!Array.isArray(newItems) || newItems.length === 0) {
    throw new ${pascal}Error("expected a non-empty array of records")
  }

  const existingKeys = new Set(records.map(keyOf))
  const batchId = newBatchId(now)
  const generatedAt = now.toISOString()
  const appended = []
  let skipped = 0

  for (const item of newItems) {
    // TODO: validate this radar's required fields here (mirror
    // KEY_FIELDS at minimum — a record missing a key field can never be
    // matched back to a mark).
    const key = keyOf(item)
    if (existingKeys.has(key)) {
      skipped++
      continue
    }
    existingKeys.add(key)
    appended.push({
      id: \`\${batchId}:\${appended.length}\`,
      batchId,
      generatedAt,
      deliveredAt: null,
      ...item,
    })
  }

  if (appended.length === 0) {
    throw new ${pascal}Error("every record in this batch was already known")
  }

  let merged = [...records, ...appended]
  if (merged.length > MAX_RECORDS) {
    merged = merged.slice(merged.length - MAX_RECORDS)
  }

  return { records: merged, batchId, added: appended.length, skipped }
}

/** Stamp every record in a batch as delivered. Idempotent. */
export function markDelivered(records, batchId, { now = new Date() } = {}) {
  if (!batchId) throw new ${pascal}Error("batchId is required")
  let count = 0
  const next = records.map((r) => {
    if (r.batchId !== batchId || r.deliveredAt) return r
    count++
    return { ...r, deliveredAt: now.toISOString() }
  })
  if (count === 0 && !records.some((r) => r.batchId === batchId)) {
    throw new ${pascal}Error(\`no batch with id \${batchId}\`, 404)
  }
  return { records: next, count }
}
`
  } else {
    files[`src/${camel}Store.js`] = `// Pure logic for ${name} — TODO: fill in the real "what changed" rule for
// this domain.
//
// The one rule that matters, proven by prize-radar and skyline-radar
// (the two static-board radars built before this generator existed):
// **"changed this run" is computed here, never self-reported by the
// model.** classifyChange below should compare only the fields that are a
// genuine state transition — never a free-text summary/description field,
// which a model rewords every run even when nothing substantive moved.
// Getting this wrong means every weekly run reports "changed" and the
// digest section / board never goes quiet on an unremarkable week.
//
// No file I/O in this module — src/${camel}Key.js's keyOf is the only
// import allowed here, and it stays free of radar-kit /
// @opencode-ai/plugin so it's unit-testable with nothing installed.

import { keyOf } from "./${camel}Key.js"

/**
 * TODO: compare \`prior\` and \`next\` (both the same record shape, keyed by
 * keyOf) and return { changed: boolean, changeTag: string, fields: [...] }.
 * Exclude any prose/summary field from the comparison — see header above.
 */
export function classifyChange(prior, next) {
  if (!prior) return { changed: true, changeTag: "new", fields: [] }
  // TODO: replace with real field-by-field comparison for this domain.
  const changed = JSON.stringify(prior) !== JSON.stringify(next)
  return { changed, changeTag: changed ? "updated" : "unchanged", fields: [] }
}

/**
 * TODO: build the persisted state file (every tracked record, carried
 * forward across runs — see prize-radar's buildStateFile for the pattern:
 * a record proposed-but-unchanged still gets carried forward, not dropped).
 */
export function buildStateFile({ priorRecords = [], proposed = [], now = new Date() } = {}) {
  const priorByKey = new Map(priorRecords.map((r) => [keyOf(r), r]))
  const records = proposed.map((next) => {
    const prior = priorByKey.get(keyOf(next)) ?? null
    const { changed, changeTag } = classifyChange(prior, next)
    return { ...next, changedThisRun: changed, changeTag }
  })
  return { generatedAt: now.toISOString(), records }
}

/**
 * TODO: build the small "what changed this run" digest object that feeds
 * either the feed-radar extraSection or the public board — headline/dek/
 * movements, in prize-radar's shape, or whatever this domain's equivalent is.
 */
export function buildDigestFile({ headline, dek, movements = [], nextCheck, now = new Date() } = {}) {
  return { generatedAt: now.toISOString(), headline, dek, movements, nextCheck }
}
`
  }

  return files
}

export { SCHEDULING_SECTION, fillName }
