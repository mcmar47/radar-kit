// A second, looser dedup check for check_dedup, on top of the exact key.
//
// The exact key (e.g. event-watch's title+date) only catches a candidate the
// model titles identically each run, and it doesn't: one Little Theatre NT
// Live screening went into seen-events.json five times as "NT Live: The
// Misanthrope", "The Misanthrope (NT Live)", "The Misanthrope (National
// Theatre Live)", ... (2026-10-18; 60 such pairs across the store, theatre
// worst). Every rewording is a new key, so it came back as "new".
//
// The rule, tuned against that store: same date (or whatever `sameFields`
// says), and one title's significant words are a subset of the other's, and
// the shorter has at least half as many words as the longer. "Significant"
// drops `stopWords`, years, bare numbers and one-letter tokens. Subset rather
// than plain overlap on purpose: overlap also merged genuinely different
// events sharing a series name ("November Nitrate Weekend: Hamlet" vs
// "...: Daisy Kenyon", "Greek Peak Fall Fest" vs "Peek'n Peak Fall Fest").
// A miss only costs one repeat row; a false merge hides a real event, so it
// errs toward the miss.

const BASE_STOP_WORDS = ["the", "a", "an", "and", "of", "at", "in", "on", "for", "with", "to", "by", "from", "vs"]

export function significantWords(title, stopWords) {
  const words = String(title ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .replace(/['’]/g, "")
    .match(/[a-z0-9]+/g) ?? []
  return new Set(
    words.filter(
      (w) =>
        w.length > 1 &&
        !stopWords.has(w) &&
        !/^(19|20)\d\d$/.test(w) &&
        !/^\d+(st|nd|rd|th)?$/.test(w)
    )
  )
}

export function makeNearDuplicateFn({
  titleField = "title",
  sameFields = ["date"],
  stopWords = [],
  minRatio = 0.5,
} = {}) {
  const stop = new Set([...BASE_STOP_WORDS, ...stopWords.map((w) => w.toLowerCase())])
  const same = (a, b) =>
    sameFields.every(
      (f) => String(a[f] ?? "").trim().toLowerCase() === String(b[f] ?? "").trim().toLowerCase()
    )
  return (a, b) => {
    if (!same(a, b)) return false
    const A = significantWords(a[titleField], stop)
    const B = significantWords(b[titleField], stop)
    if (!A.size || !B.size) return false
    const [small, large] = A.size <= B.size ? [A, B] : [B, A]
    for (const w of small) if (!large.has(w)) return false
    return small.size / large.size >= minRatio
  }
}
