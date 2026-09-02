// One durable file write, done the way every store in this fleet needs it.
//
// Write to a sibling temp file, fchmod it, flush it, then rename into
// place. rename(2) is atomic within a directory, so a reader — or a power
// cut — sees either the whole old file or the whole new one, never a
// truncated file. Three details matter and each was a real incident:
//
//   - **fsync before rename.** On the Pi specifically, without it the
//     rename can land while the new bytes are still only in page cache; a
//     power cut then leaves the rename applied and the file empty.
//   - **fchmod, not open(mode).** open()'s mode argument is masked by the
//     caller's umask, so a process running under 0077 (a cron entry, a
//     systemd unit with no explicit UMask=) writes 0600 and nginx then
//     403s the file. fchmod(2) on the handle is not subject to umask, so
//     the result is deterministic regardless of who calls this.
//   - **temp file in the same directory.** rename is only atomic within a
//     filesystem; a temp file in /tmp could be a cross-device copy.
//
// This started as byte-identical code in markStore.js (radar-kit) and
// store.js (shelf), plus a third near-copy that grew in digestTools.js for
// the run log. shelf's copy even carried a comment saying to reconcile the
// two "when radar-kit comes in anyway" — it has, so this is that.
//
// Zero-dependency and plugin-free, like markStore.js — a server or a plain
// script imports it via "radar-kit/atomicWrite" and pulls nothing else.

import { open, rename, mkdir } from "node:fs/promises"
import { dirname } from "node:path"

/**
 * @param {string} filePath   destination path
 * @param {string|Uint8Array} data  file contents, written as UTF-8 if a string
 * @param {object} [opts]
 * @param {number} [opts.mode=0o644]   final mode, applied via fchmod so the
 *        umask cannot narrow it — these files are served by nginx and must
 *        stay world-readable
 * @param {boolean} [opts.ensureDir=false]  mkdir -p the parent directory first
 */
export async function writeFileAtomic(filePath, data, { mode = 0o644, ensureDir = false } = {}) {
  if (ensureDir) await mkdir(dirname(filePath), { recursive: true })

  const tmp = `${filePath}.tmp`
  const handle = await open(tmp, "w")
  try {
    await handle.writeFile(data, "utf8")
    await handle.chmod(mode)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(tmp, filePath)
}
