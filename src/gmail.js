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

function encodeEmailHeader(text) {
  if (/[^\x00-\x7F]/.test(text)) {
    return "=?UTF-8?B?" + Buffer.from(text, "utf8").toString("base64") + "?="
  }
  return text
}

function buildRawMimeMessage({ to, subject, text, html }) {
  const boundary = `----=_NextPart_${Math.random().toString(36).slice(2)}`
  const parts = [
    "From: me",
    `To: ${to}`,
    `Subject: ${encodeEmailHeader(subject)}`,
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

export async function sendGmailMessage({ to, subject, text, html }) {
  const accessToken = await refreshGmailAccessToken()
  const raw = buildRawMimeMessage({ to, subject, text, html })
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
