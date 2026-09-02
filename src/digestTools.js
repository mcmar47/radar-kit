import { tool } from "@opencode-ai/plugin/tool"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { renderDigestContent, validateDigestContent } from "./digest.js"
import { writeJsonArray } from "./seenStore.js"
import { readMarks } from "./markStore.js"
import { writeFileAtomic } from "./atomicWrite.js"
import { buildScorecard, appendRun } from "./scorecard.js"
import { sendGmailMessage } from "./gmail.js"

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
// time. costUsd is left unset — see README, wiring per-run OpenRouter cost
// needs a generation-id capture in the run wrapper that does not exist yet.

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
  })
  return { footerHtml: html, footerText: text }
}

export function createRenderDigestTool({
  digestConfig,
  stagingFileName,
  argsShape,
  description,
  scorecard,
}) {
  return tool({
    description,
    args: { items: tool.schema.array(argsShape) },
    execute: async ({ items }, context) => {
      const today = new Date().toISOString().slice(0, 10)
      const footer = await scorecardFooter(scorecard, context.directory)
      const rendered = renderDigestContent(digestConfig, items, today, footer)
      await writeJsonArray(context.directory, stagingFileName, items)
      return JSON.stringify(rendered, null, 2)
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
export function createSendDigestEmailTool({
  digestConfig,
  stagingFileName,
  digestRecipient,
  extraResultFields,
  description,
  scorecard,
}) {
  return tool({
    description,
    args: { subject: tool.schema.string() },
    execute: async ({ subject }, context) => {
      const filePath = path.join(context.directory, stagingFileName)
      let raw
      try {
        raw = await readFile(filePath, "utf8")
      } catch (err) {
        if (err.code === "ENOENT") {
          throw new Error(`${stagingFileName} not found — call render_digest first.`)
        }
        throw err
      }
      const items = JSON.parse(raw)
      if (!Array.isArray(items) || items.length === 0) {
        throw new Error(`${stagingFileName} is empty or invalid — nothing to send.`)
      }

      const today = new Date().toISOString().slice(0, 10)
      const footer = await scorecardFooter(scorecard, context.directory)
      const { html, text } = renderDigestContent(digestConfig, items, today, footer)
      const validation = validateDigestContent(digestConfig, html, text, items)
      if (!validation.pass) {
        throw new Error(
          "Refusing to send: rendered digest failed validation — " +
            validation.failures.join("; ")
        )
      }

      const result = await sendGmailMessage({ to: digestRecipient, subject, text, html })

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
          messageId: result.id,
          threadId: result.threadId,
          itemCount: items.length,
          ...(extraResultFields ? extraResultFields(items) : {}),
        },
        null,
        2
      )
    },
  })
}
