# radar-kit

Shared plugin code for event-watch, job-radar, and release-radar — three
opencode-driven digest agents that share the same overall shape (search the
web, dedup against a JSON store, render+send an HTML/text digest, update
the store) but track different domains. This package factors out what was
actually identical or same-shaped across their three `.opencode/plugins/`
files, leaving each repo's own file to hold only what's genuinely specific
to its domain.

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
- `sendGmailMessage` / the Gmail OAuth refresh + MIME building — identical
  in all three originals, byte for byte.
- `escapeHtml`.
- `createFilterFutureEventsTool` — event-watch's future-date filter, kept
  here since it's already fully generic (just needs `{ title, date }`) and
  any future date-gated repo would need the exact same thing.

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

**Shared** — `src/markStore.js` (atomic temp-write + fsync + rename, the
corrupt-store quarantine, the own-keys-only store lookup, optional
mutual exclusion) and `src/interestServer.js` (routing, JSON body parsing,
and the catch-all that stops one bad request exiting the process).

**Stayed put** — each repo's key shape, request schema, and feed-radar's
HTML response for one-click links from the digest email. Those are
genuinely different, not same-shaped-with-different-data.

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

`job-radar` is **not** wired up: it has no web UI, no interest-server and no
mark files, so there is nothing to calibrate against. It needs one built
before it can join.

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

`pi-ops/update-radar-kit.sh` installs into all seven consuming directories
(four `.opencode/`, three `server/`) and then **restarts the three
interest-servers** — they are long-running systemd services holding the old
module in memory, so unlike the agents, a reinstall alone does not ship a
fix to them.

## Testing

`npm test` runs `node --test`. Two files:

- `test/radar-kit.test.js` — digest rendering/validation, key
  normalization, HTML escaping, MIME header injection.
- `test/interest-server.test.js` — the mark store, the request shell, and
  the calibration join. Every test in its first two groups corresponds to a
  failure that actually happened on the Pi and was fixed by hand in each
  repo separately; they are written to fail against the pre-fix behaviour,
  which is the only way to know the fix is really present.

The `create*Tool` factories still aren't covered directly, since they
depend on `@opencode-ai/plugin` (an *optional* peerDependency this package
doesn't install for itself) — those are exercised indirectly through each
consuming repo's own scheduled runs. The pure functions underneath them
(`buildCalibrationBlock`, `renderDigestContent`, …) are covered here.

CI runs the suite on Node 20/22/24 on every push, and separately asserts
that installing this package alone pulls exactly one package and that the
four non-plugin subpaths import cleanly without it.
