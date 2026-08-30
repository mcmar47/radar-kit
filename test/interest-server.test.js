// Covers the mark store and the HTTP shell extracted from event-watch's,
// release-radar's and feed-radar's server/interest-server.js.
//
// Every test in the first two groups corresponds to a failure that actually
// happened on the Pi and was fixed by hand in each repo separately (see the
// 2026-08-28 commits in all three). They are written to fail against the
// pre-fix behaviour, which is the only way to know the fix is really here.

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile, readdir, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { readMarks, writeMarks, createMarkStore } from "../src/markStore.js"
import { createInterestServer, sendJson } from "../src/interestServer.js"
import { createOneClickMarkRoute, markUrls } from "../src/oneClickMark.js"
import { buildCalibrationBlock } from "../src/calibration.js"
import { makeKeyFn } from "../src/seenStore.js"

async function tempDir() {
  return mkdtemp(path.join(tmpdir(), "radar-kit-test-"))
}

// ---------------------------------------------------------------------------
// readMarks — surviving a store that should not be there
// ---------------------------------------------------------------------------

test("a missing store reads as empty, not an error", async () => {
  const dir = await tempDir()
  assert.deepEqual({ ...(await readMarks(path.join(dir, "nope.json"))) }, {})
})

test("a half-written store is quarantined instead of crash-looping", async () => {
  // The exact shape a power cut left behind: valid bytes, truncated.
  const dir = await tempDir()
  const store = path.join(dir, "interested.json")
  await writeFile(store, '{\n  "a book|2026-01-01": tr', "utf8")

  const marks = await readMarks(store)
  assert.deepEqual({ ...marks }, {}, "carries on from empty")

  const left = await readdir(dir)
  assert.equal(left.length, 1, "the bad file is still on disk, under a new name")
  assert.match(left[0], /^interested\.json\.corrupt-\d+$/)

  // The bug was that the *next* read hit the same bytes and died again.
  assert.deepEqual({ ...(await readMarks(store)) }, {}, "second read is clean")
})

test("a store that parses but is the wrong shape is also quarantined", async () => {
  // Not covered by any of the three originals: these all parse fine, then
  // silently swallowed every write.
  for (const bad of ['"just a string"', "null", "[1,2,3]", "42"]) {
    const dir = await tempDir()
    const store = path.join(dir, "interested.json")
    await writeFile(store, bad, "utf8")

    assert.deepEqual({ ...(await readMarks(store)) }, {}, `${bad} reads as empty`)
    const left = await readdir(dir)
    assert.match(left[0], /\.corrupt-\d+$/, `${bad} is quarantined`)
  }
})

test("a __proto__ key in the file cannot become an inherited member", async () => {
  const dir = await tempDir()
  const store = path.join(dir, "interested.json")
  await writeFile(store, '{"__proto__": {"polluted": true}}', "utf8")

  const marks = await readMarks(store)
  assert.equal(Object.getPrototypeOf(marks), null, "null-prototype result")
  assert.equal({}.polluted, undefined, "Object.prototype is untouched")
  assert.equal(marks.constructor, undefined, "no inherited member reads as a mark")
})

// ---------------------------------------------------------------------------
// writeMarks — atomicity
// ---------------------------------------------------------------------------

test("a written store round-trips and leaves no temp file behind", async () => {
  const dir = await tempDir()
  const store = path.join(dir, "interested.json")

  await writeMarks(store, { "a book|2026-01-01": true })
  assert.deepEqual({ ...(await readMarks(store)) }, { "a book|2026-01-01": true })

  assert.deepEqual(await readdir(dir), ["interested.json"], "the .tmp is gone")
  assert.match(await readFile(store, "utf8"), /\n$/, "trailing newline preserved")
})

test("sequential writes do not interleave", async () => {
  const dir = await tempDir()
  const store = path.join(dir, "interested.json")

  // Each write is read-modify-write through the store, which is how the
  // server does it; the file must never be observed truncated in between.
  const marks = createMarkStore({ paths: { interested: store } })
  for (let i = 0; i < 25; i++) {
    await marks.set({ store: "interested", key: `k${i}`, value: true })
    JSON.parse(await readFile(store, "utf8")) // throws if ever truncated
  }
  assert.equal(Object.keys(await marks.read("interested")).length, 25)
})

test("a written store is 0644 even under a restrictive umask", async () => {
  // These stores are served straight off disk by nginx as static JSON, so
  // they must stay world-readable no matter what umask the writing process
  // has. This is the failure that actually put three stores on the Pi at
  // 0600 and made nginx 403 them: something called writeMarks under a 0077
  // umask. open()'s mode is masked by the umask, so only an explicit
  // fchmod on the handle can make this deterministic.
  const dir = await tempDir()
  const store = path.join(dir, "interested.json")

  const originalUmask = process.umask(0o077)
  try {
    await writeMarks(store, { "a book|2026-01-01": true })
  } finally {
    process.umask(originalUmask)
  }

  const { mode } = await stat(store)
  assert.equal(mode & 0o777, 0o644)
})

// ---------------------------------------------------------------------------
// createMarkStore — the lookup guard and exclusivity
// ---------------------------------------------------------------------------

test("prototype member names are not valid store names", async () => {
  // The bug: `paths[name]` resolved these, handing readFile a function
  // instead of a path, which killed the process outright.
  const dir = await tempDir()
  const marks = createMarkStore({
    paths: {
      interested: path.join(dir, "interested.json"),
      ignored: path.join(dir, "ignored.json"),
    },
  })

  for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    assert.equal(marks.isValidStore(name), false, `${name} is rejected`)
    await assert.rejects(
      () => marks.set({ store: name, key: "k", value: true }),
      /unknown store/,
      `${name} throws rather than reaching the filesystem`
    )
  }

  assert.equal(marks.isValidStore("interested"), true)
  assert.equal(marks.isValidStore(undefined), false)
})

test("exclusive stores clear the opposite mark", async () => {
  const dir = await tempDir()
  const marks = createMarkStore({
    paths: {
      interested: path.join(dir, "interested.json"),
      ignored: path.join(dir, "ignored.json"),
    },
    exclusive: true,
  })

  await marks.set({ store: "interested", key: "42", value: true })
  const { touched } = await marks.set({ store: "ignored", key: "42", value: true })

  assert.deepEqual(touched, ["ignored", "interested"], "both stores were written")
  assert.deepEqual({ ...(await marks.read("interested")) }, {}, "star was cleared")
  assert.deepEqual({ ...(await marks.read("ignored")) }, { 42: true })
})

test("clearing a mark never sweeps the other store", async () => {
  const dir = await tempDir()
  const marks = createMarkStore({
    paths: {
      interested: path.join(dir, "interested.json"),
      ignored: path.join(dir, "ignored.json"),
    },
    exclusive: true,
  })

  await marks.set({ store: "ignored", key: "42", value: true })
  const { touched } = await marks.set({ store: "interested", key: "42", value: false })

  assert.deepEqual(touched, ["interested"], "only the store being cleared")
  assert.deepEqual({ ...(await marks.read("ignored")) }, { 42: true }, "left alone")
})

test("without exclusive, both marks can coexist", async () => {
  const dir = await tempDir()
  const marks = createMarkStore({
    paths: {
      interested: path.join(dir, "interested.json"),
      ignored: path.join(dir, "ignored.json"),
    },
  })

  await marks.set({ store: "interested", key: "42", value: true })
  await marks.set({ store: "ignored", key: "42", value: true })

  assert.deepEqual({ ...(await marks.read("interested")) }, { 42: true })
  assert.deepEqual({ ...(await marks.read("ignored")) }, { 42: true })
})

// ---------------------------------------------------------------------------
// createInterestServer — the request shell
// ---------------------------------------------------------------------------

// Start a server on an ephemeral port and return a fetch bound to it.
async function withServer(routes, run) {
  const { server, listen } = createInterestServer({ name: "test", port: 0, routes })
  await new Promise((resolve) => listen(resolve))
  const { port } = server.address()
  try {
    await run((p, init) => fetch(`http://127.0.0.1:${port}${p}`, init))
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

const okRoute = {
  method: "POST",
  path: "/api/mark",
  body: true,
  handler: async ({ res, body }) => sendJson(res, 200, { ok: true, got: body }),
}

test("an unknown route 404s and does not take the process down", async () => {
  await withServer([okRoute], async (req) => {
    // feed-radar's bug: a bare GET where only POST was handled.
    assert.equal((await req("/api/mark")).status, 404)
    assert.equal((await req("/nope", { method: "POST" })).status, 404)
    // Still answering afterwards is the whole point.
    const res = await req("/api/mark", { method: "POST", body: "{}" })
    assert.equal(res.status, 200)
  })
})

test("a malformed body is a 400, and the next request still works", async () => {
  await withServer([okRoute], async (req) => {
    const bad = await req("/api/mark", { method: "POST", body: "{not json" })
    assert.equal(bad.status, 400)
    assert.deepEqual(await bad.json(), { error: "invalid JSON body" })

    const good = await req("/api/mark", { method: "POST", body: '{"id":"1"}' })
    assert.equal(good.status, 200)
    assert.deepEqual((await good.json()).got, { id: "1" })
  })
})

test("an empty body parses as an empty object", async () => {
  await withServer([okRoute], async (req) => {
    const res = await req("/api/mark", { method: "POST" })
    assert.equal(res.status, 200)
    assert.deepEqual((await res.json()).got, {})
  })
})

test("an oversized body is refused rather than buffered", async () => {
  await withServer([okRoute], async (req) => {
    const res = await req("/api/mark", {
      method: "POST",
      body: JSON.stringify({ id: "x".repeat(100_000) }),
    })
    assert.equal(res.status, 413)
  })
})

test("a handler that throws becomes a 500, and the server keeps serving", async () => {
  // The original failure mode: an async handler throwing became an
  // unhandled rejection, which Node turns into an immediate process exit.
  const routes = [
    {
      method: "POST",
      path: "/api/boom",
      body: true,
      handler: async () => {
        throw new Error("store unreadable")
      },
    },
    okRoute,
  ]

  await withServer(routes, async (req) => {
    const res = await req("/api/boom", { method: "POST", body: "{}" })
    assert.equal(res.status, 500)
    assert.deepEqual(await res.json(), { error: "internal error" })

    const after = await req("/api/mark", { method: "POST", body: "{}" })
    assert.equal(after.status, 200, "process survived the throw")
  })
})

test("a query string does not stop a route matching", async () => {
  const routes = [
    {
      method: "GET",
      path: "/api/mark",
      handler: async ({ res, url }) =>
        sendJson(res, 200, { id: url.searchParams.get("id") }),
    },
  ]
  await withServer(routes, async (req) => {
    const res = await req("/api/mark?id=42&mark=interested")
    assert.deepEqual(await res.json(), { id: "42" })
  })
})

test("a server with no routes is a configuration error, caught at startup", () => {
  assert.throws(() => createInterestServer({ port: 0, routes: [] }), /at least one route/)
})

// ---------------------------------------------------------------------------
// buildCalibrationBlock — joining marks back to the records they key into
// ---------------------------------------------------------------------------

const EVENTS = [
  { title: "A Reading", date: "2026-09-01", category: "literary", description: "A launch." },
  { title: "Ghost Walk", date: "2026-10-31", category: "paranormal", description: "A walk." },
  { title: "Pen Show", date: "2026-11-05", category: "stationery", description: "Pens." },
]
const evKey = makeKeyFn(["title", "date"])
const evDesc = (e) => `[${e.category}] ${e.title} — ${e.description}`

test("the block joins mark keys to their full records", () => {
  const block = buildCalibrationBlock({
    interested: { [evKey(EVENTS[0])]: true },
    ignored: { [evKey(EVENTS[1])]: true },
    records: EVENTS,
    keyFn: evKey,
    describe: evDesc,
  })

  assert.match(block, /### Starred — 1 item\b/)
  assert.match(block, /\[literary\] A Reading — A launch\./, "positive rendered from its record")
  assert.match(block, /### Rejected — 1 item\b/)
  assert.match(block, /\[paranormal\] Ghost Walk/, "negative rendered from its record")
  assert.doesNotMatch(block, /Pen Show/, "an unmarked record is not included")
})

test("a mark whose record has aged out is dropped, not rendered as a bare key", () => {
  const block = buildCalibrationBlock({
    interested: { "an event that no longer exists|2020-01-01": true },
    records: EVENTS,
    keyFn: evKey,
    describe: evDesc,
  })
  assert.doesNotMatch(block, /no longer exists/)
  assert.match(block, /Nothing has been starred or rejected yet/, "falls back to the empty state")
})

test("empty stores produce an explicit empty block, not silence", () => {
  const block = buildCalibrationBlock({ records: EVENTS, keyFn: evKey, describe: evDesc })
  assert.match(block, /## Calibration/)
  assert.match(block, /Do not infer preferences from this/)
})

test("unmarked items are explicitly called out as carrying no signal", () => {
  const block = buildCalibrationBlock({
    interested: { [evKey(EVENTS[0])]: true },
    records: EVENTS,
    keyFn: evKey,
    describe: evDesc,
  })
  assert.match(block, /not a negative signal/)
})

test("the join uses normalized keys, so casing drift still matches", () => {
  // The server normalizes when it writes the mark; the records may have
  // been re-scraped with different casing since.
  const block = buildCalibrationBlock({
    interested: { "a reading|2026-09-01": true },
    records: [{ title: "  A  READING ", date: "2026-09-01", category: "literary", description: "x" }],
    keyFn: evKey,
    describe: evDesc,
  })
  assert.match(block, /A  READING/, "matched despite casing and spacing drift")
})

test("a mismatched keyFn finds nothing — the one way to wire this up wrong", () => {
  // Wiring release-radar's key against event-watch's records, say.
  const block = buildCalibrationBlock({
    interested: { [evKey(EVENTS[0])]: true },
    records: EVENTS,
    keyFn: makeKeyFn(["watch", "type", "title"]),
    describe: evDesc,
  })
  assert.match(block, /Nothing has been starred or rejected yet/)
})

test("limit keeps the most recent marks", () => {
  const many = Array.from({ length: 60 }, (_, i) => ({
    title: `Event ${i}`, date: "2026-09-01", category: "c", description: "d",
  }))
  const interested = Object.fromEntries(many.map((e) => [evKey(e), true]))
  const block = buildCalibrationBlock({
    interested, records: many, keyFn: evKey, describe: evDesc, limit: 10,
  })
  assert.match(block, /### Starred — 10 items/)
  assert.match(block, /Event 59/, "keeps the newest")
  assert.doesNotMatch(block, /Event 49\b/, "drops the oldest")
})

test("buildCalibrationBlock refuses to run without its two required functions", () => {
  assert.throws(() => buildCalibrationBlock({ describe: evDesc }), /keyFn is required/)
  assert.throws(() => buildCalibrationBlock({ keyFn: evKey }), /describe is required/)
})

// ---------------------------------------------------------------------------
// createOneClickMarkRoute — the email's star / reject links
// ---------------------------------------------------------------------------
//
// The failure this guards against is silent and total: if the GET route's
// key does not match the key read_calibration joins with, every click writes
// a mark that nothing ever finds, and the agent reports an empty calibration
// block forever while the store fills up. So the round-trip test below goes
// all the way through buildCalibrationBlock rather than stopping at the file.

async function markStoreIn(dir, exclusive = true) {
  return createMarkStore({
    paths: {
      interested: path.join(dir, "interested.json"),
      ignored: path.join(dir, "ignored.json"),
    },
    exclusive,
  })
}

test("a one-click link writes a mark read_calibration can join back", async () => {
  const dir = await tempDir()
  const marks = await markStoreIn(dir)
  const keyOf = makeKeyFn(["title", "date"])
  const route = createOneClickMarkRoute({
    marks, fields: ["title", "date"], keyOf,
  })

  await withServer([route], async (req) => {
    const { interested } = markUrls({
      baseUrl: "",
      params: { title: EVENTS[0].title, date: EVENTS[0].date },
    })
    const res = await req(interested)
    assert.equal(res.status, 200)
    assert.match(await res.text(), /Marked <b>interested<\/b>/)
  })

  // The join is the actual assertion: same key function, real record found.
  const block = buildCalibrationBlock({
    interested: await marks.read("interested"),
    records: EVENTS,
    keyFn: keyOf,
    describe: evDesc,
  })
  assert.match(block, /### Starred — 1 item/)
  assert.match(block, new RegExp(EVENTS[0].title))
})

test("a title with characters that need encoding survives the round trip", async () => {
  const dir = await tempDir()
  const marks = await markStoreIn(dir)
  const keyOf = makeKeyFn(["title", "date"])
  const record = { title: "Poe & Sons: A Night's \"Reading\"", date: "2026-10-31" }
  const route = createOneClickMarkRoute({ marks, fields: ["title", "date"], keyOf })

  await withServer([route], async (req) => {
    const { ignored } = markUrls({ baseUrl: "", params: record })
    assert.equal((await req(ignored)).status, 200)
  })

  assert.deepEqual(
    Object.keys(await marks.read("ignored")),
    [keyOf(record)],
    "ampersand/quote/apostrophe all made it through URLSearchParams intact"
  )
})

test("the reject link clears an existing star, and vice versa", async () => {
  const dir = await tempDir()
  const marks = await markStoreIn(dir)
  const keyOf = makeKeyFn(["title", "date"])
  const route = createOneClickMarkRoute({ marks, fields: ["title", "date"], keyOf })
  const params = { title: EVENTS[0].title, date: EVENTS[0].date }

  await withServer([route], async (req) => {
    const links = markUrls({ baseUrl: "", params })
    await req(links.interested)
    await req(links.ignored)
    assert.deepEqual({ ...(await marks.read("interested")) }, {}, "star cleared")
    assert.deepEqual(Object.keys(await marks.read("ignored")), [keyOf(params)])

    await req(links.interested)
    assert.deepEqual({ ...(await marks.read("ignored")) }, {}, "reject cleared")
  })
})

test("a missing or empty key field is a 400, not a mark under a half key", async () => {
  const dir = await tempDir()
  const marks = await markStoreIn(dir)
  const route = createOneClickMarkRoute({
    marks, fields: ["title", "date"], keyOf: makeKeyFn(["title", "date"]),
  })

  await withServer([route], async (req) => {
    for (const q of [
      "/api/mark?title=A&mark=interested",           // no date
      "/api/mark?date=2026-09-01&mark=interested",   // no title
      "/api/mark?title=A&date=&mark=interested",     // empty date
      "/api/mark?title=A&date=2026-09-01",           // no mark
    ]) {
      assert.equal((await req(q)).status, 400, q)
    }
  })

  assert.deepEqual({ ...(await marks.read("interested")) }, {}, "nothing was written")
})

test("an unknown store name cannot reach the mark store", async () => {
  const dir = await tempDir()
  const marks = await markStoreIn(dir)
  const route = createOneClickMarkRoute({
    marks, fields: ["title", "date"], keyOf: makeKeyFn(["title", "date"]),
  })

  await withServer([route], async (req) => {
    // The prototype-member names markStore's own guard exists for, plus a
    // plainly wrong one. All must 400 before marks.set is ever called.
    for (const bad of ["constructor", "__proto__", "toString", "starred"]) {
      const res = await req(`/api/mark?title=A&date=B&mark=${encodeURIComponent(bad)}`)
      assert.equal(res.status, 400, bad)
    }
  })
})

test("keyOf returning null rejects the request (feed-radar's numeric id guard)", async () => {
  const dir = await tempDir()
  const marks = await markStoreIn(dir)
  const route = createOneClickMarkRoute({
    marks,
    fields: ["id"],
    keyOf: ({ id }) => (/^[0-9]+$/.test(id) ? id : null),
  })

  await withServer([route], async (req) => {
    assert.equal((await req("/api/mark?id=1405&mark=interested")).status, 200)
    assert.equal((await req("/api/mark?id=../etc&mark=interested")).status, 400)
    assert.equal((await req("/api/mark?id=__proto__&mark=interested")).status, 400)
  })

  assert.deepEqual(Object.keys(await marks.read("interested")), ["1405"])
})

test("the route refuses to be built without the pieces that make keys match", () => {
  assert.throws(
    () => createOneClickMarkRoute({ fields: ["id"], keyOf: String }),
    /needs a markStore/
  )
  assert.throws(
    () => createOneClickMarkRoute({ marks: { set() {}, names: [] }, keyOf: String }),
    /at least one key field/
  )
  assert.throws(
    () => createOneClickMarkRoute({ marks: { set() {}, names: [] }, fields: ["id"] }),
    /keyOf is required/
  )
})
