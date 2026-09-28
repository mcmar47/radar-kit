# Shared plumbing for the agents' run wrappers (launchd/run-*-opencode.sh).
# Sourced, not executed:
#
#   REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
#   . "$REPO_DIR/.opencode/node_modules/radar-kit/scripts/agent-run.sh" \
#     || { echo "radar-kit's agent-run.sh is missing (run pi-ops/update-radar-kit.sh)" >&2; exit 1; }
#   rk_init event-watch
#   rk_pull
#   rk_load_command "$REPO_DIR/.opencode/commands/event-watch.md"
#   rk_cost_begin
#   rk_run_opencode 45m "$MODEL" "$PROMPT"
#   rk_fail_unless_exists "$REPO_DIR/logs/run-outcome.json" "the model never called record_outcome"
#   rk_cost_record
#   rk_heartbeat
#   exit "$EXIT_CODE"
#
# Nine wrappers used to carry ~1,700 lines between them, about 70% of it the
# same (UNIFICATION-PROS-CONS.md L1.5 step 1, done 2026-09-28). A fix to that
# shared part had to be hand-copied nine times and wasn't always. What stays in
# each wrapper is what's actually specific to it: its pre-run steps, its prompt
# additions, which completion guard fits, and anything after the run.
#
# Conventions:
#   - Functions set globals (MODEL, PROMPT, EXIT_CODE, STATUS, ...) rather
#     than echoing values, so the wrappers read like the scripts they replace.
#   - Every message is prefixed with "$RK_NAME:" so the journal says whose it is.
#   - Guards only ever downgrade a success (EXIT_CODE 0) to a failure; they
#     never touch a run that already failed.
#   - Wrappers keep `set -euo pipefail`; nothing here relies on it being off.
#
# Test hooks (used by radar-kit's own tests, never set in production):
#   RK_OPENCODE_BIN overrides the opencode binary; RK_SKIP_PULL=1 skips git pull.

# rk_init NAME: PATH, the opencode binary, the radar-kit paths, logs/, and cd
# into REPO_DIR (which the wrapper sets first, from its own location).
rk_init() {
  RK_NAME="${1:?rk_init needs the agent name}"
  : "${REPO_DIR:?set REPO_DIR before rk_init}"
  export PATH="$HOME/.opencode/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:$PATH"
  OPENCODE_BIN="${RK_OPENCODE_BIN:-$(command -v opencode || echo "$HOME/.opencode/bin/opencode")}"
  RADAR_KIT_DIR="$REPO_DIR/.opencode/node_modules/radar-kit"
  RUNS_FILE="$REPO_DIR/logs/digest-runs.json"
  TIMEOUT_BIN="$(command -v timeout || true)"
  EXIT_CODE=1
  STATUS="failure"
  mkdir -p "$REPO_DIR/logs"
  cd "$REPO_DIR"
}

# rk_load_env FILE: export every variable in an env file, if it exists.
rk_load_env() {
  if [ -f "$1" ]; then
    set -a
    # shellcheck disable=SC1090
    . "$1"
    set +a
  fi
}

# rk_pull: fast-forward to origin/main. Fails the run (set -e) on a diverged
# branch rather than running stale code.
rk_pull() {
  [ "${RK_SKIP_PULL:-}" = "1" ] && return 0
  git pull --ff-only origin main
}

# rk_load_command FILE: MODEL from the frontmatter's model: line, PROMPT from
# everything after the frontmatter, DIGEST_MODEL exported (radar-kit's
# scorecard footer labels the run with it). opencode run doesn't resolve
# custom slash commands, which is why every wrapper does this itself. The awk
# prints only after the second --- fence: it used to skip EVERY ^---$ line, so
# a horizontal rule in a prompt silently vanished.
rk_load_command() {
  local file="${1:?rk_load_command needs the command file}"
  MODEL=$(sed -n 's/^model: *//p' "$file" | head -1)
  PROMPT=$(awk 'c>=2; /^---$/{c++}' "$file")
  if [ -z "$MODEL" ] || [ -z "$PROMPT" ]; then
    echo "$RK_NAME: failed to extract model/prompt from $file — aborting." >&2
    return 1
  fi
  export DIGEST_MODEL="$MODEL"
}

# rk_cost_begin / rk_cost_record: the per-run OpenRouter spend on the
# scorecard footer and in logs/digest-runs.json (radar-kit scripts/run-cost.js).
# Best-effort both ways: no key or a network blip just drops the figure.
rk_cost_begin() {
  RUN_START=$(date -u +%Y-%m-%dT%H:%M:%S)
  USAGE_BEFORE=""
  if [ -f "$RADAR_KIT_DIR/scripts/run-cost.js" ]; then
    USAGE_BEFORE=$(node "$RADAR_KIT_DIR/scripts/run-cost.js" read 2>/dev/null || true)
  fi
}
rk_cost_record() {
  if [ -n "${USAGE_BEFORE:-}" ] && [ -f "$RADAR_KIT_DIR/scripts/run-cost.js" ]; then
    node "$RADAR_KIT_DIR/scripts/run-cost.js" record "$RUNS_FILE" "$USAGE_BEFORE" "$RUN_START" || true
  fi
}

# rk_run_opencode TIMEOUT MODEL PROMPT [OUT ERR]: one `opencode run` under a
# hard ceiling (timeout exits 124, then SIGKILL 2 minutes later), so a wedged
# LLM stream can't hold the oneshot open forever with no alert. Sets
# EXIT_CODE and STATUS (success | failure | timeout). With OUT and ERR, stdout
# and stderr are also tee'd to those files (the retry loop greps them).
rk_run_opencode() {
  local limit="${1:?timeout}" model="${2:?model}" prompt="${3:?prompt}" out="${4:-}" err="${5:-}"
  local cmd=("$OPENCODE_BIN" run -m "$model" --auto "$prompt")
  if [ -n "$TIMEOUT_BIN" ]; then
    cmd=("$TIMEOUT_BIN" --kill-after=2m "$limit" "${cmd[@]}")
  fi
  local rc=0
  if [ -n "$out" ]; then
    "${cmd[@]}" > >(tee "$out") 2> >(tee "$err" >&2) || rc=$?
    sleep 2 # let the tee processes flush before anything reads the files
  else
    "${cmd[@]}" || rc=$?
  fi
  EXIT_CODE=$rc
  if [ "$rc" -eq 0 ]; then
    STATUS="success"
  elif [ "$rc" -eq 124 ]; then
    STATUS="timeout"
    echo "$RK_NAME: opencode run exceeded the $limit timeout and was killed -- treating as a hung run." >&2
  else
    STATUS="failure"
  fi
}

# The completion guards. `opencode run` exits 0 even when the model gives up
# partway with no error, so each wrapper checks for evidence the pipeline
# actually finished, and turns a hollow success into a failure (so
# OnFailure=agent-alert@ fires). Each only acts on EXIT_CODE 0.
rk_incomplete() {
  echo "$RK_NAME: opencode exited 0 but $1 Treating as a failed run." >&2
  EXIT_CODE=1
  STATUS="incomplete"
}
# rk_fail_if_exists FILE WHY: a staging file still there means the send or
# the record step never ran.
rk_fail_if_exists() {
  [ "$EXIT_CODE" -eq 0 ] && [ -e "$1" ] && rk_incomplete "$2"
  return 0
}
# rk_fail_unless_exists FILE WHY: the outcome file record_outcome writes.
rk_fail_unless_exists() {
  [ "$EXIT_CODE" -eq 0 ] && [ ! -e "$1" ] && rk_incomplete "$2"
  return 0
}
# rk_json_field FILE FIELD: print a top-level field of a JSON file ("" on any error).
rk_json_field() {
  node -e 'try{process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))[process.argv[2]]??""))}catch{}' "$1" "$2" 2>/dev/null || true
}
# rk_fail_if_unchanged BEFORE AFTER WHY: an output file's generatedAt must have moved.
rk_fail_if_unchanged() {
  if [ "$EXIT_CODE" -eq 0 ] && { [ -z "$2" ] || [ "$2" = "$1" ]; }; then rk_incomplete "$3"; fi
  return 0
}

# rk_heartbeat [FILE]: what pi-ops' heartbeat-check.sh reads, after every run.
rk_heartbeat() {
  local file="${1:-$REPO_DIR/logs/last-run.json}"
  mkdir -p "$(dirname "$file")"
  printf '{"timestamp": "%s", "exit_code": %s, "status": "%s"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$EXIT_CODE" "$STATUS" > "$file"
}

# rk_run_with_retries TIMEOUT: up to RK_MAX_ATTEMPTS fresh opencode sessions,
# for agents whose failures are the model derailing rather than anything
# deterministic (feed-radar, serendipity-radar). The wrapper defines:
#   rk_attempt_prompt N   echo the prompt for attempt N (1 = the base prompt)
#   rk_attempt_check      optional: a completion guard run after each attempt
#   rk_before_attempt N   optional: e.g. clear an outcome file
# and sets RK_MAX_ATTEMPTS (3), RK_RETRY_DEADLINE_SECS (3600), RK_FALLBACK_MODEL
# (attempts 2+ run on it) and RK_NO_RETRY_MARKER: text that, if it appears in
# an attempt's output, means it reached a non-idempotent step (a send, a
# write), so it must not be retried. Sets EXIT_CODE, STATUS and RK_ATTEMPTS.
rk_run_with_retries() {
  local limit="${1:?timeout}" max="${RK_MAX_ATTEMPTS:-3}" deadline="${RK_RETRY_DEADLINE_SECS:-3600}"
  local t0=$SECONDS attempt model prompt out err logdir
  logdir="$(mktemp -d)"
  RK_ATTEMPTS=0
  for ((attempt = 1; attempt <= max; attempt++)); do
    RK_ATTEMPTS=$attempt
    if [ "$attempt" -eq 1 ]; then model="$MODEL"; else model="${RK_FALLBACK_MODEL:?set RK_FALLBACK_MODEL}"; fi
    prompt="$(rk_attempt_prompt "$attempt")"
    export DIGEST_MODEL="$model"
    echo "$RK_NAME: attempt $attempt/$max with model $model" >&2
    if declare -F rk_before_attempt >/dev/null; then rk_before_attempt "$attempt"; fi
    out="$logdir/attempt-$attempt.out"
    err="$logdir/attempt-$attempt.err"
    rk_run_opencode "$limit" "$model" "$prompt" "$out" "$err"
    if declare -F rk_attempt_check >/dev/null; then rk_attempt_check; fi
    [ "$EXIT_CODE" -eq 0 ] && break
    if [ -n "${RK_NO_RETRY_MARKER:-}" ] && grep -aqs -- "$RK_NO_RETRY_MARKER" "$out" "$err"; then
      echo "$RK_NAME: attempt $attempt reached '$RK_NO_RETRY_MARKER' before failing -- not retrying." >&2
      break
    fi
    [ "$attempt" -eq "$max" ] && break
    if [ $((SECONDS - t0)) -ge "$deadline" ]; then
      echo "$RK_NAME: $((SECONDS - t0))s elapsed, past the retry deadline -- giving up." >&2
      break
    fi
    echo "$RK_NAME: attempt $attempt ended '$STATUS' -- retrying on $RK_FALLBACK_MODEL." >&2
  done
  rm -rf "$logdir"
}
