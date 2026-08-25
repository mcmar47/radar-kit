import { tool } from "@opencode-ai/plugin/tool"
import { readJsonArray, writeJsonArray, deleteIfExists, makeKeyFn } from "./seenStore.js"

function fieldName(f) {
  return typeof f === "string" ? f : f.field
}

// A binary new-vs-duplicate check against a seen-*.json file, keyed by one
// or more normalized fields. Covers event-watch (title+date) and job-radar
// (company+title+link) — release-radar needs 3-way new/updated/unchanged
// classification instead, which is different enough to stay bespoke in that
// repo's own plugin rather than being forced through this shape.
export function createCheckDedupTool({ seenFileName, keyFields, argsShape, description }) {
  const keyOf = makeKeyFn(keyFields)
  const idFields = keyFields.map(fieldName)
  return tool({
    description,
    args: { candidates: tool.schema.array(argsShape) },
    execute: async ({ candidates }, context) => {
      const seen = await readJsonArray(context.directory, seenFileName)
      const seenKeys = new Set(seen.map(keyOf))
      const newOnes = []
      const duplicates = []
      for (const c of candidates) {
        if (seenKeys.has(keyOf(c))) duplicates.push(c)
        else newOnes.push(c)
      }
      return JSON.stringify(
        {
          new: newOnes,
          duplicates: duplicates.map((d) =>
            Object.fromEntries(idFields.map((f) => [f, d[f]]))
          ),
        },
        null,
        2
      )
    },
  })
}

// Appends new items to a seen-*.json file, skipping any exact key match as
// a final safety net, then deletes the staging file render_digest wrote.
// Covers event-watch's append_seen_events and job-radar's
// append_seen_postings — release-radar's equivalent needs to edit existing
// records in place for "updated" items, so it stays bespoke.
export function createAppendSeenTool({
  seenFileName,
  stagingFileName,
  keyFields,
  argsShape,
  description,
}) {
  const keyOf = makeKeyFn(keyFields)
  return tool({
    description,
    args: { items: tool.schema.array(argsShape) },
    execute: async ({ items }, context) => {
      const seen = await readJsonArray(context.directory, seenFileName)
      const seenKeys = new Set(seen.map(keyOf))
      let added = 0
      for (const item of items) {
        const k = keyOf(item)
        if (seenKeys.has(k)) continue
        seen.push(item)
        seenKeys.add(k)
        added++
      }
      await writeJsonArray(context.directory, seenFileName, seen)
      await deleteIfExists(context.directory, stagingFileName)
      return JSON.stringify(
        { previousCount: seen.length - added, added, newTotal: seen.length },
        null,
        2
      )
    },
  })
}
