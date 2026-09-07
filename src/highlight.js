// Picking the one time-critical row from a digest that just sent, for the
// ntfy push channel (ntfy.js). The channel exists to be nearly empty
// (NEW-IDEAS.md C4), so the rule is deliberately strict: a push happens only
// when EXACTLY ONE delivered item is imminent. Two imminent items is not
// "send two" — it's "the digest already covers this, stay quiet".
//
// Dependency-free and plugin-free — event-tools.js / release-tools.js import
// this to build their `push.pickHighlight`, and the radar-kit/ntfy contract
// keeps this side free of @opencode-ai/plugin too.

const ISO_DATE = /^\d{4}-\d{2}-\d{2}/

// today + n days, as "YYYY-MM-DD". Uses UTC arithmetic on the date only, so
// it never drifts by a day near a DST boundary.
function addDays(isoDay, n) {
  const [y, m, d] = isoDay.split("-").map(Number)
  const t = Date.UTC(y, m - 1, d) + n * 86400000
  return new Date(t).toISOString().slice(0, 10)
}

/**
 * The single imminent item in `items`, or null unless exactly one qualifies.
 * "Imminent" = `item[dateField]` is an ISO date (YYYY-MM-DD…) falling from
 * `today` through `today + withinDays` inclusive. A fuzzy date ("TBD",
 * "Fall 2026") fails the ISO test and is never imminent — correct, since
 * there is nothing to be on time for.
 *
 * @param {object[]} items
 * @param {object} opts
 * @param {string} opts.dateField           e.g. "date" (events) / "release_date"
 * @param {string} opts.today               "YYYY-MM-DD", injectable for tests
 * @param {number} [opts.withinDays=3]
 * @returns {object|null}
 */
export function soleImminentItem(items, { dateField, today, withinDays = 3 }) {
  if (!Array.isArray(items) || !today) return null
  const last = addDays(today, withinDays)
  const imminent = items.filter((it) => {
    const raw = String(it?.[dateField] ?? "")
    if (!ISO_DATE.test(raw)) return false
    const day = raw.slice(0, 10)
    return day >= today && day <= last
  })
  return imminent.length === 1 ? imminent[0] : null
}

/**
 * A `continuum://item?origin=…&key=…` deep link — the tap target for the
 * push. `RootView.onOpenURL` in continuum-ios routes it to the item detail;
 * `origin` must be one of its `InboxItem.Origin` raw values (events,
 * releases, feeds, jobs) and `key` must be that radar's mark key
 * (radar-kit `makeKeyFn` with the same fields the interest-server uses).
 */
export function continuumItemLink({ origin, key }) {
  const qs = new URLSearchParams({ origin, key })
  return `continuum://item?${qs}`
}
