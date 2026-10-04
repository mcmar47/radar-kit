// The Continuum in-app push channel: the best-effort POST to the
// continuum-push service on the Pi, its header-injection guard, and the
// per-radar summary wording buildSummary produces. Sibling of ntfy.test.js.

import { test } from "node:test"
import assert from "node:assert/strict"

import { sendContinuumPush, buildSummary } from "../src/continuumPush.js"

// ---------------------------------------------------------------------------
// sendContinuumPush — fetch is stubbed
// ---------------------------------------------------------------------------

test("sendContinuumPush POSTs title/body/deepLink as JSON to the push endpoint", async () => {
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return { ok: true }
  }
  try {
    const ok = await sendContinuumPush({
      title: "5 new feed picks",
      body: "A · B · C — and 2 more",
      deepLink: "continuum://inbox",
    })
    assert.equal(ok, true)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, "http://127.0.0.1:8031/api/push")
    assert.equal(calls[0].init.method, "POST")
    const sent = JSON.parse(calls[0].init.body)
    assert.deepEqual(sent, {
      title: "5 new feed picks",
      body: "A · B · C — and 2 more",
      deepLink: "continuum://inbox",
    })
  } finally {
    globalThis.fetch = realFetch
  }
})

test("sendContinuumPush flattens CR/LF out of title and body", async () => {
  let seen
  const realFetch = globalThis.fetch
  globalThis.fetch = async (_url, init) => {
    seen = JSON.parse(init.body)
    return { ok: true }
  }
  try {
    await sendContinuumPush({ title: "one\r\ntwo", body: "a\nb" })
    assert.equal(seen.title, "one two")
    assert.equal(seen.body, "a b")
  } finally {
    globalThis.fetch = realFetch
  }
})

test("sendContinuumPush never throws: network failure → false, missing title → false", async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => {
    throw new Error("ECONNREFUSED")
  }
  try {
    assert.equal(await sendContinuumPush({ title: "x", body: "y" }), false)
  } finally {
    globalThis.fetch = realFetch
  }
  assert.equal(await sendContinuumPush({ title: "", body: "y" }), false)
})

test("sendContinuumPush returns false on a non-2xx response", async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: false, status: 503 })
  try {
    assert.equal(await sendContinuumPush({ title: "x", body: "y" }), false)
  } finally {
    globalThis.fetch = realFetch
  }
})

// ---------------------------------------------------------------------------
// buildSummary
// ---------------------------------------------------------------------------

test("buildSummary: null when there is nothing to say", () => {
  assert.equal(buildSummary([], { noun: "event" }), null)
  assert.equal(buildSummary(undefined, { noun: "event" }), null)
})

test("buildSummary: one item keeps the noun singular", () => {
  const s = buildSummary([{ title: "WWDC keynote" }], { noun: "event" })
  assert.deepEqual(s, {
    title: "1 new event",
    body: "WWDC keynote",
    deepLink: "continuum://inbox",
  })
})

test("buildSummary: many items → count + lead titles + remainder", () => {
  const items = ["A", "B", "C", "D", "E"].map((t) => ({ title: t }))
  const s = buildSummary(items, { noun: "feed pick" })
  assert.equal(s.title, "5 new feed picks")
  assert.equal(s.body, "A · B · C — and 2 more")
})

test("buildSummary: custom titleField, whitespace collapsed, deepLink overridable", () => {
  const s = buildSummary([{ headline: "  a\n b " }, { headline: "c" }], {
    noun: "job posting",
    titleField: "headline",
    deepLink: "continuum://inbox?radar=jobs",
  })
  assert.equal(s.title, "2 new job postings")
  assert.equal(s.body, "a b · c")
  assert.equal(s.deepLink, "continuum://inbox?radar=jobs")
})

// ---------------------------------------------------------------------------
// ntfy fan-out — the path that reaches the phone when the app isn't installed
// ---------------------------------------------------------------------------

import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

test("sendContinuumPush also posts to the digest ntfy topic, ASCII title, http click only", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "digest-topic-"))
  const topicFile = path.join(dir, "topic")
  await writeFile(topicFile, "my-digest-topic\n")
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return { ok: true }
  }
  try {
    const ok = await sendContinuumPush({
      title: "Research Desk — answered",
      body: "café?",
      deepLink: "continuum://inbox",
      clickUrl: "http://continuum.example:8022/listen.html",
      digestTopicFile: topicFile,
    })
    assert.equal(ok, true)
    const ntfy = calls.find((c) => String(c.url).startsWith("https://ntfy.sh/"))
    assert.ok(ntfy, "ntfy POST made")
    assert.equal(ntfy.url, "https://ntfy.sh/my-digest-topic")
    assert.equal(ntfy.init.headers.Title, "Research Desk - answered")
    assert.equal(ntfy.init.headers.Click, "http://continuum.example:8022/listen.html")
    assert.equal(ntfy.init.body, "café?")
    assert.ok(calls.some((c) => String(c.url).includes("/api/push")), "APNs POST still made")
  } finally {
    globalThis.fetch = realFetch
    await rm(dir, { recursive: true, force: true })
  }
})

test("sendContinuumPush: ntfy delivers even when the APNs bridge is down; continuum:// is never a Click", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "digest-topic-"))
  const topicFile = path.join(dir, "topic")
  await writeFile(topicFile, "t")
  let ntfyInit
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith("https://ntfy.sh/")) {
      ntfyInit = init
      return { ok: true }
    }
    throw new Error("ECONNREFUSED")
  }
  try {
    const ok = await sendContinuumPush({ title: "x", body: "y", deepLink: "continuum://inbox", digestTopicFile: topicFile })
    assert.equal(ok, true)
    assert.equal(ntfyInit.headers.Click, undefined)
  } finally {
    globalThis.fetch = realFetch
    await rm(dir, { recursive: true, force: true })
  }
})
