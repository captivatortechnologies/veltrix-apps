// ============================================================================
// Reverse-sync core — the pure heart of `veltrix dev`'s live pull.
//
// When an app is edited in the portal's sandbox editor, the platform emits a
// `sandbox:file-changed` event and exposes the new content over the file API.
// These functions decide, without any I/O of their own (bar the small,
// well-contained filesystem helpers), whether and how a remote edit lands in
// the developer's local workspace:
//
//   - echo guard   — never re-apply a change this CLI itself produced
//   - conflict rule — apply a remote edit only when local disk still matches
//                     the sandbox's *previous* content; otherwise skip
//   - reconciliation — on (re)connect, hash-diff the sandbox file list against
//                     local disk and apply the non-conflicting remote changes
//   - atomic write  — temp file + rename so a reader never sees a half file
//
// Everything here is deterministic and side-effect free on its inputs (the
// fs helpers touch only the paths they are handed), so the unit tests in
// cli/test/ exercise it directly.
// ============================================================================

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

/** Normalize undefined/null/'' to a single `null` for hash comparisons. */
const norm = (value) => (value === undefined || value === null || value === '' ? null : value)

// ---------------------------------------------------------------------------
// Hashing + content decoding
// ---------------------------------------------------------------------------

/** sha256 hex digest of a string or Buffer. */
export function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex')
}

/** sha256 of a local file's content, or null when the file does not exist. */
export function hashLocalFile(absPath) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex')
  } catch {
    return null
  }
}

/** Decode a file-API payload ({content, encoding}) into a Buffer. */
export function decodeFileContent(content, encoding) {
  if (encoding === 'base64') return Buffer.from(content ?? '', 'base64')
  return Buffer.from(content ?? '', 'utf8')
}

/** A stable, unique id for this CLI process — stamped on every write. */
export function makeOriginClientId() {
  return `cli-${crypto.randomUUID()}`
}

// ---------------------------------------------------------------------------
// Path safety — remote paths are tenant-supplied, so they never escape appDir
// ---------------------------------------------------------------------------

/**
 * Resolve a server-relative posix path to an absolute path guaranteed to live
 * inside appDir. Returns null for absolute paths, drive-letter/UNC paths,
 * traversal (`..`), null bytes, or a path that resolves to appDir itself.
 */
export function safeResolve(appDir, relPath) {
  if (typeof relPath !== 'string' || relPath.length === 0) return null
  if (relPath.includes('\0')) return null
  if (path.posix.isAbsolute(relPath) || path.win32.isAbsolute(relPath)) return null

  const root = path.resolve(appDir)
  const abs = path.resolve(root, relPath)
  const rel = path.relative(root, abs)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null
  return abs
}

// ---------------------------------------------------------------------------
// Echo guard — two layers, so a peer never re-applies its own change
// ---------------------------------------------------------------------------

/**
 * Decide whether to ignore an incoming `sandbox:file-changed` event.
 *   Layer 1: the event carries our own originClientId (we wrote it).
 *   Layer 2: the event's sha256 equals the hash we last wrote for that path
 *            (covers servers that don't echo originClientId through the sync
 *            path — the content is already identical on disk anyway).
 *
 * @param event         { path, sha256, originClientId }
 * @param originClientId our own id
 * @param lastWritten    Map<path,sha> | Record<path,sha> — what we last wrote
 * @returns { ignore, reason }
 */
export function shouldIgnoreEvent(event, { originClientId, lastWritten } = {}) {
  if (event?.originClientId && originClientId && event.originClientId === originClientId) {
    return { ignore: true, reason: 'own-origin' }
  }
  const known =
    lastWritten instanceof Map ? lastWritten.get(event?.path) : lastWritten?.[event?.path]
  if (norm(known) !== null && norm(known) === norm(event?.sha256)) {
    return { ignore: true, reason: 'own-hash' }
  }
  return { ignore: false, reason: null }
}

// ---------------------------------------------------------------------------
// Conflict rule — never clobber unsaved local work
// ---------------------------------------------------------------------------

/**
 * Apply a remote edit only when the local file's current hash equals the
 * event's previousSha256 (disk and sandbox agreed before this edit). A missing
 * local file (null) matching a missing previous (null) is a clean create.
 * `forcePull` takes the remote version regardless.
 *
 * @returns 'apply' | 'skip'
 */
export function decideApply({ localSha, previousSha256, forcePull = false } = {}) {
  if (forcePull) return 'apply'
  return norm(localSha) === norm(previousSha256) ? 'apply' : 'skip'
}

// ---------------------------------------------------------------------------
// Atomic write — temp file in the same dir, then rename
// ---------------------------------------------------------------------------

/**
 * Write `buffer` to `absPath` atomically: a temp sibling is written fully and
 * then renamed over the target (an atomic replace on the same filesystem), so
 * a concurrent reader never observes a partial file. The temp name carries the
 * reserved `.veltrix` prefix, so a crash-orphaned temp is never synced.
 */
export function atomicWrite(absPath, buffer) {
  const dir = path.dirname(absPath)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.veltrix-tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`)
  try {
    fs.writeFileSync(tmp, buffer)
    fs.renameSync(tmp, absPath)
  } catch (error) {
    try {
      fs.unlinkSync(tmp)
    } catch {
      // best-effort cleanup
    }
    throw error
  }
}

// ---------------------------------------------------------------------------
// Reconciliation — hash-diff the sandbox file list against local disk
// ---------------------------------------------------------------------------

function toShaMap(entries) {
  const map = new Map()
  for (const entry of entries ?? []) map.set(entry.path, entry.sha256)
  return map
}

/**
 * Compute the changes to apply on (re)connect. A local file that still equals
 * its `baseline` sha (what we last wrote/synced) is "unmodified" and safe to
 * overwrite or remove from the remote; a local file that has drifted from its
 * baseline is a conflict and is left untouched. `forcePull` takes the remote
 * side for every difference.
 *
 * @param localEntries  [{path, sha256}]  — the current local manifest
 * @param remoteEntries [{path, sha256}]  — the sandbox's file list
 * @param baseline      Map<path,sha> | Record<path,sha> — last-written hashes
 * @returns { pull:[{path,sha256}], conflict:[{path,reason}], remove:[{path}] }
 */
export function reconcile({ localEntries, remoteEntries, baseline, forcePull = false } = {}) {
  const localMap = toShaMap(localEntries)
  const remoteMap = toShaMap(remoteEntries)
  const baseMap = baseline instanceof Map ? baseline : new Map(Object.entries(baseline ?? {}))

  const pull = []
  const conflict = []
  const remove = []

  // Remote additions / changes.
  for (const [p, remoteSha] of remoteMap) {
    const localSha = localMap.has(p) ? localMap.get(p) : null
    if (localSha === remoteSha) continue // already in sync

    if (forcePull) {
      pull.push({ path: p, sha256: remoteSha })
      continue
    }
    const baseSha = baseMap.has(p) ? baseMap.get(p) : null
    if (localSha === null || localSha === baseSha) pull.push({ path: p, sha256: remoteSha })
    else conflict.push({ path: p, reason: 'local-modified' })
  }

  // Remote deletions: paths we previously synced that vanished from the
  // sandbox. Only remove ones the developer has not since edited.
  for (const [p, baseSha] of baseMap) {
    if (remoteMap.has(p)) continue
    const localSha = localMap.has(p) ? localMap.get(p) : null
    if (localSha === null) continue // already gone locally

    if (forcePull || localSha === baseSha) remove.push({ path: p })
    else conflict.push({ path: p, reason: 'remote-deleted-local-modified' })
  }

  return { pull, conflict, remove }
}
