# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) and other AI coding agents when
working with code in this repository. `AGENTS.md` is a symlink to this file — one copy, so they
can't drift.

## What this repo is

Shared plugin code for `event-watch`, `job-radar`, `release-radar`, `feed-radar` (and, via
`radar-kit/markStore` and friends, `shelf`) — a handful of opencode-driven digest agents that
share the same overall
shape (search/triage, dedup against a JSON store, render+send an HTML/text digest, update the
store) but track different domains. This package factors out what was actually identical or
same-shaped across their `.opencode/plugins/` files and interest-servers. See README.md for the
full "why this exists" case history — it's driven by specific bugs that had to be fixed by hand
more than once across the sibling repos, not by "these look similar."

## Commands

- **Test:** `npm test` (runs `node --test`). `test/radar-kit.test.js` (digest
  render/validate, key normalization, HTML escaping, MIME header injection),
  `test/interest-server.test.js` (mark store + its `{ at, via }` shape, request shell,
  calibration join and its recency ordering, one-click route + its `onMarked` hook),
  `test/scorecard.test.js` (the digest-footer scorecard and the run log),
  `test/atomic-write.test.js` (the atomic-write / corrupt-store plumbing),
  `test/research-desk.test.js` (`readPendingResearchAnswer` + `renderDigestContent`'s
  extra-section handling), and
  `test/mark-rate.test.js` (the fleet mark-rate report, its once-a-week
  disk-reading section + state-file gate, and `combineExtraSections`), and
  `test/ntfy.test.js` (the C4 push channel: topic-file read, the POST +
  header-injection guard, the "exactly one imminent item" filter, the
  `continuum://` deep link), and
  `test/continuum-push.test.js` (`sendContinuumPush`'s best-effort POST +
  header-injection guard, and `buildSummary`'s per-radar wording). The
  interest-server tests are written to fail against the pre-fix
  behavior of real bugs found on the Pi, so they double as regression tests for incidents, not
  just spec coverage.
- No build/lint step. CI (`.github/workflows/test.yml`) runs the suite on Node 20/22/24 on every
  push, and separately asserts that `npm install radar-kit` alone pulls exactly one package and
  that every non-plugin `exports` subpath imports cleanly without `@opencode-ai/plugin`.

## Architecture

- **`index.js`** and `src/*.js` — the shared modules. `exports` in `package.json` defines several
  subpaths (`.`, `./server`, `./markStore`, `./atomicWrite`, `./seenStore`, `./calibration`, `./scorecard`, `./gmail`, `./ntfy`, `./continuumPush`, `./health`,
  `./oneClickMark`, `./reviewedRoute`).
  **Keep `markStore.js`, `interestServer.js`, `seenStore.js`, `calibration.js`, `scorecard.js`, `gmail.js`,
  `ntfy.js`, `continuumPush.js`, `healthRoute.js`, `oneClickMark.js`, `reviewedRoute.js` and `atomicWrite.js` free of any
  import that reaches `@opencode-ai/plugin`** — that peer dependency is optional specifically so a
  bare interest-server (no opencode involved at all) can `npm install radar-kit` and pull exactly
  one package. Reintroducing that import path defeats the reason this package is usable from
  `server/package.json` in the first place. (`markRate.js`, `markRateSection.js`,
  `combineExtraSections.js` and `highlight.js` are also plugin-free but reached only through the
  barrel, so they carry no subpath obligation — the CI check enumerates the subpaths above.)
  `continuumPush.js` (`./continuumPush`) is the sibling of `ntfy.js`: the second
  in-app-notification channel, a best-effort POST to the `continuum-push` service on the Pi
  (127.0.0.1:8031) with one per-radar summary banner per digest run. Wired into
  `createSendDigestEmailTool` via its `continuumPush: { noun, ... }` option, alongside the
  existing `push`/pickHighlight ntfy channel.
- **`src/calibration.js`** joins a repo's star/reject mark file back to its records file by
  `keyFields`, which must match what that repo's interest-server writes or the join silently finds
  nothing. See README's table for all four repos' `keyFields`. Every repo is now wired up;
  `job-radar` was the last, on 2026-09-02.
- **`src/reviewedRoute.js`** — `POST /api/reviewed`, backed by its own single-store `createMarkStore`
  instance (`reviewed.json`, non-exclusive, separate from interested/ignored). The Continuum iOS app's
  "seen in the Inbox" set, given a home on the Pi so it survives a phone reinstall. **The agents never
  read it** — `calibration.js` still joins only interested/ignored, so this is not a training signal.
  Three body shapes: one item, a batch, and `{ clear: true }` (which uses `createMarkStore().clear()`).
- **Consumers pin `@opencode-ai/plugin`** in their own gitignored `.opencode/package.json` to
  whatever opencode version that machine has installed (see README's "Using this in a repo").
  Reinstalling `radar-kit` without checking that pin against the Pi's actual `opencode --version`
  is a known way to end up with a mismatched plugin API at runtime.

## Deploying a change

Editing this repo does not by itself update anything — `pi-ops/update-radar-kit.sh`
(run over ssh, `~/Projects/pi-ops/update-radar-kit.sh` on the Pi) installs the new version into
every consuming directory and then **restarts the long-running interest-servers**, since they
hold the old module in memory and a reinstall alone does not ship a fix to them. Run
`update-radar-kit.sh --describe` for the current list of directories and services (deliberately
not restated here — the counts kept drifting). The deploy flow is: push this repo, then run that
script over ssh — it does not pull the consumer repos themselves.
