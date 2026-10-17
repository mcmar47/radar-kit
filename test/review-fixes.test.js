// Regression tests for the 2026-10 code-review fixes: the 30h Research Desk
// window, serendipity link scheme filtering, ENOENT-only silent section
// readers, ASCII ntfy headers, local-date helper, and the send-once guard.
import { test } from "node:test"
import assert from "node:assert/strict"
import net from "node:net"
import { mkdtemp, writeFile, readFile, rm, access } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { readPendingResearchAnswer } from "../src/researchDesk.js"
import { readPendingSerendipityDiscoveries } from "../src/serendipity.js"
import { readPendingPrizeDigest } from "../src/prizeRadar.js"
import { sendNtfyPush, asciiTitle } from "../src/ntfy.js"
import { localDateString } from "../src/localDate.js"
import { soleImminentItem } from "../src/highlight.js"
import { smtpSubmit } from "../src/gmail.js"
import {
  sendKey,
  assertNotAlreadySending,
  markSending,
  clearSending,
  sendingMarkerPath,
} from "../src/sendGuard.js"

const tmp = () => mkdtemp(path.join(tmpdir(), "rk-fix-"))
const exists = (p) => access(p).then(() => true, () => false)

// Silence console.error from the readers while asserting on it.
async function capturingErrors(fn) {
  const real = console.error
  const logged = []
  console.error = (...a) => logged.push(a)
  try {
    return { result: await fn(), logged }
  } finally {
    console.error = real
  }
}

test("research desk: an answer 28h old at digest time still rides; 31h does not", async () => {
  const dir = await tmp()
  const file = path.join(dir, "desk.json")
  const now = Date.parse("2026-10-17T06:30:00Z")
  const item = (answeredAt) => ({ id: "q", status: "answered", question: "Q", answerMarkdown: "A", answeredAt })
  await writeFile(file, JSON.stringify({ items: [item("2026-10-16T02:30:00Z")] }))
  assert.equal((await readPendingResearchAnswer(file, { now }))?.id, "q")
  await writeFile(file, JSON.stringify({ items: [item("2026-10-15T23:30:00Z")] }))
  assert.equal(await readPendingResearchAnswer(file, { now }), null)
  await rm(dir, { recursive: true, force: true })
})

test("serendipity: non-http(s) links get no anchor", async () => {
  const dir = await tmp()
  const file = path.join(dir, "discoveries.json")
  const now = Date.parse("2026-10-17T06:30:00Z")
  const rec = (title, link) => ({
    batchId: "b", generatedAt: "2026-10-17T04:00:00Z", kind: "article", title, link,
    why_it_connects: "c", why_it_is_unexpected: "u",
  })
  await writeFile(file, JSON.stringify([rec("Bad", "javascript:alert(1)"), rec("Good", "https://example.com/x")]))
  const s = await readPendingSerendipityDiscoveries(file, { now })
  assert.doesNotMatch(s.html, /javascript:/)
  assert.match(s.html, /<a href="https:\/\/example\.com\/x">Link<\/a>/)
  assert.equal((s.html.match(/>Link<\/a>/g) || []).length, 1)
  assert.doesNotMatch(s.text, /javascript:/)
  await rm(dir, { recursive: true, force: true })
})

test("section readers: ENOENT is silent, a corrupt file is logged, both return null", async () => {
  const dir = await tmp()
  const bad = path.join(dir, "bad.json")
  await writeFile(bad, "{ truncated")
  const readers = [
    (f) => readPendingResearchAnswer(f),
    (f) => readPendingSerendipityDiscoveries(f),
    (f) => readPendingPrizeDigest(f),
  ]
  for (const read of readers) {
    const missing = await capturingErrors(() => read(path.join(dir, "nope.json")))
    assert.equal(missing.result, null)
    assert.equal(missing.logged.length, 0)
    const corrupt = await capturingErrors(() => read(bad))
    assert.equal(corrupt.result, null)
    assert.equal(corrupt.logged.length, 1)
  }
  await rm(dir, { recursive: true, force: true })
})

test("sendNtfyPush ASCII-sanitizes Title (an em dash no longer makes fetch throw)", async () => {
  const realFetch = globalThis.fetch
  let headers
  globalThis.fetch = async (_url, init) => {
    headers = init.headers
    return { ok: true }
  }
  try {
    assert.equal(await sendNtfyPush({ topic: "t", title: "Fest — “Big” café", message: "m" }), true)
    assert.equal(headers.Title, 'Fest - "Big" caf')
    assert.match(headers.Title, /^[\x20-\x7e]*$/)
    assert.equal(asciiTitle(null), "")
  } finally {
    globalThis.fetch = realFetch
  }
})

test("localDateString is the local calendar date, not the UTC slice", () => {
  const d = new Date(2026, 9, 17, 23, 30) // local 23:30 on Oct 17
  assert.equal(localDateString(d), "2026-10-17")
  assert.equal(localDateString(new Date(2026, 0, 5, 0, 5)), "2026-01-05")
  // soleImminentItem defaults `today` to the local date
  const today = localDateString()
  assert.ok(soleImminentItem([{ date: today, title: "x" }], { dateField: "date" }))
})

test("send guard: refuses a repeat for the same digest after a post-DATA failure, not other digests", async () => {
  const dir = await tmp()
  const staging = path.join(dir, "staging.json")
  const key = sendKey("[1,2]", "x")
  await assertNotAlreadySending(staging, key) // no marker: fine
  await markSending(staging, key)
  await assert.rejects(() => assertNotAlreadySending(staging, key), /send outcome unknown, not retrying/)
  await assertNotAlreadySending(staging, sendKey("[3]", "x")) // different content
  await assertNotAlreadySending(staging, key, Date.now() + 13 * 3600 * 1000) // expired
  await clearSending(staging)
  assert.equal(await exists(sendingMarkerPath(staging)), false)
  await assertNotAlreadySending(staging, key)
  await rm(dir, { recursive: true, force: true })
})

test("smtpSubmit calls onBeforeData only once DATA is accepted", async () => {
  const replies = ["220 r", "250 e", "334 u", "334 p", "235 ok", "250 f", "250 t", "354 go", "250 queued", "221 bye"]
  const run = async (replyList) => {
    const server = net.createServer((sock) => {
      let i = 0
      const send = () => i < replyList.length && sock.write(replyList[i++] + "\r\n")
      send()
      let buf = ""
      sock.on("data", (d) => {
        buf += d.toString()
        let nl
        while ((nl = buf.indexOf("\r\n")) !== -1) {
          const line = buf.slice(0, nl)
          buf = buf.slice(nl + 2)
          if (line === ".") send()
          else if (!(replyList[i - 1] || "").startsWith("354")) send()
        }
      })
      sock.on("error", () => {})
    })
    await new Promise((r) => server.listen(0, "127.0.0.1", r))
    const { port } = server.address()
    let called = 0
    try {
      await smtpSubmit({
        user: "u", pass: "p", envelopeFrom: "u", to: "t", raw: "Subject: x\r\n\r\nhi",
        connect: () => net.connect({ host: "127.0.0.1", port }),
        onBeforeData: async () => { called++ },
      })
    } catch {}
    await new Promise((r) => server.close(r))
    return called
  }
  assert.equal(await run(replies), 1)
  // RCPT refused -> never reaches DATA -> marker would never be written
  assert.equal(await run(["220 r", "250 e", "334 u", "334 p", "235 ok", "250 f", "550 no"]), 0)
})
