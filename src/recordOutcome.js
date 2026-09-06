// The "silent stall" guard, shared.
//
// `opencode run` exits 0 even when the model abandons a run mid-pipeline —
// the LLM stream just stops before the digest is ever rendered. Nothing is
// left in the staging file (new-releases.json / new-postings.json), so the
// render-but-no-send guard can't see it, and it looks identical to a
// legitimate "nothing new today" run.
//
// The fix, first built inline in event-watch and factored out here for
// release-radar and job-radar: a tool the prompt calls as its final action
// on BOTH clean paths (digest sent *or* nothing new) and never on an
// aborted one. The wrapper deletes the outcome file before the run and
// fails the run — firing `agent-alert@` — if it is still absent after a
// clean exit.
//
// Like dedupTools.js and digestTools.js this reaches `@opencode-ai/plugin`,
// so it is only ever re-exported from index.js, never a bare subpath.
// event-watch keeps its own equivalent copy (it predates this and its
// wrapper guard is identical in effect); the two need not be merged.

import { tool } from "@opencode-ai/plugin/tool"
import path from "node:path"
import { writeFileAtomic } from "./atomicWrite.js"

export const DEFAULT_OUTCOME_FILE = "logs/run-outcome.json"

const DEFAULT_DESCRIPTION =
  "Record that this run reached a definite conclusion. Call exactly once, as the very last action, on BOTH clean paths: after the digest was sent and the store updated, OR at the end of a run that correctly found nothing new and sent nothing. Do NOT call it if you are stopping early because a step failed (e.g. send_digest_email errored twice) — an uncalled record_outcome is exactly how the scheduler detects an abandoned run and fires its alert."

/**
 * @param {object} [opts]
 * @param {string} [opts.outcomeFileName]  path relative to the project dir;
 *        per-cadence repos pass e.g. "logs/run-outcome-weekly.json"
 * @param {string} [opts.description]  override the default tool description
 */
export function createRecordOutcomeTool({
  outcomeFileName = DEFAULT_OUTCOME_FILE,
  description = DEFAULT_DESCRIPTION,
} = {}) {
  return tool({
    description,
    args: {
      sent: tool.schema.boolean(),
      count: tool.schema.number(),
      note: tool.schema.string(),
    },
    execute: async ({ sent, count, note }, context) => {
      const record = {
        timestamp: new Date().toISOString(),
        sent,
        count,
        note,
      }
      await writeFileAtomic(
        path.join(context.directory, outcomeFileName),
        JSON.stringify(record, null, 2) + "\n",
        { ensureDir: true }
      )
      return `Outcome recorded: ${JSON.stringify(record)}`
    },
  })
}
