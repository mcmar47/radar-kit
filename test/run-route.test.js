import { test } from "node:test"
import assert from "node:assert/strict"
import { createInterestServer } from "../src/interestServer.js"
import { createRunRoute } from "../src/runRoute.js"

async function withServer(routes, run) {
  const { server, listen } = createInterestServer({ name: "test", port: 0, routes })
  await new Promise((resolve) => listen(resolve))
  const { port } = server.address()
  try {
    await run((init = {}) =>
      fetch(`http://127.0.0.1:${port}/api/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        ...init,
      })
    )
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

// A fake systemctl: records calls, reports the unit's state.
function fakeSystemd({ state = "inactive", startCode = 0 } = {}) {
  const calls = []
  const run = async (cmd, args) => {
    calls.push([cmd, ...args].join(" "))
    if (args[0] === "is-active") return { code: state === "active" ? 0 : 3, stdout: state, stderr: "" }
    return { code: startCode, stdout: "", stderr: startCode ? "sudo: a password is required" : "" }
  }
  return { run, calls }
}

test("POST /api/run starts the unit without blocking and answers 202", async () => {
  const sd = fakeSystemd()
  await withServer([createRunRoute({ unit: "event-watch.service", run: sd.run })], async (post) => {
    const res = await post()
    assert.equal(res.status, 202)
    assert.equal((await res.json()).unit, "event-watch.service")
  })
  assert.deepEqual(sd.calls, [
    "systemctl is-active event-watch.service",
    "sudo -n systemctl start --no-block event-watch.service",
  ])
})

test("a non-JSON POST is refused before anything runs (cross-site simple request)", async () => {
  const sd = fakeSystemd()
  await withServer([createRunRoute({ unit: "event-watch.service", run: sd.run })], async (post) => {
    const res = await post({ headers: { "content-type": "text/plain" }, body: "{}" })
    assert.equal(res.status, 415)
  })
  assert.deepEqual(sd.calls, [])
})

test("an already-running unit is a 409 and is not started again", async () => {
  const sd = fakeSystemd({ state: "activating" })
  await withServer([createRunRoute({ unit: "feed-radar.service", run: sd.run })], async (post) => {
    assert.equal((await post()).status, 409)
  })
  assert.equal(sd.calls.filter((c) => c.startsWith("sudo")).length, 0)
})

test("a second trigger inside the cooldown is a 429; after it, it runs again", async () => {
  const sd = fakeSystemd()
  let clock = 1_000_000
  const route = createRunRoute({ unit: "job-radar.service", run: sd.run, cooldownMinutes: 30, now: () => clock })
  await withServer([route], async (post) => {
    assert.equal((await post()).status, 202)
    clock += 10 * 60_000
    const second = await post()
    assert.equal(second.status, 429)
    assert.equal((await second.json()).retryAfterSec, 20 * 60)
    clock += 21 * 60_000
    assert.equal((await post()).status, 202)
  })
  assert.equal(sd.calls.filter((c) => c.startsWith("sudo")).length, 2)
})

test("a failed start is a 500 and doesn't start the cooldown", async () => {
  const sd = fakeSystemd({ startCode: 1 })
  await withServer([createRunRoute({ unit: "event-watch.service", run: sd.run })], async (post) => {
    assert.equal((await post()).status, 500)
    assert.equal((await post()).status, 500, "not 429: the failed attempt didn't count")
  })
})

test("createRunRoute refuses a unit name that isn't a plain service", () => {
  assert.throws(() => createRunRoute({ unit: "event-watch.timer" }))
  assert.throws(() => createRunRoute({ unit: "x.service; rm -rf /" }))
})
