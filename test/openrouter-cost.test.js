import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { readOpencodeKey, keyUsage } from "../src/openrouterCost.js"

async function withTempFile(name, contents, fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "radar-kit-cost-"))
  const file = path.join(dir, name)
  await writeFile(file, contents)
  try {
    return await fn(file)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test("readOpencodeKey pulls .openrouter.key out of the auth store", async () => {
  await withTempFile("auth.json", JSON.stringify({ openrouter: { type: "api", key: "sk-or-test" } }), async (file) => {
    assert.equal(await readOpencodeKey(file), "sk-or-test")
  })
})

test("readOpencodeKey returns null for a missing file or absent key", async () => {
  assert.equal(await readOpencodeKey("/no/such/auth.json"), null)
  await withTempFile("auth.json", JSON.stringify({ anthropic: { key: "x" } }), async (file) => {
    assert.equal(await readOpencodeKey(file), null)
  })
  await withTempFile("auth.json", "{ not json", async (file) => {
    assert.equal(await readOpencodeKey(file), null)
  })
})

test("keyUsage returns data.usage from /api/v1/auth/key", async () => {
  const fetchImpl = async (url, opts) => {
    assert.match(url, /\/api\/v1\/auth\/key$/)
    assert.equal(opts.headers.Authorization, "Bearer sk-or-test")
    return { ok: true, json: async () => ({ data: { usage: 24.93257 } }) }
  }
  assert.equal(await keyUsage("sk-or-test", { fetchImpl }), 24.93257)
})

test("keyUsage throws on an HTTP error or a non-numeric usage", async () => {
  await assert.rejects(
    keyUsage("k", { fetchImpl: async () => ({ ok: false, status: 401 }) }),
    /returned 401/
  )
  await assert.rejects(
    keyUsage("k", { fetchImpl: async () => ({ ok: true, json: async () => ({ data: {} }) }) }),
    /no numeric data\.usage/
  )
})
