#!/usr/bin/env node
// Called by each digest agent's run wrapper to put a dollar figure in the
// scorecard footer. Two modes:
//
//   run-cost.js read
//       Print the inference key's lifetime USD usage (one number) to
//       stdout. The wrapper captures this before AND after the opencode run.
//
//   run-cost.js record <runsFile> <usageBefore> <runStartIso>
//       Read usage again (that's "after"), and write `after - before` onto
//       the run log via recordRunCost(). <runsFile> is the same
//       logs/digest-runs.json send_digest_email appends to.
//
// Every failure path exits 0 with a message on stderr: a cost figure is a
// nice-to-have on the footer and must never turn a delivered digest into a
// failed run. The wrapper also guards the call with `|| true`.

import path from "node:path"
import { readFile } from "node:fs/promises"
import { writeFileAtomic } from "../src/atomicWrite.js"
import { readOpencodeKey, keyUsage } from "../src/openrouterCost.js"
import { recordRunCost } from "../src/scorecard.js"

async function currentUsage() {
  const key = await readOpencodeKey()
  if (!key) {
    process.stderr.write("run-cost: no OpenRouter key in opencode's auth store — skipping\n")
    return null
  }
  try {
    return await keyUsage(key)
  } catch (err) {
    process.stderr.write(`run-cost: could not read OpenRouter usage (${err.message}) — skipping\n`)
    return null
  }
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"))
  } catch (err) {
    if (err.code === "ENOENT") return fallback
    throw err
  }
}

const [mode, runsFile, usageBefore, runStartIso] = process.argv.slice(2)

if (mode === "read") {
  const usage = await currentUsage()
  if (usage === null) process.exit(0)
  process.stdout.write(String(usage))
  process.exit(0)
}

if (mode === "record") {
  if (!runsFile) {
    process.stderr.write("run-cost: record needs <runsFile> — skipping\n")
    process.exit(0)
  }
  const before = Number(usageBefore)
  if (!Number.isFinite(before)) {
    process.stderr.write("run-cost: usageBefore was not a number — skipping\n")
    process.exit(0)
  }
  const after = await currentUsage()
  if (after === null) process.exit(0)

  const cost = after - before
  // <= 0 means we couldn't measure it — usually OpenRouter's usage total
  // hadn't caught up with the run's last generation when we sampled "after".
  // A real run is never free; writing "$0.00 last run" would just mislead.
  // The spend isn't lost: it lands in the next run's "before".
  if (!Number.isFinite(cost) || cost <= 0) {
    process.stderr.write(
      `run-cost: usage delta ${cost} — not measurable this run (before=${before}, after=${after}), skipping\n`
    )
    process.exit(0)
  }
  try {
    const runs = await readJson(runsFile, [])
    const next = recordRunCost(runs, cost, runStartIso)
    await writeFileAtomic(
      path.resolve(runsFile),
      JSON.stringify(next, null, 2) + "\n",
      { ensureDir: true }
    )
    process.stderr.write(`run-cost: recorded $${cost.toFixed(4)} for this run\n`)
  } catch (err) {
    process.stderr.write(`run-cost: could not update ${runsFile} (${err.message}) — skipping\n`)
  }
  process.exit(0)
}

process.stderr.write("usage: run-cost.js read | run-cost.js record <runsFile> <usageBefore> <runStartIso>\n")
process.exit(0)
