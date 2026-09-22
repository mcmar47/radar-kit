// CLAUDE.md / README.md / DEPLOY-CHECKLIST.md generation.

import { SCHEDULING_SECTION, fillName } from "./templates.js"

export function buildClaudeMd(opts) {
  const { name, camel, description, archetype, keyFields, delivery, port, serverPort } = opts
  const isServer = archetype === "server"

  const whatThisRepoIs = `## What this repo is

TODO — one paragraph: what does ${name} track, on what cadence, and where does its output land?
Scaffolded by \`radar-kit/forge\` (FUTURE-PROJECTS.md #9, Radar Forge) from the ${
    isServer ? "server" : "static-board"
  } archetype (${
    isServer
      ? "an always-on interest-server writes the store, matching event-watch/job-radar/release-radar/feed-radar/serendipity-radar's shape"
      : "no server, no per-item marks — a weekly run writes git-committed JSON that a static page renders client-side, matching prize-radar/skyline-radar's shape"
  }).

Starting description: ${description}

Sibling in shape to the fleet's other radars: scheduled \`opencode\` run → JSON store → shared
\`radar-kit\` plumbing${isServer ? ", plus an always-on write endpoint" : ""}. Delivery: ${
    delivery === "digest"
      ? "rides feed-radar's digest as an extraSection (never its own email) — wire radar-kit's readPendingXxx reader, mirroring readPendingSerendipityDiscoveries / readPendingPrizeDigest."
      : delivery === "static-board"
        ? "a static board page (this repo's own port) plus, optionally, a public feed published into crossed-keys-chronicle — mirroring prize-radar's bin/publish-*.js."
        : "TODO — decide the delivery channel. Every existing radar folds into an existing surface (a digest extraSection, a static board, the monthly recap) rather than adding a new one; see fleet-docs/UNIFIED-TASKLIST.md's constraints section."
  }`

  const commands = `## Commands

- **Test:** \`npm test\` (\`node --test\`) — \`test/${camel}.test.js\`: the mark-key's normalization
  and its join against radar-kit's real calibration function (this is the "tests for key and
  calibration compatibility" Radar Forge is required to ship — see FUTURE-PROJECTS.md #9).
  TODO: add tests for src/${camel}Store.js once its real logic is filled in.
- **Run manually (on the Pi):** \`./launchd/run-${name}-opencode.sh\`
- **Syntax-check after editing:** \`node --check ${
    isServer ? `server/server.js .opencode/plugins/${name}-tools.js` : `.opencode/plugins/${name}-tools.js`
  } src/${camel}Key.js src/${camel}Store.js\`

## Architecture

- **\`src/${camel}Key.js\`** — the mark-key, exported as code (KEY_FIELDS = ${JSON.stringify(
    keyFields
  )}). Every module that needs to key a record imports \`keyOf\` from here — never reimplement it
  inline. This is the one piece of Radar Forge's scaffold that is load-bearing, not a TODO: see
  the file's own header comment and radar-kit's README "Calibration" table for why key drift is
  the specific bug class this prevents.
- **\`src/${camel}Store.js\`** — pure logic, TODO: fill in this radar's real fields and its real
  "what counts as new/changed" rule. ${
    isServer
      ? "Keep the store a FLAT ARRAY (not `{ batches: [...] }`) unless you have read and understood why serendipity-radar's CLAUDE.md calls that a deliberate deviation — a nested wrapper breaks radar-kit's mark-rate report and calibration tool."
      : "classifyChange must compare only real state fields, never a free-text summary the model rewords every run — see prize-radar's src/prizeBoard.js header comment for the incident this rule prevents."
  }
${
    isServer
      ? `- **\`server/server.js\`** (\`${name}-server.service\`, \`127.0.0.1:${serverPort}\`) is the single writer of \`data/${camel}.json\`. Generated working, using \`radar-kit/server\`, \`radar-kit/markStore\`, \`createOneClickMarkRoute\`, \`createReviewedRoute\`, \`createHealthRoute\` — the same plumbing every server-archetype radar uses. \`interested.json\` / \`ignored.json\` / \`reviewed.json\` live at the repo root (not under \`data/\`) so pi-bootstrap's generic \`AGENT_REPOS\` backup loop covers them without a bespoke block — see DEPLOY-CHECKLIST.md.`
      : `- **No server, no per-item marks.** \`data/state.json\` + \`data/digest.json\` are git-committed by the weekly run itself (see the wrapper) — the same posture as prize-radar/skyline-radar. A record does not need a mark-key for the fleet's mark stores here; it still needs one so re-runs recognize the same record (\`src/${camel}Key.js\`).`
  }
- **\`.opencode/commands/${name}.md\`** — the prompt. TODO: what should it read first, what should
  it search for, what makes a good/complete run vs. a correctly-quiet one.
- **\`.opencode/plugins/${name}-tools.js\`** — generated with \`read_calibration\` wired through
  the exported key module${
    isServer ? ", a write tool that POSTs to the local server, and record_outcome (the silent-stall guard — MUST be the run's final action on every completed path, per every other radar in the fleet)." : ", and a write tool that persists via src/" + camel + "Store.js directly (no server). TODO: decide whether this archetype needs record_outcome (server-archetype radars do; static-board radars like prize-radar instead key their completion guard on the state file's generatedAt actually advancing — see the wrapper script)."
  }
- **\`index.html\`** — TODO: minimal generated page; style it after ${
    isServer ? "release-radar's / serendipity-radar's" : "prize-radar's / skyline-radar's"
  } index.html, never \`innerHTML\` on agent-sourced text.

## Things that are easy to get wrong

- **Never reimplement the mark key inline.** Every caller imports \`keyOf\` from
  \`src/${camel}Key.js\`. This is the exact bug FUTURE-PROJECTS.md #9 named as the reason Radar
  Forge exists — see radar-kit CLAUDE.md.
${
    isServer
      ? "- **The server is the only writer of the data store.** The wrapper and any write tool talk to it over HTTP; nothing else touches the file directly.\n- **Never write a `{ batches: [...] }` wrapper into the store** — see src/" + camel + "Store.js's header comment."
      : "- **Never key \"changed\" on a free-text/summary field.** See src/" + camel + "Store.js's header comment."
  }
- TODO: add this radar's own hard-won gotchas here as you hit them — every sibling repo's
  CLAUDE.md has a list like this and it is the single most-read section when something breaks.

${SCHEDULING_SECTION}`

  return fillName(
    [
      "# CLAUDE.md",
      "",
      "This file provides guidance to Claude Code (claude.ai/code) and other AI coding agents when",
      "working with code in this repository. `AGENTS.md` is a symlink to this file — one copy, so the",
      "two can't drift.",
      "",
      "**Scaffolded by `radar-kit/forge` (Radar Forge, FUTURE-PROJECTS.md #9) — read that file's own",
      "README before assuming any TODO below has a fleet-standard answer; most of what makes a radar",
      "worth building is deliberately left for you to decide, not generated.**",
      "",
      whatThisRepoIs,
      "",
      commands,
      "",
      "## Running it manually",
      "",
      "```",
      `cd ${name}`,
      `./launchd/run-${name}-opencode.sh`,
      "npm test",
      "```",
      "",
    ].join("\n"),
    name
  )
}

export function buildReadmeMd(opts) {
  const { name, description, archetype, keyFields, delivery } = opts
  const isServer = archetype === "server"
  return [
    `# ${name}`,
    "",
    description,
    "",
    "*Scaffolded by `radar-kit/forge` (Radar Forge). See `CLAUDE.md` for the architecture and",
    "`DEPLOY-CHECKLIST.md` for what's left to wire into pi-ops/pi-bootstrap.*",
    "",
    "## Decision model",
    "",
    "*The small README section every radar in this fleet carries, per FUTURE-PROJECTS.md #9's",
    'requirement for "a small README that documents the decision model." Fill in each TODO before',
    "this radar's first real run.*",
    "",
    "- **What it tracks:** TODO",
    "- **What counts as a new record vs. a duplicate:** keyed by " +
      keyFields.map((f) => `\`${f}\``).join(" + ") +
      " (see `src/" + opts.camel + "Key.js`). TODO: confirm these are really the fields that make one of this radar's records unique.",
    isServer
      ? "- **What counts as \"changed\"/worth surfacing:** TODO"
      : "- **What counts as \"changed\" (never a reworded summary):** TODO — see `src/" + opts.camel + "Store.js`'s `classifyChange`.",
    "- **Delivery channel:** " +
      (delivery === "digest"
        ? "feed-radar's digest, as an extraSection — never a new email."
        : delivery === "static-board"
          ? "a static board (this repo) " +
            "+ TODO: a public feed, if this radar has a public-facing counterpart (see prize-radar's `bin/publish-prize-hub.js` for the pattern)."
          : "TODO — every existing radar folds into an existing surface rather than adding a channel.") ,
    "- **Cadence and why:** TODO — pick a weekday/time that doesn't collide with another scheduled",
    "  agent on the Pi (`pi-ops/systemd/*.timer` lists every current slot) and, if delivery rides a",
    "  digest, lands before that digest's own send time.",
    "- **Denominator this radar prints (if it's a measurement):** TODO, or N/A if it's a discovery",
    "  loop rather than a report.",
    "",
    "## Setup",
    "",
    "See `DEPLOY-CHECKLIST.md` for the pi-ops timer/health-check registration and the",
    "pi-bootstrap nginx/backup registration this scaffold could not safely do for you.",
    "",
  ].join("\n")
}

export function buildDeployChecklist(opts) {
  const { name, archetype, onCalendar, cadenceNote, port, serverPort } = opts
  const isServer = archetype === "server"
  return [
    "# Deploy checklist",
    "",
    "*Generated by `radar-kit/forge`. These are edits to OTHER repos' hand-curated files",
    "(`pi-ops`, `pi-bootstrap`) — the generator writes the exact content to paste, in",
    "`deploy/`, but does not edit those repos itself: their files carry per-radar comments",
    "and ordering that a blind auto-edit would be more likely to corrupt than help. Do each",
    "step by hand, the same way every existing radar's build recorded doing.*",
    "",
    "## 1. pi-ops — scheduling",
    "",
    `- Copy \`deploy/pi-ops/${name}.service\` and \`deploy/pi-ops/${name}.timer\` into`,
    "  `pi-ops/systemd/`.",
    `- Cadence chosen: \`${onCalendar}\` — ${cadenceNote}. Check this against`,
    "  `pi-ops/systemd/*.timer`'s existing `OnCalendar=` lines before deploying — two radars",
    "  contending for the Pi 4 at the same slot is a real problem other radars' units call out",
    "  explicitly.",
    "- Add a heartbeat line to `pi-ops/heartbeat-check.sh`'s `CHECKS` array:",
    "  ```",
    `  ${name}|$PROJECTS/${name}/logs/last-run.json|336`,
    "  ```",
    "  (336h = 14 days; match whatever the neighboring weekly radars use, or widen for a",
    "  monthly cadence — see the existing table for precedent.)",
    isServer
      ? [
          "- Add a health probe to `pi-ops/heartbeat-check.sh`'s `PROBES` list:",
          "  ```",
          `  ${name}-server|http://127.0.0.1:${serverPort}/api/health`,
          "  ```",
        ].join("\n")
      : "- No health probe needed — this archetype has no long-running server.",
    "- Add this radar to `pi-ops/README.md` / `pi-ops/FLEET.md`'s schedule table (whichever this",
    "  fleet is currently using) so the day-of-week/time collision check stays legible.",
    "- Run `pi-ops/deploy.sh` (or whatever this fleet's current deploy step is) to install and",
    "  enable the new unit + timer on the Pi.",
    "",
    "## 2. pi-bootstrap — routing" + (isServer ? " + backup" : ""),
    "",
    `- Copy \`deploy/pi-bootstrap/nginx-${name}\` into \`pi-bootstrap/nginx/${name}\`.`,
    isServer
      ? [
          `- Add \`"${name}"\` to \`pi-bootstrap/backup-secrets.sh\`'s \`AGENT_REPOS\` array — this is`,
          "  what backs up `.opencode/package.json` (the version pin) and the three mark stores",
          "  (`interested.json` / `ignored.json` / `reviewed.json`) through the existing generic loop.",
          `  No bespoke backup block needed as long as those files stay at the repo root (they do,`,
          "  in the generated \`server/server.js\`).",
          `- Add \`${name}-server.service\` to \`pi-bootstrap/systemd/\` if this radar's server should`,
          "  survive a from-scratch Pi rebuild via pi-bootstrap's own provisioning (check the existing",
          "  `*-server.service` files there for the pattern) — separate from the scheduling unit in",
          "  `pi-ops/systemd/`, which only pi-ops re-installs.",
        ].join("\n")
      : [
          "- No pi-bootstrap backup entry needed — `data/state.json` / `data/digest.json` are",
          "  git-committed by this repo's own weekly run, not Pi-local-only state.",
        ].join("\n"),
    "",
    "## 3. Confirm",
    "",
    `- \`./launchd/run-${name}-opencode.sh\` by hand on the Pi once, watch it complete.`,
    "- `npm test` green.",
    isServer ? `- \`curl http://127.0.0.1:${serverPort}/api/health\` returns \`{"status":"ok"}\`.` : "",
    "- Heartbeat + (if applicable) health probe both show green on the next",
    "  `heartbeat-check.sh` run.",
    "- Record the build in `fleet-docs/UNIFIED-TASKLIST.md` / `DELIVERED.md`, matching this",
    "  fleet's house style (see `fleet-docs/README.md`).",
    "",
  ]
    .filter(Boolean)
    .join("\n")
}
