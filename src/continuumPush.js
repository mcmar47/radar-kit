// One push to the Continuum iOS app, via the continuum-push service running
// on the Pi (127.0.0.1:8031). The other in-app-notification channel besides
// ntfy.js — and like ntfy.js it is:
//
//   - dependency-free and plugin-free (global fetch and nothing else), so a
//     server can import "radar-kit/continuumPush" without pulling
//     @opencode-ai/plugin — same contract as radar-kit/ntfy.
//   - best-effort by contract: a push that fails (service down, no devices
//     registered, a timeout) must never turn a delivered digest into a
//     failed run. Every caller ignores the result.
//
// Unlike ntfy.js there is no secret to read. The endpoint is Pi-local and
// unauthenticated because nginx does not proxy /api/push (see
// pi-bootstrap/nginx/continuum-push) — being able to reach it at all means
// you are already running on the box, which is the same trust boundary as
// the interest-servers' Pi-internal routes.
//
// What this replaces: continuum-ios's RefreshScheduler posts local
// notifications from an opportunistic BGTaskScheduler wake-up, which iOS
// throttles hard (often hours late, never if the app is force-quit). A push
// fired straight from the digest run that produced the items is immediate
// and reliable. The wording here mirrors that path's report(): one banner
// per radar, titled with the count.

const DEFAULT_ENDPOINT = "http://127.0.0.1:8031/api/push"

const oneLine = (s) => String(s ?? "").replace(/[\r\n]+/g, " ").trim()

/**
 * POST one alert notification to the continuum-push service.
 *
 * @param {object} opts
 * @param {string}  opts.title       notification title (one line)
 * @param {string}  opts.body        notification body
 * @param {string} [opts.deepLink]   a continuum:// URL for the tap target
 * @param {number} [opts.badge]      app-icon badge count
 * @param {object} [opts.userInfo]   extra keys delivered in the payload,
 *   read by Continuum's UNUserNotificationCenter delegate (origin / markKey)
 * @param {string} [opts.endpoint]   override, else $CONTINUUM_PUSH_ENDPOINT
 * @param {number} [opts.timeoutMs=10000]  generous on purpose — this runs
 *   post-send and best-effort, and a cold Node process's first outbound
 *   call on a Pi has been seen to take several seconds (see ntfy.js).
 * @returns {Promise<boolean>}  true on a 2xx, false otherwise
 */
export async function sendContinuumPush({
  title,
  body,
  deepLink,
  badge,
  userInfo,
  endpoint = process.env.CONTINUUM_PUSH_ENDPOINT || DEFAULT_ENDPOINT,
  timeoutMs = 10_000,
}) {
  if (!title) return false

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: oneLine(title),
        body: oneLine(body),
        ...(deepLink ? { deepLink } : {}),
        ...(Number.isFinite(badge) ? { badge } : {}),
        ...(userInfo && typeof userInfo === "object" ? { userInfo } : {}),
      }),
      signal: controller.signal,
    })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim()

/**
 * Build the one-line summary for a digest run that sent `items`, or null
 * when there is nothing to say. Mirrors continuum-ios's
 * RefreshScheduler.report(): "N new <noun>s", body = the lead few titles in
 * the digest's own (triage) order.
 *
 * @param {object[]} items
 * @param {object}   opts
 * @param {string}   opts.noun          singular, e.g. "feed pick" / "event"
 * @param {string}  [opts.titleField="title"]
 * @param {string}  [opts.deepLink="continuum://inbox"]
 * @param {number}  [opts.leadCount=3]
 * @returns {{title,body,deepLink}|null}
 */
export function buildSummary(
  items,
  { noun, titleField = "title", deepLink = "continuum://inbox", leadCount = 3 } = {}
) {
  if (!Array.isArray(items) || items.length === 0) return null
  const n = items.length
  const label = n === 1 ? noun : `${noun}s`

  const titles = items
    .map((it) => clean(it?.[titleField]))
    .filter(Boolean)
    .slice(0, leadCount)
  const remainder = n - titles.length
  const body = remainder > 0 ? `${titles.join(" · ")} — and ${remainder} more` : titles.join(" · ")

  return { title: `${n} new ${label}`, body: body || `${n} new ${label}`, deepLink }
}
