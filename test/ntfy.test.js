// The ntfy push channel (NEW-IDEAS.md C4): the topic-file read, the POST
// itself, the "exactly one imminent item" filter, and the continuum:// deep
// link the notification taps through to.

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { readPushTopic, sendNtfyPush } from "../src/ntfy.js"
import { soleImminentItem, continuumItemLink } from "../src/highlight.js"

// ---------------------------------------------------------------------------
// readPushTopic
// ---------------------------------------------------------------------------

test("readPushTopic returns the trimmed topic, or null when absent/empty", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ntfy-"))
  const file = path.join(dir, "ntfy-push-topic")

  assert.equal(await readPushTopic(file), null, "missing file → null")

  await writeFile(file, "  my-secret-topic\n")
  assert.equal(await readPushTopic(file), "my-secret-topic")

  await writeFile(file, "   \n")
  assert.equal(await readPushTopic(file), null, "whitespace-only → null")

  await rm(dir, { recursive: true })
})

// ---------------------------------------------------------------------------
// sendNtfyPush — fetch is stubbed
// ---------------------------------------------------------------------------

test("sendNtfyPush POSTs to the topic URL with Title/Click/Priority/Tags headers", async () => {
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return { ok: true }
  }
  try {
    const ok = await sendNtfyPush({
      topic: "abc123",
      title: "Event coming up",
      message: "Brooklyn Book Festival — 2026-09-20",
      clickUrl: "continuum://item?origin=events&key=brooklyn+book+festival%7C2026-09-20",
      tags: ["calendar"],
    })
    assert.equal(ok, true)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, "https://ntfy.sh/abc123")
    assert.equal(calls[0].init.method, "POST")
    assert.equal(calls[0].init.headers.Title, "Event coming up")
    assert.equal(calls[0].init.headers.Tags, "calendar")
    assert.match(calls[0].init.headers.Click, /^continuum:\/\/item\?origin=events/)
    assert.equal(calls[0].init.body, "Brooklyn Book Festival — 2026-09-20")
  } finally {
    globalThis.fetch = realFetch
  }
})

test("sendNtfyPush strips CR/LF from header values (no header injection)", async () => {
  let seen
  const realFetch = globalThis.fetch
  globalThis.fetch = async (_url, init) => {
    seen = init.headers
    return { ok: true }
  }
  try {
    await sendNtfyPush({ topic: "t", title: "Line one\r\nBcc: evil@example.com", message: "x" })
    assert.doesNotMatch(seen.Title, /[\r\n]/)
    assert.equal(seen.Title, "Line one Bcc: evil@example.com")
  } finally {
    globalThis.fetch = realFetch
  }
})

test("sendNtfyPush never throws — a network failure resolves false, a missing topic too", async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => {
    throw new Error("ECONNRESET")
  }
  try {
    assert.equal(await sendNtfyPush({ topic: "t", title: "x", message: "y" }), false)
  } finally {
    globalThis.fetch = realFetch
  }
  assert.equal(await sendNtfyPush({ topic: null, title: "x", message: "y" }), false)
})

test("sendNtfyPush returns false on a non-2xx response", async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: false, status: 429 })
  try {
    assert.equal(await sendNtfyPush({ topic: "t", title: "x", message: "y" }), false)
  } finally {
    globalThis.fetch = realFetch
  }
})

// ---------------------------------------------------------------------------
// soleImminentItem
// ---------------------------------------------------------------------------

const ev = (title, date) => ({ title, date })

test("returns the item only when exactly one is within the window", () => {
  const today = "2026-09-14"
  assert.equal(
    soleImminentItem([ev("A", "2026-09-15")], { dateField: "date", today }).title,
    "A"
  )
  assert.equal(
    soleImminentItem([ev("A", "2026-09-15"), ev("B", "2026-09-16")], { dateField: "date", today }),
    null,
    "two imminent → null (the digest already covers both)"
  )
  assert.equal(
    soleImminentItem([], { dateField: "date", today }),
    null
  )
})

test("today and today+withinDays are both inside the window; the day after is not", () => {
  const today = "2026-09-14"
  assert.ok(soleImminentItem([ev("today", "2026-09-14")], { dateField: "date", today }))
  assert.ok(soleImminentItem([ev("edge", "2026-09-17")], { dateField: "date", today, withinDays: 3 }))
  assert.equal(
    soleImminentItem([ev("past-edge", "2026-09-18")], { dateField: "date", today, withinDays: 3 }),
    null
  )
})

test("a past date and a fuzzy date are never imminent", () => {
  const today = "2026-09-14"
  assert.equal(soleImminentItem([ev("gone", "2026-09-01")], { dateField: "date", today }), null)
  assert.equal(soleImminentItem([ev("fuzzy", "Fall 2026")], { dateField: "date", today }), null)
  assert.equal(soleImminentItem([ev("tbd", "TBD")], { dateField: "date", today }), null)
  // one real + one fuzzy → still exactly one imminent
  assert.equal(
    soleImminentItem([ev("real", "2026-09-15"), ev("fuzzy", "TBD")], { dateField: "date", today }).title,
    "real"
  )
})

test("works with a different date field (release_date) and datetime strings", () => {
  const today = "2026-09-14"
  const r = soleImminentItem(
    [{ title: "R", release_date: "2026-09-16T00:00:00Z" }],
    { dateField: "release_date", today }
  )
  assert.equal(r.title, "R")
})

// ---------------------------------------------------------------------------
// continuumItemLink
// ---------------------------------------------------------------------------

test("continuumItemLink builds a scheme URL with url-encoded origin and key", () => {
  const url = continuumItemLink({ origin: "events", key: "brooklyn book festival|2026-09-20" })
  assert.match(url, /^continuum:\/\/item\?/)
  const parsed = new URL(url)
  assert.equal(parsed.searchParams.get("origin"), "events")
  assert.equal(parsed.searchParams.get("key"), "brooklyn book festival|2026-09-20")
})
