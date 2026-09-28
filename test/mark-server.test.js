import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createMarkServer } from "../src/markServer.js"

async function withMarkServer(opts, run) {
  const repoDir = await mkdtemp(path.join(tmpdir(), "mark-server-"))
  const s = createMarkServer({ name: "test", port: 0, repoDir, ...opts })
  await new Promise((resolve) => s.listen(resolve))
  const base = `http://127.0.0.1:${s.server.address().port}`
  const post = (p, body) =>
    fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  const readStore = async (n) => JSON.parse(await readFile(path.join(repoDir, `${n}.json`), "utf8").catch(() => "{}"))
  try {
    await run({ base, post, readStore })
  } finally {
    await new Promise((resolve) => s.server.close(resolve))
  }
}

test("toggle API: the exact request/response shape event-watch/release-radar/job-radar clients use", async () => {
  await withMarkServer({ keyFields: ["title", "date"] }, async ({ post, readStore }) => {
    const res = await post("/api/interested", { title: " Book Fair ", date: "2026-10-01", interested: true })
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { ok: true, interested: true })
    assert.ok(Object.keys(await readStore("interested")).includes("book fair|2026-10-01"), "normalized key")

    // exclusive: rejecting clears the star
    await post("/api/ignored", { title: "Book Fair", date: "2026-10-01", ignored: true })
    assert.deepEqual(Object.keys(await readStore("interested")).filter(Boolean).length, 0)

    const bad = await post("/api/interested", { title: "x", interested: true })
    assert.equal(bad.status, 400)
    assert.match((await bad.json()).error, /expected \{title, date, interested: boolean\}/)
  })
})

test("mark API: feed-radar's POST /api/mark shape, with a custom key that rejects bad ids", async () => {
  const normalizeId = ({ id }) => (/^[0-9]+$/.test(String(id)) ? String(id) : null)
  await withMarkServer({ keyFields: [{ field: "id", exact: true }], keyOf: normalizeId, api: "mark" }, async ({ post }) => {
    const res = await post("/api/mark", { id: 42, mark: "interested", value: true, via: "app" })
    assert.deepEqual(await res.json(), { ok: true, id: "42", mark: "interested", value: true })
    assert.equal((await post("/api/mark", { id: "abc", mark: "interested", value: true })).status, 400)
    assert.equal((await post("/api/mark", { id: 7, mark: "bogus", value: true })).status, 400)
    assert.equal((await post("/api/interested", { id: 7, interested: true })).status, 404, "no toggle routes in mark mode")
  })
})

test("one-click GET, reviewed, and health routes are always mounted", async () => {
  await withMarkServer({ keyFields: ["company", "title", "link"] }, async ({ base, post, readStore }) => {
    const click = await fetch(`${base}/api/mark?company=Acme&title=Dev&link=https%3A%2F%2Fx&mark=interested`)
    assert.equal(click.status, 200)
    assert.ok(Object.keys(await readStore("interested")).includes("acme|dev|https://x"))
    const rev = await post("/api/reviewed", { company: "Acme", title: "Dev", link: "https://x", reviewed: true })
    assert.equal(rev.status, 200)
    assert.equal((await fetch(`${base}/api/health`)).status, 200)
    assert.equal((await post("/api/run", {})).status, 404, "no run route without runUnit")
  })
})

test("onMarked fires for POST toggles and the one-click GET, with the item and store", async () => {
  const events = []
  await withMarkServer(
    { keyFields: ["watch", "type", "title"], onMarked: (e) => events.push(e) },
    async ({ base, post }) => {
      await post("/api/interested", { watch: "A", type: "book", title: "T", interested: true })
      await fetch(`${base}/api/mark?watch=A&type=book&title=U&mark=ignored`)
      await new Promise((r) => setTimeout(r, 20))
    }
  )
  assert.deepEqual(
    events.map((e) => [e.store, e.value, e.item.title]),
    [["interested", true, "T"], ["ignored", true, "U"]]
  )
})

test("createMarkServer validates its declaration", () => {
  assert.throws(() => createMarkServer({ name: "x", repoDir: "/tmp" }))
  assert.throws(() => createMarkServer({ name: "x", repoDir: "/tmp", keyFields: ["a"], api: "other" }))
})
