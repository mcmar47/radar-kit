// createReviewedRoute — the app's "seen in the Inbox" store.
//
// Not a calibration signal (the agents never read reviewed.json); its whole
// job is to survive a phone reinstall and match across devices, which the
// local-only version did not. These tests pin the three body shapes and the
// key-must-match-the-mark-routes contract.

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { createMarkStore } from "../src/markStore.js"
import { createInterestServer } from "../src/interestServer.js"
import { createReviewedRoute } from "../src/reviewedRoute.js"
import { makeKeyFn } from "../src/seenStore.js"

async function tempDir() {
  return mkdtemp(path.join(tmpdir(), "radar-kit-reviewed-"))
}

async function withServer(routes, run) {
  const { server, listen } = createInterestServer({ name: "test", port: 0, routes })
  await new Promise((resolve) => listen(resolve))
  const { port } = server.address()
  try {
    await run((p, init) =>
      fetch(`http://127.0.0.1:${port}${p}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        ...init,
      })
    )
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

function reviewedStoreIn(dir) {
  return createMarkStore({
    paths: { reviewed: path.join(dir, "reviewed.json") },
  })
}

const keyOf = makeKeyFn(["watch", "type", "title"])
const ITEM = { watch: "Dune", type: "film", title: "Dune: Part Three" }

test("a single item is written under the same key the mark routes use", async () => {
  const dir = await tempDir()
  const reviewed = reviewedStoreIn(dir)
  const route = createReviewedRoute({ reviewed, fields: ["watch", "type", "title"], keyOf })

  await withServer([route], async (req) => {
    const res = await req("/api/reviewed", { body: JSON.stringify({ ...ITEM, reviewed: true }) })
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { ok: true, reviewed: true, count: 1 })
  })

  const store = await reviewed.read("reviewed")
  assert.deepEqual(Object.keys({ ...store }), [keyOf(ITEM)])
})

test("reviewed: false deletes the key", async () => {
  const dir = await tempDir()
  const reviewed = reviewedStoreIn(dir)
  await reviewed.set({ store: "reviewed", key: keyOf(ITEM), value: true })
  const route = createReviewedRoute({ reviewed, fields: ["watch", "type", "title"], keyOf })

  await withServer([route], async (req) => {
    const res = await req("/api/reviewed", { body: JSON.stringify({ ...ITEM, reviewed: false }) })
    assert.equal(res.status, 200)
  })

  assert.deepEqual({ ...(await reviewed.read("reviewed")) }, {})
})

test("a batch writes every item and reports the count", async () => {
  const dir = await tempDir()
  const reviewed = reviewedStoreIn(dir)
  const route = createReviewedRoute({ reviewed, fields: ["watch", "type", "title"], keyOf })
  const items = [
    ITEM,
    { watch: "Foundation", type: "tv", title: "Foundation S3" },
    { watch: "Half-Life", type: "game", title: "Half-Life 3" },
  ]

  await withServer([route], async (req) => {
    const res = await req("/api/reviewed", { body: JSON.stringify({ items, reviewed: true }) })
    assert.equal(res.status, 200)
    assert.equal((await res.json()).count, 3)
  })

  assert.equal(Object.keys({ ...(await reviewed.read("reviewed")) }).length, 3)
})

test("clear: true wipes the whole store", async () => {
  const dir = await tempDir()
  const reviewed = reviewedStoreIn(dir)
  await reviewed.set({ store: "reviewed", key: "a", value: true })
  await reviewed.set({ store: "reviewed", key: "b", value: true })
  const route = createReviewedRoute({ reviewed, fields: ["watch", "type", "title"], keyOf })

  await withServer([route], async (req) => {
    const res = await req("/api/reviewed", { body: JSON.stringify({ clear: true }) })
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { ok: true, cleared: ["reviewed"] })
  })

  assert.deepEqual({ ...(await reviewed.read("reviewed")) }, {})
})

test("a missing key field is a 400 and nothing is written", async () => {
  const dir = await tempDir()
  const reviewed = reviewedStoreIn(dir)
  const route = createReviewedRoute({ reviewed, fields: ["watch", "type", "title"], keyOf })

  await withServer([route], async (req) => {
    const res = await req("/api/reviewed", {
      body: JSON.stringify({ watch: "Dune", title: "Dune: Part Three", reviewed: true }),
    })
    assert.equal(res.status, 400)
  })

  assert.deepEqual({ ...(await reviewed.read("reviewed")) }, {})
})

test("one bad item rejects the whole batch, so a partial write can't happen", async () => {
  const dir = await tempDir()
  const reviewed = reviewedStoreIn(dir)
  const route = createReviewedRoute({ reviewed, fields: ["watch", "type", "title"], keyOf })

  await withServer([route], async (req) => {
    const res = await req("/api/reviewed", {
      body: JSON.stringify({
        items: [ITEM, { watch: "Foundation", type: "tv" }],
        reviewed: true,
      }),
    })
    assert.equal(res.status, 400)
  })

  assert.deepEqual({ ...(await reviewed.read("reviewed")) }, {})
})

test("a non-boolean reviewed is a 400", async () => {
  const dir = await tempDir()
  const reviewed = reviewedStoreIn(dir)
  const route = createReviewedRoute({ reviewed, fields: ["watch", "type", "title"], keyOf })

  await withServer([route], async (req) => {
    const res = await req("/api/reviewed", { body: JSON.stringify({ ...ITEM }) })
    assert.equal(res.status, 400)
  })
})

test("feed-radar's numeric-id keyOf works the same way", async () => {
  const dir = await tempDir()
  const reviewed = reviewedStoreIn(dir)
  const normalizeId = (id) => (/^[0-9]+$/.test(String(id)) ? String(id) : null)
  const route = createReviewedRoute({
    reviewed,
    fields: ["id"],
    keyOf: ({ id }) => normalizeId(id),
  })

  await withServer([route], async (req) => {
    assert.equal(
      (await req("/api/reviewed", { body: JSON.stringify({ id: 4210, reviewed: true }) })).status,
      200
    )
    assert.equal(
      (await req("/api/reviewed", { body: JSON.stringify({ id: "not-a-number", reviewed: true }) }))
        .status,
      400
    )
  })

  assert.deepEqual(Object.keys({ ...(await reviewed.read("reviewed")) }), ["4210"])
})

test("the store instance must be its own — set() and clear() are required", async () => {
  assert.throws(
    () => createReviewedRoute({ reviewed: {}, fields: ["id"], keyOf: () => "x" }),
    /needs a markStore/
  )
})

test("a reviewed store left corrupt on disk recovers instead of 500ing", async () => {
  const dir = await tempDir()
  await writeFile(path.join(dir, "reviewed.json"), "{ truncated", "utf8")
  const reviewed = reviewedStoreIn(dir)
  const route = createReviewedRoute({ reviewed, fields: ["watch", "type", "title"], keyOf })

  await withServer([route], async (req) => {
    const res = await req("/api/reviewed", { body: JSON.stringify({ ...ITEM, reviewed: true }) })
    assert.equal(res.status, 200)
  })
})
