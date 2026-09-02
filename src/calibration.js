// Turns the star / reject marks a person has actually clicked into a block
// of text a digest prompt can be calibrated against.
//
// Why this needs code rather than just a line in each prompt: the mark
// stores are keyed, not descriptive. event-watch's holds
// `"a reading|2026-09-01": true`, feed-radar's holds `"1405": true`. On its
// own that tells a model almost nothing — the useful signal is the *record*
// behind the key, which lives in a different file (seen-events.json,
// seen-releases.json, picks.json). Joining the two with the same key
// function the marks were written with is the whole job, and it is the same
// job in all four repos.
//
// This module is deliberately free of any @opencode-ai/plugin import so the
// interest-servers can share a package with it; the tool wrapper that does
// need the plugin lives in calibrationTool.js.

import { readMarks, markInfo } from "./markStore.js"

// Order a store's keys oldest-first by the mark's `at` timestamp, so a
// later `.slice(-limit)` keeps the most recent marks and renders them
// newest-last. Legacy marks (a bare `true`, no timestamp) sort as oldest
// and keep their original insertion order relative to each other — the
// best that can be done without a timestamp. This is the recency weighting
// the `{ at, via }` mark shape was added to enable: before it, feed-radar's
// numeric-string keys came back in numeric order, which is not chronological.
function keysByRecency(marks) {
  return Object.keys(marks).sort((a, b) => {
    const at = markInfo(marks[a]).at
    const bt = markInfo(marks[b]).at
    if (at === bt) return 0
    if (at === null) return -1
    if (bt === null) return 1
    return at < bt ? -1 : 1
  })
}

// A mark whose record can no longer be found — an event that aged out of
// seen-events.json, say — is dropped rather than rendered as a bare key.
// The key alone is not calibration, it is noise.
function joinMarks(markKeys, records, keyFn) {
  const byKey = new Map()
  for (const record of records) {
    const key = keyFn(record)
    // Keep the first record for a key; later duplicates are the same item.
    if (!byKey.has(key)) byKey.set(key, record)
  }
  return markKeys.map((k) => byKey.get(k)).filter(Boolean)
}

/**
 * Build the calibration block.
 *
 * @param {object[]} interested  marks read from the "interested" store
 * @param {object[]} ignored     marks read from the "ignored" store
 * @param {object[]} records     the seen-store the marks key into
 * @param {(record) => string} keyFn  the SAME key function the server used
 * @param {(record) => string} describe  one line per item, repo-specific
 * @param {number} limit         most recent N of each, newest last
 */
export function buildCalibrationBlock({
  interested = {},
  ignored = {},
  records = [],
  keyFn,
  describe,
  limit = 40,
} = {}) {
  if (typeof keyFn !== "function") {
    throw new Error("buildCalibrationBlock: keyFn is required")
  }
  if (typeof describe !== "function") {
    throw new Error("buildCalibrationBlock: describe is required")
  }

  const positives = joinMarks(keysByRecency(interested), records, keyFn).slice(-limit)
  const negatives = joinMarks(keysByRecency(ignored), records, keyFn).slice(-limit)

  // An empty block is not the same as no block. Saying "nothing has been
  // marked yet" out loud stops a model inventing a preference from silence,
  // which is the failure feed-radar's profile.md warns about in prose.
  if (positives.length === 0 && negatives.length === 0) {
    return [
      "## Calibration",
      "",
      "Nothing has been starred or rejected yet, so there is no behavioural",
      "signal to calibrate against. Do not infer preferences from this",
      "absence — treat the interest spec above as the only guide, and prefer",
      "the wider end of any range it gives you.",
    ].join("\n")
  }

  const lines = ["## Calibration", ""]
  lines.push(
    "These are real marks from past digests. They outrank the written spec",
    "above wherever the two disagree — the spec is what was predicted, this",
    "is what actually happened.",
    ""
  )

  if (positives.length > 0) {
    lines.push(`### Starred — ${positives.length} item${positives.length === 1 ? "" : "s"}`, "")
    lines.push("Strong positives. More like these.", "")
    for (const r of positives) lines.push(`- ${describe(r)}`)
    lines.push("")
  }

  if (negatives.length > 0) {
    lines.push(`### Rejected — ${negatives.length} item${negatives.length === 1 ? "" : "s"}`, "")
    lines.push(
      "Strong negatives, weighted more heavily than any unstarred item:",
      "someone read this one and actively said no.",
      ""
    )
    for (const r of negatives) lines.push(`- ${describe(r)}`)
    lines.push("")
  }

  // The distinction that stops every unstarred item being read as a
  // rejection — which would be badly wrong while marks are still sparse.
  lines.push(
    "An item that appears in neither list was simply never marked. That is",
    "not a negative signal and carries no information at all."
  )

  return lines.join("\n")
}

// Convenience wrapper: read both stores off disk, then build the block.
// Missing or empty stores are normal and produce the empty-state block.
export async function readCalibrationBlock({
  interestedPath,
  ignoredPath,
  records,
  keyFn,
  describe,
  limit,
}) {
  const [interested, ignored] = await Promise.all([
    interestedPath ? readMarks(interestedPath) : {},
    ignoredPath ? readMarks(ignoredPath) : {},
  ])
  return buildCalibrationBlock({ interested, ignored, records, keyFn, describe, limit })
}
