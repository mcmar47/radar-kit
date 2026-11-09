// Radar Forge's promise is that a scaffold's own tests pass as generated. Its
// first real use (deep-radar, 2026-11-09) found they didn't, so this generates
// both archetypes and runs them, with radar-kit linked in where npm install
// would put it.
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const KIT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")

function scaffold(archetype, setup = () => {}) {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "forge-test-"))
  setup(dest)
  execFileSync(process.execPath, [
    path.join(KIT, "forge/create-radar.js"),
    "--name", "probe-radar", "--archetype", archetype, "--key-fields", "id", "--dest", dest,
  ], { stdio: "pipe" })
  return { dest, repo: path.join(dest, "probe-radar") }
}

for (const archetype of ["static", "server"]) {
  test(`${archetype} scaffold's own tests pass as generated`, () => {
    const { dest, repo } = scaffold(archetype)
    try {
      assert.equal(JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")).dependencies["radar-kit"], "github:mcmar47/radar-kit")
      fs.mkdirSync(path.join(repo, "node_modules"))
      fs.symlinkSync(KIT, path.join(repo, "node_modules", "radar-kit"))
      const run = spawnSync(process.execPath, ["--test"], { cwd: repo, encoding: "utf8" })
      assert.equal(run.status, 0, run.stdout + run.stderr)
    } finally {
      fs.rmSync(dest, { recursive: true, force: true })
    }
  })
}

test("scaffold pins small_model", () => {
  const { dest, repo } = scaffold("static")
  try {
    const config = JSON.parse(fs.readFileSync(path.join(repo, "opencode.json"), "utf8"))
    assert.ok(config.small_model)
    assert.equal(config.small_model, config.model)
  } finally {
    fs.rmSync(dest, { recursive: true, force: true })
  }
})

test("port scan skips ports claimed by nginx vhosts and fleet.json", () => {
  const { dest, repo } = scaffold("static", (d) => {
    fs.mkdirSync(path.join(d, "pi-bootstrap", "nginx"), { recursive: true })
    fs.writeFileSync(path.join(d, "pi-bootstrap", "nginx", "hub"), "server {\n    listen 8036;\n    listen [::]:8036;\n}\n")
    fs.mkdirSync(path.join(d, "pi-ops"))
    fs.writeFileSync(path.join(d, "pi-ops", "fleet.json"), '{ "services": [{ "port": 8041 }] }')
  })
  try {
    assert.match(fs.readFileSync(path.join(repo, "deploy/pi-bootstrap/nginx-probe-radar"), "utf8"), /listen 8042;/)
  } finally {
    fs.rmSync(dest, { recursive: true, force: true })
  }
})
