#!/usr/bin/env node
// Radar Forge's CLI. Run by hand on the Mac (never scheduled, never
// deployed) to scaffold a new radar repo. See forge/README.md for the
// restraint this generator follows — what's templated vs. left for a
// person to decide — before adding a new flag or a new generated file.
//
// Usage:
//   node forge/create-radar.js --name <kebab-name> --archetype server|static \
//     --key-fields title,date [--dest ~/Projects] [--description "..."] \
//     [--port 8036] [--cadence "Thu *-*-* 09:00:00"] [--cadence-note "..."] \
//     [--model openrouter/z-ai/glm-5.3-flash] [--delivery digest|static-board|none] \
//     [--plugin-pin 1.18.29] [--force]
//
// Run `node forge/create-radar.js --help` for the full flag list.

import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { fileURLToPath } from "node:url"

import { toKebab, toCamel, toPascal, parseKeyFields, jsStringArray } from "./lib/naming.js"
import { buildFiles } from "./lib/templates.js"
import { buildClaudeMd, buildReadmeMd, buildDeployChecklist } from "./lib/claudeAndReadme.js"
import { buildCommandMd, buildPluginToolsJs } from "./lib/opencodeFiles.js"
import { buildServerJs, buildIndexHtml } from "./lib/serverAndSite.js"
import { buildWrapperSh, buildSystemdService, buildSystemdTimer, buildNginx } from "./lib/deployFiles.js"
import { buildTestFile } from "./lib/testFile.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function parseArgs(argv) {
  const args = { archetype: "server", delivery: "digest", model: "openrouter/z-ai/glm-5.3-flash" }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--help" || a === "-h") {
      args.help = true
      continue
    }
    if (a === "--force") {
      args.force = true
      continue
    }
    if (a.startsWith("--")) {
      const key = a.slice(2)
      const val = argv[i + 1]
      args[key] = val
      i++
    }
  }
  return args
}

function usage() {
  return `
Radar Forge — scaffold a new radar repo.

Required:
  --name <kebab-name>          e.g. signal-radar
  --key-fields <a,b,c>         fields that make a record unique, e.g. title,date
                                (see FUTURE-PROJECTS.md #9 — this is the one part of
                                every generated radar that ships as exported code,
                                never a convention reimplemented per caller)

Common:
  --archetype server|static    server = always-on interest-server + marks (default;
                                  matches event-watch/job-radar/release-radar/feed-radar/
                                  serendipity-radar). static = no server, git-committed
                                  data/state.json + data/digest.json, a weekly run
                                  commits+pushes it itself (matches prize-radar/skyline-radar).
  --description "..."          one line, goes in package.json + README.md
  --dest <dir>                 parent directory to create the repo in (default: ~/Projects)
  --port <n>                   nginx/board port for this radar (default: next free port
                                  above 8035, the highest currently in use — VERIFY this
                                  against pi-bootstrap/nginx/* before deploying; forge does
                                  not have live access to the Pi's actual port table).
                                  server archetype: the backend interest-server runs at
                                  port+1 (the fleet's own convention — see serendipity-radar:
                                  nginx 8024 / server 8025).
  --cadence "<OnCalendar>"     systemd OnCalendar value, e.g. "Thu *-*-* 09:00:00"
                                  (default: "Mon *-*-* 09:00:00" — CHANGE THIS, the default
                                  is a placeholder, not a collision check)
  --cadence-note "..."         one-line reason for the chosen slot (recorded in the
                                  generated timer + README, matching every existing radar's
                                  own commented OnCalendar line)
  --delivery digest|static-board|none
                                default: digest for --archetype server, static-board for
                                --archetype static
  --model <model-id>           default: openrouter/z-ai/glm-5.3-flash
  --plugin-pin <version>        @opencode-ai/plugin version to pin in .opencode/package.json
                                  (default: read from an existing sibling repo if one is
                                  found next to --dest, else a hardcoded fallback — CONFIRM
                                  against the Pi's real \`opencode --version\` before deploying)
  --force                      overwrite an existing directory at the destination

  --help                       print this message
`
}

function findExistingPluginPin(destParent) {
  // Best-effort: read a sibling repo's .opencode/package.json so a newly
  // generated radar doesn't ship a stale pin. Never fails the run if none
  // is found.
  try {
    const candidates = fs.readdirSync(destParent, { withFileTypes: true })
    for (const entry of candidates) {
      if (!entry.isDirectory()) continue
      const pkgPath = path.join(destParent, entry.name, ".opencode", "package.json")
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"))
        const pin = pkg?.dependencies?.["@opencode-ai/plugin"]
        if (pin) return pin
      }
    }
  } catch {
    // best-effort
  }
  return null
}

function findNextFreePort(destParent) {
  // Best-effort scan of sibling repos' nginx/server files for the highest
  // port already claimed. This is NOT a substitute for checking the Pi's
  // real pi-bootstrap/nginx/* and pi-ops/systemd/* — it only sees what's
  // checked out locally, which may be stale or incomplete.
  let max = 8035
  try {
    const candidates = fs.readdirSync(destParent, { withFileTypes: true })
    for (const entry of candidates) {
      if (!entry.isDirectory()) continue
      for (const rel of ["opencode.json", "server/server.js"]) {
        const p = path.join(destParent, entry.name, rel)
        if (!fs.existsSync(p)) continue
        const text = fs.readFileSync(p, "utf8")
        const matches = text.matchAll(/\b(80[0-9]{2})\b/g)
        for (const m of matches) {
          const n = parseInt(m[1], 10)
          if (n > max) max = n
        }
      }
    }
  } catch {
    // best-effort
  }
  return max + 1
}

function writeFileEnsuringDir(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  if (args.help || !args.name) {
    console.log(usage())
    if (!args.name && !args.help) process.exitCode = 1
    return
  }

  const name = toKebab(args.name)
  const camel = toCamel(name)
  const pascal = toPascal(name)
  const archetype = args.archetype === "static" ? "static" : "server"
  const isServer = archetype === "server"

  if (!args["key-fields"]) {
    console.error("Error: --key-fields is required, e.g. --key-fields title,date")
    console.error(usage())
    process.exitCode = 1
    return
  }
  const keyFields = parseKeyFields(args["key-fields"])
  const keyFieldsJs = jsStringArray(keyFields)

  const destParent = args.dest ? path.resolve(args.dest.replace(/^~/, os.homedir())) : path.join(os.homedir(), "Projects")
  const destDir = path.join(destParent, name)

  if (fs.existsSync(destDir) && !args.force) {
    console.error(`Error: ${destDir} already exists. Pass --force to overwrite (files are added/replaced, not wiped first).`)
    process.exitCode = 1
    return
  }

  const description = args.description || `TODO: one-line description of what ${name} tracks.`
  const delivery = args.delivery || (isServer ? "digest" : "static-board")
  const model = args.model
  const cadenceOnCalendar = args.cadence || "Mon *-*-* 09:00:00"
  const cadenceNote =
    args["cadence-note"] ||
    "TODO: placeholder slot — pick a real weekday/time and record why here, checked against every OnCalendar= already in pi-ops/systemd/*.timer."
  const pluginPin = args["plugin-pin"] || findExistingPluginPin(destParent) || "1.18.29"
  const port = args.port ? parseInt(args.port, 10) : findNextFreePort(destParent)
  const serverPort = port + 1

  const opts = {
    name,
    camel,
    pascal,
    description,
    archetype,
    keyFields,
    keyFieldsJs,
    port,
    serverPort,
    model,
    onCalendar: cadenceOnCalendar,
    cadenceNote,
    delivery,
    pluginPin,
  }

  const files = {}

  // Core files shared by both archetypes (templates.js).
  Object.assign(files, buildFiles(opts))

  // Docs.
  files["CLAUDE.md"] = buildClaudeMd(opts)
  files["AGENTS.md"] = null // symlink, created separately below
  files["README.md"] = buildReadmeMd(opts)
  files["DEPLOY-CHECKLIST.md"] = buildDeployChecklist(opts)

  // opencode command + plugin.
  files[`.opencode/commands/${name}.md`] = buildCommandMd({ ...opts, isServer })
  files[`.opencode/plugins/${name}-tools.js`] = buildPluginToolsJs(opts)

  // Server + site (server archetype gets server.js; both get index.html).
  if (isServer) {
    files["server/server.js"] = buildServerJs(opts)
  }
  files["index.html"] = buildIndexHtml(opts)

  // Test.
  files[`test/${camel}.test.js`] = buildTestFile(opts)

  // Deploy artifacts — generated for hand-copying into pi-ops/pi-bootstrap,
  // never auto-applied to those repos. See DEPLOY-CHECKLIST.md.
  files[`deploy/pi-ops/${name}.service`] = buildSystemdService(opts)
  files[`deploy/pi-ops/${name}.timer`] = buildSystemdTimer(opts)
  files[`deploy/pi-bootstrap/nginx-${name}`] = buildNginx(opts)

  // launchd wrapper (dead-history name, matches every sibling repo's own
  // convention — see CLAUDE.md's "Scheduling lives on the Pi" section).
  files[`launchd/run-${name}-opencode.sh`] = buildWrapperSh(opts)

  // Write everything.
  let count = 0
  for (const [rel, content] of Object.entries(files)) {
    if (content === null) continue // handled separately (symlinks)
    writeFileEnsuringDir(path.join(destDir, rel), content)
    count++
  }

  // AGENTS.md -> CLAUDE.md symlink, matching every sibling repo. rmSync
  // with force:true is a no-op if nothing is there yet, and removes a
  // stale symlink (not CLAUDE.md itself) if --force is re-running this.
  const agentsPath = path.join(destDir, "AGENTS.md")
  fs.rmSync(agentsPath, { force: true })
  fs.symlinkSync("CLAUDE.md", agentsPath)

  // Executable bit on the wrapper, matching every sibling repo.
  fs.chmodSync(path.join(destDir, "launchd", `run-${name}-opencode.sh`), 0o755)

  // Empty data/ and logs/ dirs so a first-run doesn't need mkdir -p by hand.
  fs.mkdirSync(path.join(destDir, "data"), { recursive: true })
  fs.mkdirSync(path.join(destDir, "logs"), { recursive: true })

  console.log(`Scaffolded ${name} (${archetype} archetype) at ${destDir} — ${count} files + AGENTS.md symlink.`)
  console.log("")
  console.log("Next steps:")
  console.log(`  1. cd ${destDir} && npm test   # the scaffold's own tests should pass as-is`)
  console.log("  2. Fill in every TODO — start with CLAUDE.md, README.md's Decision model section,")
  console.log(`     .opencode/commands/${name}.md's real prompt, and src/${camel}Store.js's real logic.`)
  console.log("  3. Read DEPLOY-CHECKLIST.md for the pi-ops/pi-bootstrap registration steps —")
  console.log("     those are NOT applied automatically.")
  console.log(`  4. git init, first commit, push to github:mcmar47/${name} (or wherever this fleet's repos live).`)
  console.log("")
  console.log(`Ports chosen: board/nginx ${port}` + (isServer ? `, interest-server ${serverPort}` : "") + " — VERIFY these are free before deploying (forge only scanned local sibling repos, not the Pi).")
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
