// Per-run cost for the digest scorecard footer.
//
// buildScorecard has always had a `costUsd` slot; nothing filled it because
// opencode doesn't hand the run wrapper a generation id to look up. This
// takes the other route: OpenRouter's `/api/v1/auth/key` reports a
// lifetime, monotonic `usage` total (USD) for the inference key, and the
// difference across a run is what that run cost. No management/provisioning
// key needed — the inference key can read its own usage. eink-app reads the
// same account a different way (its own `/api/v1/activity` + `/api/v1/keys`
// panel); this is deliberately lighter.
//
// The catch, documented so nobody re-discovers it: the delta is only clean
// if nothing else spends on the same key during the run. The four digest
// agents are staggered across the week and `shelf-recognize` uses a
// different key, so in practice a run has the key to itself — but a manual
// `opencode` session on the Pi at the same time would inflate the figure.
// It is a footer number, not a bill; that tradeoff is fine.

import { readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const AUTH_KEY_URL = "https://openrouter.ai/api/v1/auth/key"
const DEFAULT_AUTH_JSON = path.join(
  os.homedir(),
  ".local/share/opencode/auth.json"
)

/**
 * The OpenRouter inference key opencode uses, from its auth store.
 * Returns null (not throws) when the file or key is absent — a missing key
 * must degrade the footer, never fail a run.
 */
export async function readOpencodeKey(authJsonPath = DEFAULT_AUTH_JSON) {
  let parsed
  try {
    parsed = JSON.parse(await readFile(authJsonPath, "utf8"))
  } catch {
    return null
  }
  const key = parsed?.openrouter?.key
  return typeof key === "string" && key.length > 0 ? key : null
}

/**
 * Lifetime USD spent on `apiKey`, as a number. Monotonic — OpenRouter never
 * resets it — so a plain `after - before` is the run cost, no wraparound
 * handling. Throws on a network/HTTP error so the caller can decide (the
 * wrapper treats any failure as "no cost this run").
 *
 * @param {string} apiKey
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number }} [opts]
 * @returns {Promise<number>}
 */
export async function keyUsage(apiKey, { fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetchImpl(AUTH_KEY_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: ac.signal,
    })
    if (!res.ok) {
      throw new Error(`OpenRouter /auth/key returned ${res.status}`)
    }
    const body = await res.json()
    const usage = body?.data?.usage
    if (typeof usage !== "number" || !Number.isFinite(usage)) {
      throw new Error("OpenRouter /auth/key response had no numeric data.usage")
    }
    return usage
  } finally {
    clearTimeout(timer)
  }
}
