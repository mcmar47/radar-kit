# radar-kit/forge — Radar Forge

Implements `FUTURE-PROJECTS.md` #9. A CLI, run by hand on the Mac, that scaffolds a new
radar repo from what turned out to be genuinely common across every radar this fleet has
built — never scheduled, never deployed, never touched by `pi-ops/update-radar-kit.sh`.

## The restraint this generator follows

FUTURE-PROJECTS.md #9 was explicit that Radar Forge should wait until "the next one or two
experiments" proved which abstractions truly hold, and should "encode proven commonality —
not prematurely freeze it." Before writing this, both Serendipity Radar (2026-09-20) and
prize-radar (2026-09-20) had been built by hand, plus skyline-radar earlier — enough to see
that radars actually come in **two shapes**, not one:

- **`server` archetype** — an always-on interest-server writes a Pi-local, gitignored
  store; marks (`interested.json`/`ignored.json`/`reviewed.json`) live at the repo root.
  Matches event-watch, job-radar, release-radar, feed-radar, serendipity-radar. Delivery
  usually rides a digest as an `extraSection`.
- **`static` archetype** — no server, no per-item marks. A scheduled run computes what
  changed and git-commits `data/state.json` + `data/digest.json` itself; a static
  `index.html` renders them client-side. Matches prize-radar, skyline-radar.

`--archetype server|static` picks between them. The generator does **not** try to collapse
these into one shape — that would be exactly the premature freezing #9 warned against.

**What's templated vs. left as a TODO** follows the same restraint: the wrapper script
shape, the `CLAUDE.md` "scheduling lives on the Pi" section, the completion-guard pattern
(`record_outcome` for the server archetype; a `generatedAt`-advanced check in the wrapper
for the static archetype — see prize-radar's real wrapper), and — above everything else —
**the mark-key shipped as exported code** are generated fully working, because those are
the parts that were identical by the time a third and fourth radar had been built. The
actual search prompt, the record's real fields, and what counts as "changed" are left as
clearly marked `TODO`s in the generated files, because guessing at those would produce a
radar that looks finished but isn't.

### The one requirement that isn't a TODO: `src/<name>Key.js`

FUTURE-PROJECTS.md #9 named this explicitly: *"require every radar to ship its key
function as exported code rather than as a convention reimplemented per consumer."* Every
radar built before this generator invented its mark key inline in 2-3 places (the
interest-server's routes, the calibration tool's `keyFields`, sometimes a third copy in a
digest reader) and the shapes drifted — see `radar-kit/README.md`'s "Calibration" table,
which exists because that drift silently empties a calibration block.

`--key-fields a,b,c` generates `src/<camel>Key.js`, exporting `KEY_FIELDS` and `keyOf`
(via `radar-kit/seenStore`'s `makeKeyFn`). Every generated file that needs a key —
`server/server.js`'s mark routes, `.opencode/plugins/<name>-tools.js`'s
`read_calibration`, the generated test — imports it from there. Nothing redefines it.

This does not support feed-radar's one-off `{ field: "id", exact: true }` shape (an exact
numeric id rather than a normalized combination) — that's rare enough (one radar,
fleet-wide) that it's a documented manual edit in the generated key file rather than a
flag, per the same restraint: the key *format* stays unstandardized on purpose.

## Usage

```
node forge/create-radar.js --name <kebab-name> --archetype server|static \
  --key-fields title,date [--dest ~/Projects] [--description "..."] \
  [--port 8036] [--cadence "Thu *-*-* 09:00:00"] [--cadence-note "..."] \
  [--delivery digest|static-board|none] [--model ...] [--plugin-pin ...] [--force]
```

`node forge/create-radar.js --help` prints the full flag list. `--name` and `--key-fields`
are the only required flags; everything else has a fleet-typical default.

**Port and plugin-pin are best-effort.** The generator scans sibling directories under
`--dest` for the highest port number already in use and an existing `@opencode-ai/plugin`
pin, so a fresh scaffold doesn't collide with what's checked out locally — but it has no
live view of the Pi's actual `pi-bootstrap/nginx/*` or `pi-ops/systemd/*.timer`, so both
are printed with an explicit "VERIFY" reminder and repeated in `DEPLOY-CHECKLIST.md`.

## What gets generated

A full repo skeleton at `<dest>/<name>/`:

- `CLAUDE.md` / `AGENTS.md` (symlink) / `README.md` — the boilerplate sections (the
  "scheduling lives on the Pi" text, the commands list) generated verbatim from the real
  ones; the architecture/decision-model sections are `TODO`-scaffolded prose, not guesses.
- `README.md`'s **Decision model** section — the "small README that documents the decision
  model" FUTURE-PROJECTS.md #9 asks for: what this radar tracks, what counts as new vs.
  duplicate, what counts as changed, the delivery channel, the cadence and why, and — if
  it's a measurement — its denominator.
- `package.json`, `opencode.json`, `.opencode/package.json` (pinned), `.gitignore`.
- `src/<camel>Key.js` — working, as above.
- `src/<camel>Store.js` — a well-commented skeleton (flat-array `addBatch`/`markDelivered`
  for the server archetype; `classifyChange`/`buildStateFile`/`buildDigestFile` for the
  static archetype), with the one proven rule for each archetype spelled out in comments:
  keep the store a flat array, never key "changed" on a free-text summary field.
- `.opencode/commands/<name>.md` — a prompt *shape* (What to read first / the judgment /
  Finishing, with the completion-guard contract spelled out), not real prompt content.
- `.opencode/plugins/<name>-tools.js` — `read_calibration` wired through the key module,
  a write tool with a placeholder schema, and (server archetype) `record_outcome` wired
  and working.
- `server/server.js` (server archetype only) — generated fully working: `radar-kit/server`
  + `radar-kit/markStore` + `createOneClickMarkRoute` + `createReviewedRoute` +
  `createHealthRoute`, serialized read-modify-write, the works. Boots and answers
  `/api/health` with zero edits — validated live during this generator's own build.
- `index.html` — a minimal working fetch-and-render page, `textContent` only (never
  `innerHTML` on agent-sourced text, matching every sibling radar's own discipline).
- `test/<camel>.test.js` — **the "tests for key and calibration compatibility"
  FUTURE-PROJECTS.md #9 requires.** Exercises the real `radar-kit/calibration`
  `buildCalibrationBlock` against a fixture record keyed with this repo's own `keyOf`,
  asserting the join actually finds the mark — the exact failure mode (an empty
  calibration block, forever, from a key mismatch) that motivated `radar-kit/calibration.js`
  in the first place. Passes as generated, against the real package, for both archetypes.
- `launchd/run-<name>-opencode.sh` — the full wrapper: frontmatter extraction, `git pull`,
  timeout, per-run cost logging, and the archetype-appropriate completion guard.
- `deploy/pi-ops/<name>.service` + `.timer`, `deploy/pi-bootstrap/nginx-<name>` — generated
  content ready to hand-copy into those repos (see below for why not automated).
- `DEPLOY-CHECKLIST.md` — the exact edits still needed in `pi-ops` and `pi-bootstrap`
  (the heartbeat `CHECKS`/`PROBES` lines, the `AGENT_REPOS` addition, running the deploy
  script) with the content pre-written.

## Why `pi-ops` / `pi-bootstrap` are handed off, not auto-edited

Those repos' files (`heartbeat-check.sh`, `backup-secrets.sh`, `FLEET.md`) carry dense,
hand-written, per-radar comments and a specific ordering that records *why* each entry
exists — the fleet's own convention, visible in every one of those files today. A
generator blindly appending a line is more likely to corrupt that record than help. So
Radar Forge writes the exact content to paste (`deploy/`, `DEPLOY-CHECKLIST.md`) and stops
there — the same "generate, then a person decides" split FUTURE-PROJECTS.md #9 asks for
at the prompt/store level, applied to the deploy step too.

## Validated

Both archetypes were scaffolded and exercised end to end while building this generator:
every generated `.js` file passes `node --check`, the wrapper passes `bash -n`, `npm test`
passes (4/4, including the calibration-compatibility test against a real installed
`radar-kit`), and the server archetype's `server/server.js` was booted for real and its
`/api/health`, write, and one-click-mark routes all responded correctly with zero manual
edits.
