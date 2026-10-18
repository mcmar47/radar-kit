import { test } from "node:test"
import assert from "node:assert/strict"
import { makeNearDuplicateFn } from "../src/nearDuplicate.js"

// event-watch's configuration; every pair below is a real one from its
// seen-events.json (2026-10-18).
const isDup = makeNearDuplicateFn({
  stopWords: ["live", "nt", "national", "theatre", "theater", "festival", "fair", "show",
    "tour", "event", "events", "presents", "annual", "edition", "book", "club", "november", "october"],
})
const ev = (title, date = "2026-11-28") => ({ title, date })

test("reworded titles of one event match", () => {
  const variants = [
    "NT Live: The Misanthrope",
    "NT Live: The Misanthrope (Little Theatre)",
    "The Misanthrope (National Theatre Live)",
    "The Misanthrope",
    "The Misanthrope (NT Live)",
  ]
  for (const a of variants) for (const b of variants) assert.ok(isDup(ev(a), ev(b)), `${a} / ${b}`)
  assert.ok(isDup(ev("Hamlet (Stratford Festival 2027)"), ev("Stratford Festival: Hamlet")))
  assert.ok(isDup(ev("L. J. Nightingale: Drawn"), ev("L.J. Nightingale: Drawn (Writers & Books)")))
  assert.ok(isDup(ev("Rochester Children and Teen Book Festival"), ev("Rochester Children & Teen Book Festival")))
  assert.ok(isDup(ev("2026 November Full Moon Gathering #298"), ev("November Full Moon Gathering")))
})

test("different events sharing words or a date do not match", () => {
  assert.ok(!isDup(ev("November Nitrate Weekend: Hamlet (35mm Nitrate)"), ev("November Nitrate Weekend: Daisy Kenyon (35mm Nitrate)")))
  assert.ok(!isDup(ev("Greek Peak Fall Fest"), ev("Peek'n Peak Fall Fest")))
  assert.ok(!isDup(ev("Experience Psychic Fair Syracuse"), ev("Experience Psychic Fair: Rochester")))
  assert.ok(!isDup(ev("Romantasy Book Club"), ev("Helen Scheuerer: Sparks, Shadows, and Epic Romantasy")))
  assert.ok(!isDup(ev("Saratoga Book Festival"), ev("Ghosts of Saratoga Trolley Tour")))
})

test("same title on a different date is not a duplicate", () => {
  assert.ok(!isDup(ev("The Misanthrope", "2026-11-28"), ev("The Misanthrope", "2026-12-05")))
})

test("a title that is all stop words never matches", () => {
  assert.ok(!isDup(ev("The Show"), ev("NT Live")))
})
