// scripts/agent-run.sh, the wrappers' shared plumbing, driven through bash
// with a stub `opencode` so nothing calls a model.
import { test } from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, mkdir, writeFile, readFile, chmod } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const LIB = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "agent-run.sh")

// A stub opencode: each call pops the next line of $STUB_PLAN
// ("<exit code> [touch:<relpath>] [say:<text>]") and does it in REPO_DIR.
const STUB = `#!/bin/bash
n=$(cat "$STUB_DIR/calls" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$STUB_DIR/calls"
printf '%s\\n' "$*" > "$STUB_DIR/args-$n"
line=$(sed -n "\${n}p" "$STUB_DIR/plan")
code=\${line%% *}
for word in $line; do
  case "$word" in
    touch:*) mkdir -p "$(dirname "$STUB_REPO/\${word#touch:}")"; touch "$STUB_REPO/\${word#touch:}" ;;
    say:*) echo "\${word#say:}" ;;
  esac
done
exit "\${code:-0}"
`

async function setup(plan) {
  const root = await mkdtemp(path.join(tmpdir(), "agent-run-"))
  const repo = path.join(root, "repo")
  const stubDir = path.join(root, "stub")
  await mkdir(path.join(repo, ".opencode", "commands"), { recursive: true })
  await mkdir(stubDir)
  await writeFile(
    path.join(repo, ".opencode", "commands", "demo.md"),
    "---\ndescription: x\nmodel: openrouter/test-model\n---\nDo the thing.\n\n---\n\nAfter a rule.\n"
  )
  await writeFile(path.join(stubDir, "opencode"), STUB)
  await chmod(path.join(stubDir, "opencode"), 0o755)
  await writeFile(path.join(stubDir, "plan"), plan.join("\n") + "\n")
  return { repo, stubDir }
}

function runWrapper({ repo, stubDir }, body) {
  const script = `set -euo pipefail
REPO_DIR="${repo}"
. "${LIB}"
rk_init demo
rk_pull
rk_load_command "$REPO_DIR/.opencode/commands/demo.md"
rk_cost_begin
${body}
rk_heartbeat
echo "EXIT=$EXIT_CODE STATUS=$STATUS"
exit "$EXIT_CODE"`
  return new Promise((resolve) => {
    execFile("bash", ["-c", script], {
      env: { ...process.env, RK_OPENCODE_BIN: path.join(stubDir, "opencode"), RK_SKIP_PULL: "1", STUB_DIR: stubDir, STUB_REPO: repo },
    }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }))
  })
}

const heartbeat = async (repo) => JSON.parse(await readFile(path.join(repo, "logs", "last-run.json"), "utf8"))

test("a clean run: success, heartbeat written, prompt keeps text after a --- rule", async () => {
  const s = await setup(["0 touch:logs/run-outcome.json"])
  const r = await runWrapper(s, `rk_run_opencode 45m "$MODEL" "$PROMPT"
rk_fail_unless_exists "$REPO_DIR/logs/run-outcome.json" "no outcome."`)
  assert.equal(r.code, 0)
  assert.match(r.stdout, /EXIT=0 STATUS=success/)
  assert.deepEqual({ ...(await heartbeat(s.repo)), timestamp: "x" }, { timestamp: "x", exit_code: 0, status: "success" })
  const args = await readFile(path.join(s.stubDir, "args-1"), "utf8")
  assert.match(args, /-m openrouter\/test-model --auto/)
  assert.match(args, /After a rule\./, "text after a horizontal rule reaches the model")
})

test("exit 0 without the outcome file is incomplete (the silent-stall guard)", async () => {
  const s = await setup(["0"])
  const r = await runWrapper(s, `rk_run_opencode 45m "$MODEL" "$PROMPT"
rk_fail_unless_exists "$REPO_DIR/logs/run-outcome.json" "the model never called record_outcome."`)
  assert.equal(r.code, 1)
  assert.match(r.stdout, /STATUS=incomplete/)
  assert.match(r.stderr, /^demo: opencode exited 0 but the model never called record_outcome/m)
  assert.equal((await heartbeat(s.repo)).status, "incomplete")
})

test("a leftover staging file is incomplete; a real failure is left as it was", async () => {
  const s = await setup(["0 touch:new-items.json"])
  const r = await runWrapper(s, `rk_run_opencode 45m "$MODEL" "$PROMPT"
rk_fail_if_exists "$REPO_DIR/new-items.json" "new-items.json was left behind."`)
  assert.match(r.stdout, /STATUS=incomplete/)

  const f = await setup(["3 touch:new-items.json"])
  const r2 = await runWrapper(f, `rk_run_opencode 45m "$MODEL" "$PROMPT"
rk_fail_if_exists "$REPO_DIR/new-items.json" "left behind."`)
  assert.equal(r2.code, 3)
  assert.match(r2.stdout, /EXIT=3 STATUS=failure/)
})

test("exit 124 is a timeout", async () => {
  const s = await setup(["124"])
  const r = await runWrapper(s, `rk_run_opencode 30m "$MODEL" "$PROMPT"`)
  assert.equal(r.code, 124)
  assert.match(r.stdout, /STATUS=timeout/)
  assert.match(r.stderr, /exceeded the 30m timeout/)
})

test("an unchanged generatedAt is incomplete", async () => {
  const s = await setup(["0"])
  await mkdir(path.join(s.repo, "data"))
  await writeFile(path.join(s.repo, "data", "state.json"), JSON.stringify({ generatedAt: "2026-09-01" }))
  const r = await runWrapper(s, `BEFORE=$(rk_json_field "$REPO_DIR/data/state.json" generatedAt)
rk_run_opencode 45m "$MODEL" "$PROMPT"
AFTER=$(rk_json_field "$REPO_DIR/data/state.json" generatedAt)
rk_fail_if_unchanged "$BEFORE" "$AFTER" "state.json was not rewritten."`)
  assert.match(r.stdout, /STATUS=incomplete/)
})

const RETRY_BODY = `RK_MAX_ATTEMPTS=3
RK_FALLBACK_MODEL=openrouter/fallback
RK_NO_RETRY_MARKER="SENT_DIGEST"
rk_attempt_prompt() { if [ "$1" -eq 1 ]; then printf '%s' "$PROMPT"; else printf '%s\\n\\nRETRY %s' "$PROMPT" "$1"; fi; }
rk_before_attempt() { rm -f "$REPO_DIR/logs/run-outcome.json"; }
rk_attempt_check() { rk_fail_unless_exists "$REPO_DIR/logs/run-outcome.json" "no outcome."; }
rk_run_with_retries 45m
echo "ATTEMPTS=$RK_ATTEMPTS"`

test("retries: a derailed first attempt is retried on the fallback model with a notice", async () => {
  const s = await setup(["0", "0 touch:logs/run-outcome.json"])
  const r = await runWrapper(s, RETRY_BODY)
  assert.equal(r.code, 0)
  assert.match(r.stdout, /ATTEMPTS=2/)
  assert.match(await readFile(path.join(s.stubDir, "args-2"), "utf8"), /-m openrouter\/fallback .*RETRY 2/s)
})

test("retries: never past the non-idempotent marker, and never more than the max", async () => {
  const sent = await setup(["1 say:SENT_DIGEST", "0 touch:logs/run-outcome.json"])
  const r = await runWrapper(sent, RETRY_BODY)
  assert.equal(r.code, 1)
  assert.match(r.stdout, /ATTEMPTS=1/)
  assert.match(r.stderr, /not retrying/)

  const stuck = await setup(["1", "1", "1", "0"])
  const r2 = await runWrapper(stuck, RETRY_BODY)
  assert.match(r2.stdout, /ATTEMPTS=3/)
  assert.equal(r2.code, 1)
})

test("rk_load_command refuses a command file with no model line", async () => {
  const s = await setup(["0"])
  await writeFile(path.join(s.repo, ".opencode", "commands", "demo.md"), "---\ndescription: x\n---\nbody\n")
  const r = await runWrapper(s, "")
  assert.notEqual(r.code, 0)
  assert.match(r.stderr, /failed to extract model\/prompt/)
})
