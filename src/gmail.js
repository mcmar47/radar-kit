// Reuses the same OAuth credentials the Gmail MCP server
// (@gongrzhe/server-gmail-autoauth-mcp) already manages at ~/.gmail-mcp/ —
// shared across every repo on this machine, no separate auth setup — but
// bypasses that MCP server's own send-email tool call entirely. The actual
// failure mode being fixed isn't in the MCP server: it's the model having to
// regenerate a previous tool's HTML output as text to pass into a second
// tool call, which is exactly where retyping corrupts long content. One
// tool doing render + send atomically, reading straight from disk, removes
// that hand-off completely.

import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"

const GMAIL_MCP_DIR = path.join(os.homedir(), ".gmail-mcp")
const DEFAULT_SENDER_NAME = "CmarBot"
// A "Send mail as" alias on the same account, registered with display name
// "CmarBot" in Gmail settings. Sending from the bare primary address doesn't
// work for this: Gmail overrides a message's displayed sender name with the
// account's own registered name whenever it recognizes the sender as the
// viewer's own account, ignoring whatever the raw From header says — which
// is exactly what these self-addressed digest emails are. A distinct alias
// is the only way to get a custom name to actually render, without renaming
// the primary account and changing every personal email's sender too.
const DEFAULT_SENDER_ADDRESS = "michael.cmar+cmarbot@gmail.com"

// A header value can never carry a bare CR or LF: everything after one is
// parsed as a new header. `subject` is free text the model writes each run,
// normally from a scraped headline, so it is exactly the field that picks up
// a stray newline -- and encodeEmailHeader only base64-wraps when it sees a
// non-ASCII byte, so a pure-ASCII subject containing \r\n passed straight
// through and everything after it became real headers:
//
//   Subject: Feed Radar
//   Bcc: someone@example.com
//   X-Injected: yes
//
// Collapsing CR/LF to a space keeps the value intact and the header block
// well-formed. Applied to every header value, not just subject, so a future
// caller passing a recipient through can't reopen the same hole.
function sanitizeHeaderValue(text) {
  return String(text ?? "").replace(/[\r\n]+/g, " ").trim()
}

function encodeEmailHeader(text) {
  if (/[^\x00-\x7F]/.test(text)) {
    return "=?UTF-8?B?" + Buffer.from(text, "utf8").toString("base64") + "?="
  }
  return text
}

function formatFromHeader(name, address) {
  if (/[^\x00-\x7F]/.test(name)) {
    return `${encodeEmailHeader(name)} <${address}>`
  }
  return `"${name.replace(/"/g, '\\"')}" <${address}>`
}

export function buildRawMimeMessage({ to, subject, text, html, fromName, fromAddress }) {
  const boundary = `----=_NextPart_${Math.random().toString(36).slice(2)}`
  const parts = [
    `From: ${formatFromHeader(sanitizeHeaderValue(fromName), sanitizeHeaderValue(fromAddress))}`,
    `To: ${sanitizeHeaderValue(to)}`,
    `Subject: ${encodeEmailHeader(sanitizeHeaderValue(subject))}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 7bit",
    "",
    text,
    "",
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: 7bit",
    "",
    html,
    "",
    `--${boundary}--`,
  ]
  return parts.join("\r\n")
}

async function refreshGmailAccessToken() {
  const keysRaw = await readFile(
    path.join(GMAIL_MCP_DIR, "gcp-oauth.keys.json"),
    "utf8"
  )
  const keys = JSON.parse(keysRaw).installed
  const credsPath = path.join(GMAIL_MCP_DIR, "credentials.json")
  const creds = JSON.parse(await readFile(credsPath, "utf8"))

  const res = await fetch(keys.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: keys.client_id,
      client_secret: keys.client_secret,
      refresh_token: creds.refresh_token,
      grant_type: "refresh_token",
    }),
  })
  if (!res.ok) {
    throw new Error(
      `Gmail OAuth token refresh failed: ${res.status} ${await res.text()}`
    )
  }
  const data = await res.json()
  await writeFile(
    credsPath,
    JSON.stringify(
      {
        ...creds,
        access_token: data.access_token,
        expiry_date: Date.now() + data.expires_in * 1000,
      },
      null,
      2
    ),
    "utf8"
  )
  return data.access_token
}

export async function sendGmailMessage({
  to,
  subject,
  text,
  html,
  fromName = DEFAULT_SENDER_NAME,
  fromAddress = DEFAULT_SENDER_ADDRESS,
}) {
  const accessToken = await refreshGmailAccessToken()
  const raw = buildRawMimeMessage({ to, subject, text, html, fromName, fromAddress })
  const rawEncoded = Buffer.from(raw, "utf8").toString("base64url")

  const res = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ raw: rawEncoded }),
    }
  )
  if (!res.ok) {
    throw new Error(`Gmail send failed: ${res.status} ${await res.text()}`)
  }
  return await res.json()
}
