import { tool } from "@opencode-ai/plugin/tool"

// Generic — takes only { title, date } plus whatever else the caller passes
// through. Currently used by event-watch only; kept here (rather than
// inlined there) since any future date-gated repo (a conference CFP
// deadline tracker, say) would need exactly this and nothing repo-specific.
export function createFilterFutureEventsTool() {
  return tool({
    description:
      "Filter candidate events to only those strictly in the future, using the actual server clock — not a guessed or shell-command-derived date. Returns each candidate with keep=true/false and a reason. Discard anything with keep=false rather than second-guessing it.",
    args: {
      candidates: tool.schema.array(
        tool.schema
          .object({ title: tool.schema.string(), date: tool.schema.string() })
          .passthrough()
      ),
    },
    execute: async ({ candidates }) => {
      const today = new Date()
      today.setHours(0, 0, 0, 0)
      const results = candidates.map((c) => {
        const d = new Date(`${c.date}T00:00:00`)
        if (isNaN(d.getTime())) {
          return { ...c, keep: false, reason: "unparseable date" }
        }
        if (d.getTime() <= today.getTime()) {
          return { ...c, keep: false, reason: "date is today or in the past" }
        }
        return { ...c, keep: true, reason: null }
      })
      return JSON.stringify(
        { today: today.toISOString().slice(0, 10), results },
        null,
        2
      )
    },
  })
}
