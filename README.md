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

## Testing

`npm test` runs `node --test` over the framework-independent logic
(digest rendering/validation, key normalization, HTML escaping). The
`create*Tool` factories aren't covered here since they depend on
`@opencode-ai/plugin` (a peerDependency this package doesn't install for
itself) — those are exercised indirectly through each consuming repo's own
scheduled runs.
