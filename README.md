# radar-kit

Shared plugin code for event-watch, job-radar, release-radar and feed-radar
— four opencode-driven digest agents that share the same overall shape
(search the web, dedup against a JSON store, render+send an HTML/text
digest, update the store) but track different domains. This package factors
out what was actually identical or same-shaped across their
`.opencode/plugins/` files, leaving each repo's own file to hold only
what's genuinely specific to its domain.

## Why this exists

The three repos' plugin files (1,689 lines combined) had grown almost
entirely in parallel: `validate-gmail-send.js` was ported by hand from
event-watch into job-radar and then release-radar, comments and all, after
a Gmail MCP `mimeType` bug was diagnosed once and then silently needed
fixing three times. `render_digest`/`validate_digest`/`send_digest_email`
existed in all three with the same structure and almost the same code.
`check_dedup`/`append_seen_*` were byte-identical in shape between
event-watch and job-radar, differing only in field names.

That's the sign a shared package pays for itself: not "these look similar,"
but "this exact bug already needed fixing more than once."

## What's shared vs. what stayed put

**Fully shared, no repo-specific config needed:**
- `sendGmailMessage` / SMTP submission + MIME building — identical
  in all three originals, byte for byte. (Was Gmail-API + OAuth until the
  project's consent screen got stuck in Testing status, whose refresh
  tokens Google expires after 7 days; now `smtp.gmail.com:465` with a
  non-expiring Gmail app password from `~/.gmail-mcp/smtp.json`.)
  `sendGmailMessage({ attachments: [{ filename, contentType, content }] })`
  wraps the alternative body in `multipart/mixed` and base64s each
  payload — added for shelf's monthly cover-grid PNG.
- `sendNtfyPush` / `readPushTopic` (`radar-kit/ntfy`, dependency-free) — one
  push to the phone via ntfy.sh, the other way this fleet reaches it, for
  the single time-critical row in a digest that just went out (NEW-IDEAS.md
  C4). Reads the topic from `~/.config/pi-ops/ntfy-push-topic` — a **second**
  topic, kept separate from `pi-ops/alert.sh`'s ops-alert topic so each can
  be muted independently. `send_digest_email` takes an optional `push: {
  pickHighlight }`; `pickHighlight(sentItems)` runs post-send and, only when
  it returns non-null, one notification goes out. Best-effort throughout — a
  missing topic file, a null highlight, or a failed POST all leave the digest
  result untouched. Only event-watch and release-radar pass it.
  `soleImminentItem` (in `highlight.js`) is the strict "exactly one item is
  within N days" filter both use; `continuumItemLink` builds the
  `continuum://item?origin=…&key=…` deep link the notification taps through.
- `sendContinuumPush` / `buildSummary` (`radar-kit/continuumPush`,
  dependency-free) — the **second** in-app-notification channel, sibling of
  `radar-kit/ntfy`. A best-effort POST to the `continuum-push` service on the
  Pi (`127.0.0.1:8031`), which sends it through APNs to the Continuum iOS
  app. `send_digest_email` takes an optional `continuumPush: { noun,
  titleField?, deepLink? }`; after a confirmed send it posts **one per-radar
  summary banner** ("5 new feed picks", body = the lead titles), so the
  phone doesn't wait on its throttled `BGTaskScheduler` wake-up. Distinct
  from `push`/`pickHighlight` above — that stays the near-empty
  single-imminent-row ntfy channel. All four Inbox-feeding radars pass it.
  No secret to read: `/api/push` isn't nginx-proxied, so reaching it means
  you're already on the Pi.
- `escapeHtml`.
- `createFilterFutureEventsTool` — event-watch's future-date filter, kept
  here since it's already fully generic (just needs `{ title, date }`) and
  any future date-gated repo would need the exact same thing.
- `createRecordOutcomeTool` — the silent-stall guard. Writes
  `logs/run-outcome.json` (name overridable — release-radar uses a
  per-cadence path) as the final action of every completed run; the wrapper
  clears it beforehand and fails the run if it's missing after a clean exit,
  which is how a run that stopped before rendering anything gets caught
  rather than looking like "nothing new today". Wired into release-radar and
  job-radar; event-watch keeps its own equivalent inline copy from before
  this was factored out.
- `readPendingResearchAnswer` — delivery glue for the `research-desk` repo
  (Overnight Research Desk). Reads its `data/desk.json`; if an answered
  question is waiting undelivered and younger than ~22h, returns it as a
  digest section (`{ html, text, id, onDelivered }`) with no `<h2>`.
  feed-radar passes it to `createRenderDigestTool` / `createSendDigestEmailTool`
  as `extraSection: { read }`; the section renders after the item groups and
  before the scorecard footer, and the send tool will send a digest with
  zero items when the section alone is worth sending. Dependency-free.
- `buildMarkRateReport` / `createMarkRateSection` — the fleet mark-rate
  report (FUTURE-PROJECTS.md project 7's "one measurement worth taking
  now"). For each radar and the fleet as a whole: **of every item this radar
  has delivered** (its seen store, keyed the same way `calibration.js`
  keys it), what fraction carries a star/reject decision in
  `interested.json` + `ignored.json` — plus how many new marks landed in the
  last 7 days as the momentum figure. A whole-store cohort, not a trailing
  window: a mark's timestamp is when someone *decided*, often weeks after
  delivery, so "marks this week ÷ delivered this week" overshoots 100%; the
  honest denominator is every delivered item, and tracked weekly the level
  itself is the trend. `buildMarkRateReport` is the pure compute+render half
  (no fs, no plugin); `createMarkRateSection` reads each radar's `seenFile` +
  mark stores off disk and returns an `extraSection`-shaped `{ read }` gated
  to once every ~7 days by a Pi-local `logs/mark-rate.json`, so it rides one
  feed-radar digest a week.
- `combineExtraSections([a, b, …])` — fold several `extraSection` `{ read }`
  objects into one. feed-radar carries two (Research Desk answer + weekly
  mark-rate); results concatenate in order, `onDelivered` fans out, all-null
  → null.

**Shared via config, because the *shape* is identical but the data isn't:**
- `renderDigestContent` / `validateDigestContent` — group items, render
  HTML+text, validate. Configured per repo with a grouping key, optional
  fixed group order (event-watch/release-radar) vs. alphabetical fallback
  (job-radar's dynamic per-company grouping), an optional within-group sort
  (release-radar's new-before-updated), and per-item render callbacks.
- `createCheckDedupTool` / `createAppendSeenTool` — binary new-vs-duplicate
  against a seen-file, keyed by one or more normalized fields. Covers
  event-watch (title+date) and job-radar (company+title+link).
- `createValidateGmailSendPlugin` — the send-time guardrail, configured
  with a staging filename and the same `matchFields` the digest config
  already defines, so the two checks can't drift apart.

**Deliberately NOT shared — release-radar's classify/apply step:**
release-radar's `check_new_or_updated` does 3-way classification
(new/updated/unchanged) instead of binary dedup, and `apply_release_updates`
edits existing records in place for "updated" items instead of only ever
appending. Forcing that through the same config shape as a binary dedup
tool would have made both harder to read than just writing release-radar's
~90 lines directly — it stays there, built on top of this package's
`readJsonArray`/`writeJsonArray`/`normalizeField` primitives rather than
being reimplemented from scratch.

## The second extraction: the interest-servers

The three interest-servers (`event-watch`, `release-radar`, `feed-radar`)
hit the same threshold this package was created for. On 2026-08-28 the same
crash class was fixed by hand three times in one day, in three files that
were otherwise near-identical:

| Repo | Commit that day | Lines |
|---|---|---|
| event-watch | "Keep the interest server alive through a corrupt or half-written store" | 143 |
| release-radar | *(identical message)* | 166 |
| feed-radar | "Stop a single GET from killing the interest server, and survive a bad store" | 204 |

**Shared** — `src/markStore.js` (the corrupt-store quarantine, the
own-keys-only store lookup, optional mutual exclusion) and
`src/interestServer.js` (routing, JSON body parsing, and the catch-all
that stops one bad request exiting the process). The atomic temp-write +
fchmod + fsync + rename underneath `writeMarks` is its own module,
`src/atomicWrite.js` (`radar-kit/atomicWrite`) — it was byte-identical in
markStore, in shelf's `src/store.js`, and near-identical in a third place,
with a standing "reconcile when radar-kit comes in" note in shelf. It has,
so `writeMarks`, shelf's `writeStore`, and the digest run log all call
`writeFileAtomic` now.

**Stayed put** — each repo's key shape, request schema, and feed-radar's
HTML response for one-click links from the digest email. Those are
genuinely different, not same-shaped-with-different-data.

### The reviewed store (`radar-kit/reviewedRoute`)

`createReviewedRoute({ reviewed, fields, keyOf })` adds a `POST /api/reviewed`
route backed by its own single-store `createMarkStore` instance
(`reviewed.json` in the repo root, non-exclusive, **separate** from
interested/ignored). It is what the Continuum iOS app writes when you swipe
past an item in its unified Inbox without starring or rejecting it —
"don't show me this again", not a preference. It was local-only on the phone
until a bundle-id change wiped the app container and took ~450 of those
decisions with it; a store on the Pi makes it survive a reinstall and match
a future iPad / Mac build, the same way the marks already do.

**The agents never read `reviewed.json`.** `buildCalibrationBlock` still
joins only `interested`/`ignored`, so this is not a training signal — it is
purely a client-side "already triaged" set that happens to live on the Pi
for durability.

Three body shapes: `{ <fields>, reviewed: bool }` for one item,
`{ items: [{ <fields> }, …], reviewed: bool }` for a batch ("mark all as
seen"), and `{ clear: true }` to wipe the store ("show seen items again").
`fields`/`keyOf` are the same pair `createOneClickMarkRoute` takes, so a
reviewed key matches the key that radar's mark routes and `read_calibration`
use.

`createMarkStore()` gained a `clear()` method (empties every named store)
for the `{ clear: true }` path.

**Mark shape (2026-09).** A mark written through `createMarkStore().set`
is now `{ at, via }` — an ISO timestamp and a short source string
(`"email"` from the digest links, `"web"` from a page toggle, `"app"` from
the iOS client) — instead of a bare `true`. This is what lets
`buildCalibrationBlock` order marks by recency rather than by key order
(feed-radar's keys are numeric strings, so key order was never
chronological) and lets a fleet review see which surface is actually
earning marks. Old stores are upgraded lazily: a key keeps its `true`
until the next `set` touches it, and `markInfo(value)` normalizes either
shape to `{ at, via }` (a legacy mark reads as `{ at: null, via: null }`).
Every `key in marks` / `marks[key]` truthiness path is unchanged.

Two fixes went upstream with the extraction, so all three now get behaviour
only feed-radar had learned the hard way:

- **Own-keys-only store lookup.** `paths[name]` also resolved
  `constructor`, `toString` and `__proto__`, which sailed through a
  `!paths[name]` guard and handed `readFile` a function.
- **A wrong-shaped store counts as corrupt.** A store containing `"x"`,
  `null` or `[]` parsed fine and then silently swallowed every write. None
  of the three originals caught this.

### Why importing this no longer drags in the plugin tree

`release-radar/server/package.json` used to read *"No dependencies on
purpose — a radar-kit import would drag in @opencode-ai/plugin's whole tree
(npm auto-installs peerDependencies) just for a 3-line key-normalization
function."* That was accurate, and it is why this code stayed duplicated.
Both halves are now fixed:

1. **`exports` subpaths.** `radar-kit/server`, `radar-kit/markStore`,
   `radar-kit/seenStore` and `radar-kit/calibration` each resolve straight
   to their module, so a server never evaluates `index.js` and never
   reaches the modules that import `@opencode-ai/plugin/tool`.
2. **`peerDependenciesMeta` marks that peer optional**, so npm stops
   auto-installing it for a consumer that only wants the above.

`npm install radar-kit` in a server directory now pulls exactly one
package. CI asserts both properties on every push — if a future change
makes any of those four subpaths reach the plugin package, the
`server-subpaths-stay-dependency-free` job fails.

**Keep `markStore.js`, `interestServer.js`, `seenStore.js` and
`calibration.js` free of any import that reaches `@opencode-ai/plugin`**,
or the original objection comes straight back.

## Calibration

`src/calibration.js` turns star/reject marks into a block a digest prompt
can be scored against, and `createCalibrationTool` exposes it as the
`read_calibration` tool.

It exists because the marks are *keys*, not records: event-watch's store
holds `"a reading|2026-09-01": true` and feed-radar's holds `"1405": true`.
The useful signal is the record behind the key, which lives in a different
file — so the join, using the same key function the server wrote the mark
with, is the whole job. It was the same job in three repos.

Before this, only feed-radar's prompt used its marks at all, and even there
the mechanism was "the prompt tells the model to read three JSON files" —
which is why `feed-radar/profile.md` described a Calibration section as
"appended automatically at run time" that nothing appended. event-watch's
and release-radar's marks were written by their web pages and read by
nothing.

`keyFields` must match what the repo's interest-server writes, or the join
silently finds nothing and every run reports an empty block:

| Repo | keyFields | Records |
|---|---|---|
| event-watch | `["title", "date"]` | `seen-events.json` |
| release-radar | `["watch", "type", "title"]` | `seen-releases.json` |
| feed-radar | `[{ field: "id", exact: true }]` | `picks.json` |
| job-radar | `["company", "title", "link"]` | `seen-jobs.json` |

All four are now wired up. `job-radar` was the last: it gained an
interest-server on 2026-08-30 (marks come from the iOS Jobs tab), and its
prompt gained the `read_calibration` step on 2026-09-02 — before that the
marks it collected were read by nothing.

## Scorecard

`src/scorecard.js` (`buildScorecard`) builds the one-line footer that
`renderDigestContent` can append to every digest:

```
Last 7 days: 16 picks, 3 starred, 1 rejected · glm-5.3-flash
```

It exists because two agents moved to GLM 5.3 Flash on 2026-09-01 and
there was no way to see what that did to pick quality without counting
marks by hand between runs. The star/reject counts come from each mark's
`at` timestamp (the field `markStore` started recording in 2026-09 — a
legacy `true` mark has no timestamp and never lands in a window). The
"delivered" total comes from a small run log the send tool appends to
after each successful send (`logs/digest-runs.json`, capped at 90
entries).

Wire it by passing a `scorecard` block to `createRenderDigestTool` and
`createSendDigestEmailTool`:

```js
scorecard: { noun: "picks", model: "openrouter/z-ai/glm-5.3-flash" }
```

`interestedFileName` / `ignoredFileName` / `runsFileName` / `days` all have
defaults. `model` falls back to `$DIGEST_MODEL`.

**Per-run cost** rides the same run log. `scripts/run-cost.js` (called by
each agent's run wrapper) reads the OpenRouter inference key's lifetime
`usage` total from `/api/v1/auth/key` before and after the run; the delta
is that run's cost, written onto the just-logged entry by `recordRunCost`.
No generation-id capture and no management key needed — the inference key
reads its own usage (`src/openrouterCost.js`). Because OpenRouter's total
lags the run by a moment, the wrapper records the figure *after* the run,
so a digest footer shows the **previous** run's cost — `· $0.03 last run`.
A run whose delta comes back `<= 0` (sampled before the total caught up)
records nothing rather than a misleading `$0.00`.

## Using this in a repo

`.opencode/package.json` (hand-maintained and gitignored on purpose, since
it must pin `@opencode-ai/plugin` to whatever opencode version that
specific machine has installed — see the migration notes in
`event-watch`'s memory):

```json
{
  "dependencies": {
    "@opencode-ai/plugin": "1.17.20",
    "radar-kit": "github:mcmar47/radar-kit"
  }
}
```

Then a repo's own plugin file becomes mostly configuration — see
`event-watch/.opencode/plugins/event-tools.js`,
`job-radar/.opencode/plugins/job-tools.js`, and
`release-radar/.opencode/plugins/release-tools.js` for the three real
examples this package was extracted from.

An interest-server's `server/package.json` needs only this — no
`@opencode-ai/plugin` pin, because the subpaths it imports never reach it:

```json
{
  "type": "module",
  "dependencies": {
    "radar-kit": "github:mcmar47/radar-kit"
  }
}
```

`pi-ops/update-radar-kit.sh` installs into every consuming directory and
then **restarts the long-running interest-servers** — they hold the old
module in memory, so unlike the agents, a reinstall alone does not ship a
fix to them. `update-radar-kit.sh --describe` prints the current directory
and service list; it isn't restated here because the counts kept drifting
from the script.

## Testing

`npm test` runs `node --test` (~130 tests):

- `test/radar-kit.test.js` — digest rendering/validation, key
  normalization, HTML escaping, MIME header injection.
- `test/interest-server.test.js` — the mark store, the request shell, and
  the calibration join. Every test in its first two groups corresponds to a
  failure that actually happened on the Pi and was fixed by hand in each
  repo separately; they are written to fail against the pre-fix behaviour,
  which is the only way to know the fix is really present.
- `test/reviewed-route.test.js` — the `POST /api/reviewed` route: its three
  body shapes, and the key-matches-the-mark-routes contract.
- `test/scorecard.test.js` — the digest-footer scorecard and the run log.
- `test/mark-rate.test.js` — the fleet mark-rate report, its once-a-week
  disk-reading section + state-file gate, and `combineExtraSections`.
- `test/ntfy.test.js` — the C4 push channel: the topic-file read, the POST
  and its header-injection guard, the "exactly one imminent item" filter,
  and the `continuum://` deep link.
- `test/continuum-push.test.js` — the Continuum in-app push channel:
  `sendContinuumPush`'s best-effort POST + header-injection guard, and
  `buildSummary`'s per-radar wording.
- `test/atomic-write.test.js` — the atomic-write / corrupt-store plumbing
  the interest-servers depend on.

The `create*Tool` factories still aren't covered directly, since they
depend on `@opencode-ai/plugin` (an *optional* peerDependency this package
doesn't install for itself) — those are exercised indirectly through each
consuming repo's own scheduled runs. The pure functions underneath them
(`buildCalibrationBlock`, `renderDigestContent`, …) are covered here.

CI runs the suite on Node 20/22/24 on every push, and separately asserts
that installing this package alone pulls exactly one package and that the
non-plugin subpaths (`server`, `markStore`, `atomicWrite`, `seenStore`,
`scorecard`, `gmail`, `ntfy`, `continuumPush`, `health`, `oneClickMark`,
`reviewedRoute`) import cleanly without it.
