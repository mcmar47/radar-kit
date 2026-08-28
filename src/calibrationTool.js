import path from "node:path"
import { tool } from "@opencode-ai/plugin/tool"
import { readJsonArray, makeKeyFn } from "./seenStore.js"
import { readCalibrationBlock } from "./calibration.js"

// Exposes the calibration block as a tool the digest prompt can call.
//
// Every agent in this fleet writes star / reject marks through an
// interest-server, but until this existed only feed-radar's prompt did
// anything with them, and even there the mechanism was "the prompt tells
// the model to go and read three JSON files" — which is why feed-radar's
// profile.md described a Calibration section as "appended automatically at
// run time" that nothing actually appended. event-watch and release-radar
// collected marks that were never read by anything at all.
//
// `keyFields` must match the key the repo's interest-server writes with, or
// the join silently finds nothing and every run reports an empty block.
// That is the one way to get this wrong, so it is worth checking against
// the server when wiring a new repo up:
//
//   event-watch    ["title", "date"]
//   release-radar  ["watch", "type", "title"]
//   feed-radar     ["id"]  (Miniflux entry id, already unique)
export function createCalibrationTool({
  seenFileName,
  keyFields,
  describe,
  interestedFileName = "interested.json",
  ignoredFileName = "ignored.json",
  limit = 40,
  description = "Read the star/reject marks from past digests and return a calibration block. Call this before scoring anything, and treat what it returns as outranking the written interest spec.",
}) {
  const keyOf = makeKeyFn(keyFields)

  return tool({
    description,
    args: {},
    execute: async (_args, context) => {
      // The seen-store is the only part that must exist; a repo with no
      // marks yet is the normal early state, and readMarks handles a
      // missing store on its own.
      let records = []
      try {
        records = await readJsonArray(context.directory, seenFileName)
      } catch (err) {
        if (err.code !== "ENOENT") throw err
      }

      return readCalibrationBlock({
        interestedPath: path.join(context.directory, interestedFileName),
        ignoredPath: path.join(context.directory, ignoredFileName),
        records,
        keyFn: keyOf,
        describe,
        limit,
      })
    },
  })
}
