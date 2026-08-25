import { tool } from "@opencode-ai/plugin/tool"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { renderDigestContent, validateDigestContent } from "./digest.js"
import { writeJsonArray } from "./seenStore.js"
import { sendGmailMessage } from "./gmail.js"

export function createRenderDigestTool({ digestConfig, stagingFileName, argsShape, description }) {
  return tool({
    description,
    args: { items: tool.schema.array(argsShape) },
    execute: async ({ items }, context) => {
      const today = new Date().toISOString().slice(0, 10)
      const rendered = renderDigestContent(digestConfig, items, today)
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
      const { html, text } = renderDigestContent(digestConfig, items, today)
      const validation = validateDigestContent(digestConfig, html, text, items)
      if (!validation.pass) {
        throw new Error(
          "Refusing to send: rendered digest failed validation — " +
            validation.failures.join("; ")
        )
      }

      const result = await sendGmailMessage({ to: digestRecipient, subject, text, html })

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
