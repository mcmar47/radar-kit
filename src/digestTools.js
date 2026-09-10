import { tool } from "@opencode-ai/plugin/tool"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { renderDigestContent, validateDigestContent } from "./digest.js"
import { writeJsonArray } from "./seenStore.js"
import { readMarks } from "./markStore.js"
import { writeFileAtomic } from "./atomicWrite.js"
import { buildScorecard, appendRun, latestRunCost } from "./scorecard.js"
import { sendGmailMessage } from "./gmail.js"
import { readPushTopic, sendNtfyPush } from "./ntfy.js"
import { sendContinuumPush, buildSummary } from "./continuumPush.js"

// A `scorecard` block, when passed to the render/send tools, turns on the
// digest footer line. Shape:
//   {
//     interestedFileName = "interested.json",
//     ignoredFileName    = "ignored.json",
//     runsFileName       = "logs/digest-runs.json",
//     days = 7,
//     noun,          // plural noun for delivered items, e.g. "picks"
//     model,         // model id for this run; falls back to $DIGEST_MODEL
//   }
// The send tool also appends `{ at, count, model }` to the runs file after
// a successful send, so the "delivered last N days" number builds up over
// time. The run wrapper then fills in `costUsd` on that entry once the run
// ends (radar-kit/bin/run-cost.js + openrouterCost.js), so the footer shows
// "$X last run" from the previous run's logged figure.

async function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"))
  } catch (err) {
    if (err.code === "ENOENT") return fallback
    throw err
  }
}

async function writeJsonFileAtomic(filePath, value) {
  await writeFileAtomic(filePath, JSON.stringify(value, null, 2) + "\n", { ensureDir: true })
}

async function scorecardFooter(scorecard, dir) {
  if (!scorecard) return {}
  const {
    interestedFileName = "interested.json",
    ignoredFileName = "ignored.json",
    runsFileName = "logs/digest-runs.json",
    days = 7,
    noun,
    model = process.env.DIGEST_MODEL,
  } = scorecard

  const [interested, ignored, runs] = await Promise.all([
    readMarks(path.join(dir, interestedFileName)),
    readMarks(path.join(dir, ignoredFileName)),
    readJsonFile(path.join(dir, runsFileName), []),
  ])

  const { html, text } = buildScorecard({
    interested,
    ignored,
    runs,
    days,
    model,
    noun,
    // The wrapper writes this run's cost onto the log only after the run
    // ends, so the newest logged cost is the previous run's — shown as
    // "$X last run". null until the first wrapper with cost capture runs.
    costUsd: latestRunCost(runs),
  })
  return { footerHtml: html, footerText: text }
}

// `extraSection`, when passed, is `{ read: async (dir) => ({ html, text,
// id?, onDelivered? }) | null }`. Its block is rendered after the item
// groups and before the scorecard footer, and — in the send tool — lets a
// digest go out with zero items when the section alone is worth sending
// (feed-radar + the Research Desk on a no-picks day). The block must carry
// no <h2>. See src/researchDesk.js for the one implementation.
async function extraSectionContent(extraSection, dir) {
  if (!extraSection?.read) return null
  try {
    return await extraSection.read(dir)
  } catch (err) {
    console.error("digest extraSection.read failed:", err)
    return null
  }
}

export function createRenderDigestTool({
  digestConfig,
  stagingFileName,
  argsShape,
  description,
  scorecard,
  extraSection,
}) {
  return tool({
    description,
    args: { items: tool.schema.array(argsShape) },
    execute: async ({ items }, context) => {
      const today = new Date().toISOString().slice(0, 10)
      const footer = await scorecardFooter(scorecard, context.directory)
      const extra = await extraSectionContent(extraSection, context.directory)
      const rendered = renderDigestContent(digestConfig, items, today, {
        ...footer,
        extraHtml: extra?.html ?? "",
        extraText: extra?.text ?? "",
      })
      await writeJsonArray(context.directory, stagingFileName, items)
      return JSON.stringify({ ...rendered, extraSection: Boolean(extra) }, null, 2)
    },
  })
}

export function createValidateDigestTool({ digestConfig, argsShape, description }) {
  return tool({
    description,
    args: {
      html: tool.schema.string(),
      body: tool.schema.string(),
      items: tool.schema.array(argsShape),
    },
    execute: async ({ html, body, items }) =>
      JSON.stringify(validateDigestContent(digestConfig, html, body, items), null, 2),
  })
}

// Reads the staging file render_digest wrote, re-renders and re-validates
// from it directly (never trusting whatever the model may have retyped),
// and sends via the Gmail API in one atomic step — the actual digest
// content never passes back through the model as text between tool calls,
// which is where long-content retyping corrupts it.
// `push`, when passed, is `{ pickHighlight: (sentItems) => ({ title,
// message, clickUrl?, tags?, priority? }) | null }`. After a confirmed send,
// pickHighlight runs against exactly the items that went out; a non-null
// return is POSTed as one ntfy notification (radar-kit/ntfy) to the topic in
// ~/.config/pi-ops/ntfy-push-topic. It is strictly post-send and
// best-effort: a missing topic, a null highlight, or a failed POST all leave
// the digest result untouched. Only event-watch and release-radar pass this
// — see NEW-IDEAS.md C4 and each plugin's pickHighlight.
//
// `continuumPush`, when passed, is `{ noun, titleField?, deepLink? }` — a
// separate channel from `push`: one per-radar summary banner ("5 new feed
// picks") to the Continuum iOS app via radar-kit/continuumPush, so the
// phone doesn't wait on its throttled BGTaskScheduler wake-up. All four
// Inbox-feeding radars pass it. See maybeContinuumSummary + buildSummary.
async function maybePush(push, items) {
  if (!push?.pickHighlight || !Array.isArray(items) || items.length === 0) return
  try {
    const highlight = push.pickHighlight(items)
    if (!highlight) return
    const topic = await readPushTopic()
    if (!topic) return
    await sendNtfyPush({ topic, ...highlight })
  } catch (err) {
    console.error("send_digest_email: highlight push failed:", err)
  }
}

// A per-radar summary push to the Continuum iOS app: one banner titled with
// the count of items this digest run sent, so the phone learns about new
// undecided picks the moment they're chosen rather than on the app's next
// throttled background wake-up. `continuumPush`, when a repo passes it, is
// `{ noun, titleField?, deepLink? }` — see buildSummary. Strictly post-send
// and best-effort (continuum-push is Tailscale-internal and may not be
// running / may have no devices registered), exactly like maybePush above.
// Distinct from `push`/pickHighlight, which stays the near-empty
// single-time-critical-row ntfy channel.
async function maybeContinuumSummary(continuumPush, items) {
  if (!continuumPush || !Array.isArray(items) || items.length === 0) return
  try {
    const summary = buildSummary(items, continuumPush)
    if (summary) await sendContinuumPush(summary)
  } catch (err) {
    console.error("send_digest_email: continuum summary push failed:", err)
  }
}

export function createSendDigestEmailTool({
  digestConfig,
  stagingFileName,
  digestRecipient,
  extraResultFields,
  description,
  scorecard,
  extraSection,
  push,
  continuumPush,
}) {
  return tool({
    description,
    args: { subject: tool.schema.string() },
    execute: async ({ subject }, context) => {
      const filePath = path.join(context.directory, stagingFileName)
      let items = []
      try {
        const parsed = JSON.parse(await readFile(filePath, "utf8"))
        if (Array.isArray(parsed)) items = parsed
      } catch (err) {
        // A missing staging file is fine when there's an extra section to
        // carry; render_digest just wasn't called on a no-items day.
        if (err.code !== "ENOENT") throw err
      }

      const extra = await extraSectionContent(extraSection, context.directory)

      if (items.length === 0 && !extra) {
        // Not an error: feed-radar calls this on a no-picks day too, in case
        // a Research Desk answer is waiting, and most days there isn't one.
        return JSON.stringify({ sent: false, reason: "nothing to send" }, null, 2)
      }

      const today = new Date().toISOString().slice(0, 10)
      const footer = await scorecardFooter(scorecard, context.directory)
      const { html, text } = renderDigestContent(digestConfig, items, today, {
        ...footer,
        extraHtml: extra?.html ?? "",
        extraText: extra?.text ?? "",
      })
      const validation = validateDigestContent(digestConfig, html, text, items)
      if (!validation.pass) {
        throw new Error(
          "Refusing to send: rendered digest failed validation — " +
            validation.failures.join("; ")
        )
      }

      const result = await sendGmailMessage({ to: digestRecipient, subject, text, html })

      // Tell the extra section's source it went out (Research Desk stamps
      // deliveredAt). Best-effort — the section's own freshness window is
      // the real guard against a re-send, so a failed callback is harmless.
      if (extra?.onDelivered) {
        try {
          await extra.onDelivered()
        } catch (err) {
          console.error("send_digest_email: extraSection.onDelivered failed:", err)
        }
      }

      // One push for the single time-critical row, if this repo asked for
      // one and exactly one item qualifies. Strictly post-send, best-effort.
      await maybePush(push, items)

      // One per-radar summary push to the Continuum app, if this repo asked
      // for one. Also strictly post-send and best-effort.
      await maybeContinuumSummary(continuumPush, items)

      // Record this run's size so future footers can total "delivered last
      // N days". Only after a confirmed send, and never fatal: a failure to
      // write the log must not turn a sent digest into an error.
      if (scorecard) {
        try {
          const runsFileName = scorecard.runsFileName ?? "logs/digest-runs.json"
          const runsPath = path.join(context.directory, runsFileName)
          const runs = await readJsonFile(runsPath, [])
          await writeJsonFileAtomic(
            runsPath,
            appendRun(runs, {
              count: items.length,
              model: scorecard.model ?? process.env.DIGEST_MODEL,
            })
          )
        } catch (err) {
          console.error("send_digest_email: could not update the run log:", err)
        }
      }

      return JSON.stringify(
        {
          sent: true,
          messageId: result.id,
          threadId: result.threadId,
          itemCount: items.length,
          ...(extra ? { extraSection: extra.id ?? true } : {}),
          ...(extraResultFields && items.length ? extraResultFields(items) : {}),
        },
        null,
        2
      )
    },
  })
}
