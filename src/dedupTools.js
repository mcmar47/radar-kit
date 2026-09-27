import { tool } from "@opencode-ai/plugin/tool"
import {
  readJsonArray,
  deleteIfExists,
  makeKeyFn,
  readStagedItems,
  appendSeenItems,
} from "./seenStore.js"

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

// Appends the sent items to a seen-*.json file, skipping any exact key match
// as a final safety net, then deletes the staging file render_digest wrote.
// Covers event-watch's append_seen_events and job-radar's
// append_seen_postings — release-radar's equivalent needs to edit existing
// records in place for "updated" items, so it stays bespoke.
//
// The staging file is the source of truth, not the `items` argument: it is
// exactly what send_digest_email sent, whereas the argument is the model
// retyping every item, and one retyped title is a different dedup key (the
// item comes back as "new" on a later run). `items` is only used when there
// is no staging file, and any argument key the staging file doesn't contain
// is reported back rather than silently recorded. See seenStore.js.
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
      const staged = await readStagedItems(context.directory, stagingFileName)
      const source = staged ? "staging" : "args"
      const toAppend = staged ?? items
      const stagedKeys = new Set((staged ?? []).map(keyOf))
      const argsNotStaged = staged
        ? items.filter((it) => !stagedKeys.has(keyOf(it))).length
        : 0

      const result = await appendSeenItems({
        directory: context.directory,
        seenFileName,
        keyFields,
        items: toAppend,
      })
      await deleteIfExists(context.directory, stagingFileName)
      return JSON.stringify(
        { ...result, source, ...(argsNotStaged ? { argsNotStaged } : {}) },
        null,
        2
      )
    },
  })
}
