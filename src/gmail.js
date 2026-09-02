// Sends the digest email over Gmail's SMTP submission service
// (smtp.gmail.com:465) authenticated with a Gmail *app password*, read from
// ~/.gmail-mcp/smtp.json — the shared credential dir every repo on this
// machine already uses, and one pi-bootstrap already backs up via its
// `~/.gmail-mcp/*.json` glob.
//
// Why SMTP + app password rather than the Gmail API + OAuth: the OAuth
// consent screen for this project is stuck in "Testing" status (publishing
// it needs a verified domain + privacy-policy URL for the restricted Gmail
// scopes), and Google hard-expires a Testing-mode refresh token after
// exactly 7 days. That turned into a silent weekly outage. App passwords do
// not expire, need no console configuration, and this fleet only ever
// *sends* — so SMTP submission is all it needs.
//
// This still bypasses the @gongrzhe/server-gmail-autoauth-mcp MCP server's
// own send tool entirely, for the original reason: one tool doing render +
// send atomically, reading straight from disk, removes the hand-off where
// the model would otherwise have to retype a previous tool's HTML output as
// text into a second call.

import { readFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import tls from "node:tls"
import { randomUUID } from "node:crypto"

const SMTP_CREDENTIALS = path.join(os.homedir(), ".gmail-mcp", "smtp.json")
const SMTP_HOST = "smtp.gmail.com"
const SMTP_PORT = 465
const DEFAULT_SENDER_NAME = "CmarBot"
// A "Send mail as" alias on the same account, registered with display name
// "CmarBot" in Gmail settings. Sending from the bare primary address doesn't
// work for this: Gmail overrides a message's displayed sender name with the
// account's own registered name whenever it recognizes the sender as the
// viewer's own account, ignoring whatever the raw From header says — which
// is exactly what these self-addressed digest emails are. A distinct alias
// is the only way to get a custom name to actually render, without renaming
// the primary account and changing every personal email's sender too.
// SMTP submission keeps this working: the envelope sender stays the
// authenticated account, and Gmail leaves the From header alone as long as
// it names a verified alias.
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

// Wraps a Buffer/base64 payload as one MIME attachment part: base64,
// 76-char lines (RFC 2045), disposition `attachment` with the filename.
function attachmentPart(boundary, { filename, contentType, content }) {
  const b64 = (Buffer.isBuffer(content) ? content : Buffer.from(String(content), "base64"))
    .toString("base64")
    .replace(/(.{76})/g, "$1\r\n")
  return [
    `--${boundary}`,
    `Content-Type: ${sanitizeHeaderValue(contentType || "application/octet-stream")}`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; filename="${sanitizeHeaderValue(filename || "attachment").replace(/"/g, "")}"`,
    "",
    b64,
    "",
  ]
}

export function buildRawMimeMessage({
  to,
  subject,
  text,
  html,
  fromName,
  fromAddress,
  messageId,
  date,
  attachments = [],
}) {
  const altBoundary = `----=_Alt_${Math.random().toString(36).slice(2)}`
  const alt = [
    `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
    "",
    `--${altBoundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 7bit",
    "",
    text,
    "",
    `--${altBoundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: 7bit",
    "",
    html,
    "",
    `--${altBoundary}--`,
  ]

  const headers = [
    `From: ${formatFromHeader(sanitizeHeaderValue(fromName), sanitizeHeaderValue(fromAddress))}`,
    `To: ${sanitizeHeaderValue(to)}`,
    `Subject: ${encodeEmailHeader(sanitizeHeaderValue(subject))}`,
    // Gmail's SMTP server fills in Date/Message-ID when they're absent, but
    // setting them here means sendGmailMessage can return the same id it
    // put on the wire without a follow-up round trip.
    `Date: ${(date ?? new Date()).toUTCString()}`,
    ...(messageId ? [`Message-ID: ${sanitizeHeaderValue(messageId)}`] : []),
    "MIME-Version: 1.0",
  ]

  const files = (attachments ?? []).filter((a) => a && a.content != null)
  if (files.length === 0) {
    return [...headers, ...alt].join("\r\n")
  }

  // With attachments the alternative part becomes one leaf of a
  // multipart/mixed tree.
  const mixBoundary = `----=_Mix_${Math.random().toString(36).slice(2)}`
  const parts = [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${mixBoundary}"`,
    "",
    `--${mixBoundary}`,
    ...alt,
    "",
    ...files.flatMap((f) => attachmentPart(mixBoundary, f)),
    `--${mixBoundary}--`,
  ]
  return parts.join("\r\n")
}

// Reads one SMTP reply, which may span several `NNN-...` continuation lines
// before the terminating `NNN <text>` line (space, not dash, after the
// code). Resolves { code, text } on that terminator; rejects on socket error.
function readSmtpReply(socket) {
  return new Promise((resolve, reject) => {
    let buf = ""
    const cleanup = () => {
      socket.removeListener("data", onData)
      socket.removeListener("error", onError)
    }
    const onData = (chunk) => {
      buf += chunk.toString("utf8")
      for (const line of buf.split("\r\n")) {
        if (/^\d{3} /.test(line)) {
          cleanup()
          resolve({ code: Number(line.slice(0, 3)), text: buf.trimEnd() })
          return
        }
      }
    }
    const onError = (err) => {
      cleanup()
      reject(err)
    }
    socket.on("data", onData)
    socket.on("error", onError)
  })
}

// Minimal SMTP-over-implicit-TLS submission: EHLO, AUTH LOGIN, one
// recipient, one message. Deliberately dependency-free — Gmail's submission
// endpoint is well-behaved and this fleet sends one short multipart message
// at a time, so the surface a full mailer library would cover (connection
// pooling, pipelining, STARTTLS upgrade, retry queues) is all absent by
// design.
async function smtpSubmit({ user, pass, envelopeFrom, to, raw }) {
  const socket = tls.connect({ host: SMTP_HOST, port: SMTP_PORT, servername: SMTP_HOST })
  socket.setEncoding("utf8")
  try {
    const step = async (command, ...okCodes) => {
      if (command !== null) socket.write(command + "\r\n")
      const { code, text } = await readSmtpReply(socket)
      if (!okCodes.includes(code)) {
        const label = command ? command.split(" ")[0] : "greeting"
        // Never let a raw AUTH line into an error message.
        throw new Error(`SMTP ${label} failed: ${text.replace(/\s+/g, " ").trim()}`)
      }
      return text
    }

    await step(null, 220)
    await step("EHLO radar-kit", 250)
    await step("AUTH LOGIN", 334)
    await step(Buffer.from(user, "utf8").toString("base64"), 334)
    await step(Buffer.from(pass, "utf8").toString("base64"), 235)
    await step(`MAIL FROM:<${envelopeFrom}>`, 250)
    await step(`RCPT TO:<${to}>`, 250, 251)
    await step("DATA", 354)
    // Normalize to CRLF, then dot-stuff any line that begins with '.' so it
    // can't be read as the end-of-data terminator.
    const body = raw.replace(/\r?\n/g, "\r\n").replace(/(^|\r\n)\./g, "$1..")
    socket.write(body + "\r\n.\r\n")
    await step(null, 250)
    await step("QUIT", 221)
  } finally {
    socket.end()
  }
}

export async function sendGmailMessage({
  to,
  subject,
  text,
  html,
  attachments = [],
  fromName = DEFAULT_SENDER_NAME,
  fromAddress = DEFAULT_SENDER_ADDRESS,
}) {
  let user, pass
  try {
    ;({ user, pass } = JSON.parse(await readFile(SMTP_CREDENTIALS, "utf8")))
  } catch (err) {
    throw new Error(
      `Could not read SMTP credentials from ${SMTP_CREDENTIALS} ` +
        `(expected {"user","pass"} with a Gmail app password): ${err.message}`
    )
  }
  if (!user || !pass) {
    throw new Error(`${SMTP_CREDENTIALS} is missing "user" or "pass".`)
  }

  const messageId = `<${randomUUID()}@mail.gmail.com>`
  const raw = buildRawMimeMessage({
    to,
    subject,
    text,
    html,
    attachments,
    fromName,
    fromAddress,
    messageId,
  })

  await smtpSubmit({
    user,
    // App passwords are shown grouped as "xxxx xxxx xxxx xxxx"; Gmail accepts
    // either form, but strip the spaces so a copy-paste of the grouped form
    // doesn't get base64'd with them.
    pass: String(pass).replace(/\s+/g, ""),
    // Envelope stays the authenticated account; the From header carries the
    // CmarBot alias.
    envelopeFrom: user,
    to,
    raw,
  })

  // Kept shape-compatible with the old Gmail API return. SMTP submission
  // has no thread concept, so threadId is always null now.
  return { id: messageId, threadId: null }
}
