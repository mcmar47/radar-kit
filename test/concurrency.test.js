// Regression tests for two bugs found in the 2026-09-27 code review:
//
//   1. Concurrent writes to one store. Every write shared one `<path>.tmp`
//      and mark updates were unserialized read-modify-writes, so 40
//      simultaneous mark writes left 1 key on disk and 39 requests failing
//      ENOENT — the Continuum app fires exactly that kind of burst.
//   2. The SMTP error for a failed AUTH step was labelled with the
//      command's first word, which for the password step IS the base64
//      password — so a revoked app password leaked into the tool error.

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import net from "node:net"
import path from "node:path"

import { writeFileAtomic } from "../src/atomicWrite.js"
import { createMarkStore } from "../src/markStore.js"
import { createReviewedRoute } from "../src/reviewedRoute.js"
import { smtpSubmit } from "../src/gmail.js"

async function tempDir() {
  return mkdtemp(path.join(tmpdir(), "radar-kit-concurrency-"))
}

test("concurrent writeFileAtomic calls to one path all succeed and leave valid content", async () => {
  const dir = await tempDir()
  const file = path.join(dir, "store.json")
  const payloads = Array.from({ length: 30 }, (_, i) =>
    JSON.stringify({ i, pad: "x".repeat((i * 37) % 500) })
  )

  const results = await Promise.allSettled(payloads.map((p) => writeFileAtomic(file, p)))
  assert.deepEqual(results.filter((r) => r.status === "rejected"), [])

  // Writes run in call order, so the last one wins — and it is whole.
  assert.equal(await readFile(file, "utf8"), payloads.at(-1))
  assert.deepEqual(await readdir(dir), ["store.json"])
})

test("concurrent mark sets on one store all land (no lost updates)", async () => {
  const dir = await tempDir()
  const marks = createMarkStore({ paths: { reviewed: path.join(dir, "reviewed.json") } })
  const keys = Array.from({ length: 40 }, (_, i) => String(1000 + i))

  const results = await Promise.allSettled(
    keys.map((key) => marks.set({ store: "reviewed", key, value: true, via: "app" }))
  )
  assert.deepEqual(results.filter((r) => r.status === "rejected"), [])

  const onDisk = JSON.parse(await readFile(path.join(dir, "reviewed.json"), "utf8"))
  assert.deepEqual(Object.keys(onDisk).sort(), keys)
})

test("concurrent sets on an exclusive pair keep the stores disjoint", async () => {
  const dir = await tempDir()
  const marks = createMarkStore({
    paths: {
      interested: path.join(dir, "interested.json"),
      ignored: path.join(dir, "ignored.json"),
    },
    exclusive: true,
  })

  // Star then reject the same item in one burst, plus unrelated keys.
  await Promise.all([
    marks.set({ store: "interested", key: "1", value: true }),
    marks.set({ store: "ignored", key: "1", value: true }),
    marks.set({ store: "interested", key: "2", value: true }),
    marks.set({ store: "ignored", key: "3", value: true }),
  ])

  const interested = await marks.read("interested")
  const ignored = await marks.read("ignored")
  assert.deepEqual(Object.keys(interested).sort(), ["2"])
  assert.deepEqual(Object.keys(ignored).sort(), ["1", "3"])
})

test("setMany writes a batch in one pass and keeps first-seen timestamps", async () => {
  const dir = await tempDir()
  const marks = createMarkStore({ paths: { reviewed: path.join(dir, "reviewed.json") } })

  await marks.set({ store: "reviewed", key: "a", value: true, via: "web" })
  const first = (await marks.read("reviewed")).a

  const { touched } = await marks.setMany({
    store: "reviewed",
    keys: ["a", "b", "c"],
    value: true,
    via: "app",
  })
  assert.deepEqual(touched, ["reviewed"])

  const after = await marks.read("reviewed")
  assert.deepEqual(Object.keys(after).sort(), ["a", "b", "c"])
  assert.deepEqual(after.a, first)
  assert.equal(after.b.via, "app")

  await marks.setMany({ store: "reviewed", keys: ["a", "c"], value: false })
  assert.deepEqual(Object.keys(await marks.read("reviewed")), ["b"])
})

test("an unknown store still rejects rather than throwing synchronously", async () => {
  const dir = await tempDir()
  const marks = createMarkStore({ paths: { reviewed: path.join(dir, "reviewed.json") } })
  await assert.rejects(() => marks.set({ store: "toString", key: "a", value: true }))
  await assert.rejects(() => marks.setMany({ store: "nope", keys: ["a"], value: true }))
})

test("overlapping reviewed batches from the app all land", async () => {
  const dir = await tempDir()
  const reviewed = createMarkStore({ paths: { reviewed: path.join(dir, "reviewed.json") } })
  const route = createReviewedRoute({ reviewed, fields: ["id"], keyOf: ({ id }) => String(id) })

  const fakeRes = () => {
    const res = { status: null }
    res.writeHead = (status) => {
      res.status = status
      return res
    }
    res.end = () => res
    return res
  }

  const responses = []
  await Promise.all(
    Array.from({ length: 10 }, (_, batch) => {
      const res = fakeRes()
      responses.push(res)
      return route.handler({
        res,
        body: {
          items: Array.from({ length: 5 }, (_, i) => ({ id: batch * 5 + i })),
          reviewed: true,
          via: "app",
        },
      })
    })
  )

  assert.ok(responses.every((r) => r.status === 200))
  assert.equal(Object.keys(await reviewed.read("reviewed")).length, 50)
})

// A fake SMTP server: replies to each line with the next scripted reply.
async function fakeSmtp(replies, { silentAfter = Infinity } = {}) {
  const received = []
  const server = net.createServer((sock) => {
    let i = 0
    const send = () => {
      if (i < replies.length && i < silentAfter) sock.write(replies[i++] + "\r\n")
    }
    send() // greeting
    let buf = ""
    sock.on("data", (d) => {
      buf += d.toString("utf8")
      let nl
      while ((nl = buf.indexOf("\r\n")) !== -1) {
        received.push(buf.slice(0, nl))
        buf = buf.slice(nl + 2)
        send()
      }
    })
    sock.on("error", () => {})
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address()
  return {
    received,
    connect: () => net.connect({ host: "127.0.0.1", port }),
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

test("a rejected app password does not appear, encoded or not, in the SMTP error", async () => {
  const pass = "abcd efgh ijkl mnop"
  const b64 = Buffer.from(pass, "utf8").toString("base64")
  const smtp = await fakeSmtp([
    "220 fake ready",
    "250 hello",
    "334 VXNlcm5hbWU6",
    "334 UGFzc3dvcmQ6",
    "535 5.7.8 Username and Password not accepted",
  ])
  try {
    await assert.rejects(
      smtpSubmit({
        user: "someone@example.com",
        pass,
        envelopeFrom: "someone@example.com",
        to: "someone@example.com",
        raw: "Subject: x\r\n\r\nbody",
        connect: smtp.connect,
      }),
      (err) => {
        assert.match(err.message, /^SMTP AUTH password failed: 535/)
        assert.ok(!err.message.includes(b64), "error leaked the base64 password")
        assert.ok(!err.message.includes(pass), "error leaked the password")
        return true
      }
    )
    // Sanity: the password really was sent as that base64 line.
    assert.ok(smtp.received.includes(b64))
  } finally {
    await smtp.close()
  }
})

test("a stalled SMTP server times out instead of hanging the run", async () => {
  const smtp = await fakeSmtp(["220 fake ready"], { silentAfter: 1 })
  try {
    await assert.rejects(
      smtpSubmit({
        user: "u",
        pass: "p",
        envelopeFrom: "u@example.com",
        to: "u@example.com",
        raw: "x",
        connect: smtp.connect,
        idleTimeoutMs: 200,
      }),
      /SMTP timed out/
    )
  } finally {
    await smtp.close()
  }
})
