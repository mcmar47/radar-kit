// Blocks a digest send from repeating the blank-email incident diagnosed in
// event-watch on 2026-08-24. Root cause (confirmed by reading the actual
// source of the Gmail MCP server in use, @gongrzhe/server-gmail-autoauth-mcp
// dist/utl.js createEmailMessage): `mimeType` defaults to "text/plain", and
// the server only builds a multipart message containing `htmlBody` when
// `mimeType` is explicitly something other than "text/plain". Without that,
// `htmlBody` is silently discarded entirely and only `body` gets sent
// verbatim — however empty or inadequate it is. `body` is also required; it
// can't simply be omitted.
//
// This runs before the Gmail MCP tool actually executes, so it can't be
// skipped by the model forgetting or ignoring a prose instruction. It also
// cross-checks htmlBody against the staging JSON file (if still present at
// send time, i.e. render_digest already ran) using the same matchFields a
// repo's own digest config already defines for validate_digest, so a
// generator dropping an item is caught before sending, not after.

import { readFile } from "node:fs/promises"
import path from "node:path"
import { escapeHtml } from "./html.js"

export function createValidateGmailSendPlugin({ stagingFileName, matchFields }) {
  return async ({ directory } = {}) => {
    return {
      "tool.execute.before": async (input, output) => {
        if (!/send_email/i.test(input.tool)) return

        const args = output.args ?? {}
        const html = args.htmlBody

        if (html && typeof html === "string" && html.trim() !== "") {
          if (!/<\/body>\s*<\/html>\s*$/i.test(html.trim())) {
            throw new Error(
              "Refusing to send: `htmlBody` does not end with a closing " +
                "</body></html> tag — it may be truncated."
            )
          }

          if (args.mimeType !== "multipart/alternative") {
            throw new Error(
              "Refusing to send: `htmlBody` is set but `mimeType` is not " +
                '"multipart/alternative". This Gmail MCP server defaults ' +
                'mimeType to "text/plain" and, in that case, discards ' +
                "htmlBody entirely and sends only `body` instead — silently. " +
                'Set mimeType to "multipart/alternative".'
            )
          }
        }

        const body = args.body
        if (!body || typeof body !== "string" || body.trim().length < 100) {
          throw new Error(
            "Refusing to send: `body` (the required plain-text alternative) " +
              "is missing, empty, or too short to be a real digest. This " +
              "tool requires a non-empty `body` and will send it verbatim " +
              "instead of htmlBody whenever mimeType isn't " +
              "multipart/alternative — generate a real plain-text version, " +
              "don't leave it empty or use a one-line placeholder."
          )
        }

        if (html && directory && stagingFileName) {
          try {
            const raw = await readFile(path.join(directory, stagingFileName), "utf8")
            const items = JSON.parse(raw)
            const missing = items.filter((item) =>
              matchFields.some(({ key, escape = true }) => {
                const needle = escape ? escapeHtml(String(item[key])) : String(item[key])
                return !html.includes(needle)
              })
            )
            if (missing.length > 0) {
              throw new Error(
                "Refusing to send: htmlBody is missing " +
                  `${missing.length} item(s) present in ${stagingFileName} ` +
                  `(e.g. "${missing[0].title}") — the digest likely dropped ` +
                  "some. Regenerate with render_digest, don't send a partial digest."
              )
            }
          } catch (err) {
            if (err.code !== "ENOENT") throw err
          }
        }
      },
    }
  }
}
