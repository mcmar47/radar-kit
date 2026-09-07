// Compose several `extraSection`-shaped `{ read }` objects into one, for a
// digest that folds in more than a single section. feed-radar carries two:
// the Overnight Research Desk answer (researchDesk.js) and the weekly fleet
// mark-rate report (markRateSection.js).
//
// Each section's `read(dir)` is called in turn; the non-null results are
// concatenated in order, and `onDelivered` fans out to every section that
// produced content. If every section returns null the combined read returns
// null, so the digest's "nothing extra today" path is exactly as before.
//
// A section whose `read` throws is logged and skipped — one section's bad
// day never suppresses another's, and never fails the digest. (digestTools
// also wraps the whole combined read in its own try/catch as a backstop.)

export function combineExtraSections(sections = []) {
  return {
    read: async (dir) => {
      const parts = []
      for (const section of sections) {
        if (typeof section?.read !== "function") continue
        try {
          const result = await section.read(dir)
          if (result) parts.push(result)
        } catch (err) {
          console.error("combineExtraSections: a section's read() failed:", err)
        }
      }
      if (parts.length === 0) return null

      const id = parts.map((p) => p.id).filter(Boolean).join("+")
      return {
        ...(id ? { id } : {}),
        html: parts.map((p) => p.html ?? "").join(""),
        text: parts.map((p) => p.text ?? "").join(""),
        onDelivered: async () => {
          for (const part of parts) {
            if (typeof part.onDelivered !== "function") continue
            try {
              await part.onDelivered()
            } catch (err) {
              console.error("combineExtraSections: a section's onDelivered() failed:", err)
            }
          }
        },
      }
    },
  }
}
