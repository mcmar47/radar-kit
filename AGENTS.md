# AGENTS.md

This file provides guidance to AI coding agents working in this repository.

## What this repo is

Shared plugin code for `event-watch`, `job-radar`, `release-radar` (and, via `radar-kit/markStore`
and friends, `shelf`) — a handful of opencode-driven digest agents that share the same overall
shape (search/triage, dedup against a JSON store, render+send an HTML/text digest, update the
store) but track different domains. This package factors out what was actually identical or
same-shaped across their `.opencode/plugins/` files and interest-servers. See README.md for the
full "why this exists" case history — it's driven by specific bugs that had to be fixed by hand
more than once across the sibling repos, not by "these look similar."

## Commands

- **Test:** `npm test` (runs `node --test`). Three files: `test/radar-kit.test.js` (digest
  render/validate, key normalization, HTML escaping, MIME header injection),
  `test/interest-server.test.js` (mark store + its `{ at, via }` shape, request shell,
  calibration join and its recency ordering) and `test/scorecard.test.js` (the digest-footer
  scorecard and run log) — the interest-server
  tests are written to fail against the pre-fix behavior of real bugs found on the Pi, so they
  double as regression tests for incidents, not just spec coverage.
- No build/lint step. CI (`.github/workflows/test.yml`) runs the suite on Node 20/22/24 on every
  push, and separately asserts that `npm install radar-kit` alone pulls exactly one package and
  that the four non-plugin `exports` subpaths import cleanly without `@opencode-ai/plugin`.

## Architecture

- **`index.js`** and `src/*.js` — the shared modules. `exports` in `package.json` defines these
  subpaths (`.`, `./server`, `./markStore`, `./seenStore`, `./calibration`, `./scorecard`,
  `./oneClickMark`).
  **Keep `markStore.js`, `interestServer.js`, `seenStore.js` and `calibration.js` free of any
  import that reaches `@opencode-ai/plugin`** — that peer dependency is optional specifically so a
  bare interest-server (no opencode involved at all) can `npm install radar-kit` and pull exactly
  one package. Reintroducing that import path defeats the reason this package is usable from
  `server/package.json` in the first place.
- **`src/calibration.js`** joins a repo's star/reject mark file back to its records file by
  `keyFields`, which must match what that repo's interest-server writes or the join silently finds
  nothing. See README's table for all four repos' `keyFields`. Every repo is now wired up;
  `job-radar` was the last, on 2026-09-02.
- **Consumers pin `@opencode-ai/plugin`** in their own gitignored `.opencode/package.json` to
  whatever opencode version that machine has installed (see README's "Using this in a repo").
  Reinstalling `radar-kit` without checking that pin against the Pi's actual `opencode --version`
  is a known way to end up with a mismatched plugin API at runtime.

## Deploying a change

Editing this repo does not by itself update anything — `pi-ops/update-radar-kit.sh`
(run over ssh, `~/Projects/pi-ops/update-radar-kit.sh` on the Pi) installs the new version into
all seven consuming directories (four `.opencode/`, three `server/`) and then **restarts the three
interest-servers**, since they're long-running systemd services holding the old module in memory —
a reinstall alone does not ship a fix to them. The deploy flow is: push this repo, then run that
script over ssh — it does not pull the consumer repos themselves.
