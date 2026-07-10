// ============================================================================
// Sandbox sync engine — the pure heart of `veltrix dev`.
//
// Protocol (server: /api/sandboxes/:id/sync/*):
//   1. Build a manifest of the local app dir: [{path, sha256, size}] with
//      posix-style relative paths.
//   2. POST the FULL manifest; the server diffs it against its stored state
//      and answers {upload, delete}. Files omitted from the manifest are
//      deleted server-side at manifest time, so renames/deletes need no
//      special client handling.
//   3. tar.gz EXACTLY the requested upload paths and PUT the archive.
//
// Exclusions: node_modules, .git, dist and .veltrix* are always skipped
// (the server reserves .veltrix* names for its own state). A .veltrixignore
// file at the app root adds gitignore-style rules: comments (#), negation
// (!), directory-only (trailing /), root-anchored (leading / or an inner
// slash), and the *, **, ? globs. The last matching rule wins.
//
// Everything except createTarball is synchronous and side-effect free on
// the inputs, so the unit tests in cli/test/ exercise it directly.
// ============================================================================

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import * as tar from 'tar'

export const IGNORE_FILENAME = '.veltrixignore'

/** Basenames that are never synced, at any depth. */
export function isDefaultExcluded(basename) {
  return (
    basename === 'node_modules' ||
    basename === '.git' ||
    basename === 'dist' ||
    basename.startsWith('.veltrix') // reserved server-side (sync state etc.)
  )
}

export function toPosix(p) {
  return String(p).replace(/\\/g, '/')
}

// ---------------------------------------------------------------------------
// .veltrixignore — gitignore-style rules
// ---------------------------------------------------------------------------

/** Convert one glob pattern (already split from its flags) into a RegExp. */
function globToRegex(pattern, anchored) {
  const segments = pattern.split('/')
  const parts = []

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]
    if (segment === '**') {
      // `**` spans any number of path segments (including none).
      parts.push(i === segments.length - 1 ? '.*' : '(?:[^/]+/)*')
      continue
    }
    let converted = ''
    for (const char of segment) {
      if (char === '*') converted += '[^/]*'
      else if (char === '?') converted += '[^/]'
      else converted += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
    parts.push(converted + (i < segments.length - 1 ? '/' : ''))
  }

  const body = parts.join('')
  // Anchored patterns match from the app root; bare names match at any depth.
  return anchored ? new RegExp(`^${body}$`) : new RegExp(`(^|/)${body}$`)
}

/**
 * Parse .veltrixignore content into rules usable by isIgnored().
 * Returns [{ regex, negated, dirOnly, pattern }].
 */
export function parseIgnoreRules(content) {
  const rules = []
  for (const rawLine of String(content).split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue

    let pattern = line
    let negated = false
    if (pattern.startsWith('!')) {
      negated = true
      pattern = pattern.slice(1)
    }
    if (pattern.startsWith('\\#') || pattern.startsWith('\\!')) {
      pattern = pattern.slice(1)
    }

    let dirOnly = false
    if (pattern.endsWith('/')) {
      dirOnly = true
      pattern = pattern.slice(0, -1)
    }

    // gitignore semantics: a slash anywhere (after stripping the trailing
    // one) anchors the pattern to the app root.
    const anchored = pattern.includes('/')
    if (pattern.startsWith('/')) pattern = pattern.slice(1)
    if (!pattern) continue

    rules.push({ regex: globToRegex(pattern, anchored), negated, dirOnly, pattern })
  }
  return rules
}

/** Load .veltrixignore rules from an app directory (empty when absent). */
export function loadIgnoreRules(appDir) {
  const ignorePath = path.join(appDir, IGNORE_FILENAME)
  try {
    return parseIgnoreRules(fs.readFileSync(ignorePath, 'utf8'))
  } catch {
    return []
  }
}

function ruleMatches(relPath, isDir, rule) {
  // Match on the path itself (directory-only rules need a directory) …
  if (rule.regex.test(relPath)) return isDir || !rule.dirOnly
  // … or on any ancestor directory (an ignored dir ignores its contents).
  const segments = relPath.split('/')
  for (let i = 1; i < segments.length; i++) {
    if (rule.regex.test(segments.slice(0, i).join('/'))) return true
  }
  return false
}

/**
 * Apply ignore rules to a posix-style relative path.
 * The last matching rule wins (so `!keep.log` can re-include).
 */
export function isIgnored(relPath, rules, isDir = false) {
  let ignored = false
  for (const rule of rules) {
    if (ruleMatches(relPath, isDir, rule)) ignored = !rule.negated
  }
  return ignored
}

// ---------------------------------------------------------------------------
// Walk + hash + manifest
// ---------------------------------------------------------------------------

/** sha256 hex digest of a file's content. */
export function hashFile(absPath) {
  return crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex')
}

/**
 * Recursively list the app files eligible for sync, applying the default
 * excludes and .veltrixignore rules. Symlinks are followed (their target
 * content is what gets synced — the server rejects link tar entries).
 * Returns [{ path (posix, relative), absPath, size }] in a deterministic
 * order.
 */
export function walkAppDir(appDir, rules = []) {
  const root = path.resolve(appDir)
  const files = []

  const walk = (dir) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

    for (const entry of entries) {
      if (isDefaultExcluded(entry.name)) continue

      const abs = path.join(dir, entry.name)
      const rel = toPosix(path.relative(root, abs))

      let stat
      try {
        stat = fs.statSync(abs) // follows symlinks; throws on dangling links
      } catch {
        continue
      }

      if (stat.isDirectory()) {
        if (isIgnored(rel, rules, true)) continue
        walk(abs)
      } else if (stat.isFile()) {
        if (isIgnored(rel, rules, false)) continue
        files.push({ path: rel, absPath: abs, size: stat.size })
      }
    }
  }

  walk(root)
  return files
}

/** Build the sync manifest the server expects: [{path, sha256, size}]. */
export function buildManifest(appDir, rules = []) {
  return walkAppDir(appDir, rules).map((file) => ({
    path: file.path,
    sha256: hashFile(file.absPath),
    size: file.size,
  }))
}

// ---------------------------------------------------------------------------
// Diff application
// ---------------------------------------------------------------------------

/**
 * Apply the server's {upload} answer to the local manifest: which entries
 * to archive, and which requested paths no longer exist locally (a file
 * changed between the walk and the diff — the caller should rebuild the
 * manifest and retry).
 */
export function selectUploadEntries(entries, uploadPaths) {
  const byPath = new Map(entries.map((entry) => [entry.path, entry]))
  const selected = []
  const missing = []
  for (const uploadPath of uploadPaths) {
    const entry = byPath.get(uploadPath)
    if (entry) selected.push(entry)
    else missing.push(uploadPath)
  }
  return { selected, missing }
}

/**
 * Local diff of two manifests (previous → current). The server computes
 * the authoritative diff; this powers offline summaries and tests.
 */
export function diffManifests(previousEntries, currentEntries) {
  const previous = new Map(previousEntries.map((entry) => [entry.path, entry]))
  const current = new Map(currentEntries.map((entry) => [entry.path, entry]))

  const changed = []
  for (const [entryPath, entry] of current) {
    const before = previous.get(entryPath)
    if (!before || before.sha256 !== entry.sha256) changed.push(entryPath)
  }

  const removed = []
  for (const entryPath of previous.keys()) {
    if (!current.has(entryPath)) removed.push(entryPath)
  }

  return { changed, removed }
}

// ---------------------------------------------------------------------------
// Archive
// ---------------------------------------------------------------------------

/**
 * tar.gz exactly the given posix-relative paths from the app directory into
 * an in-memory Buffer (sandboxes are capped at 20 MB, so buffering is fine).
 * `portable` + `follow` keep entries platform-neutral and dereference
 * symlinks (the server rejects link entries).
 */
export async function createTarball(appDir, paths) {
  const stream = tar.create({ gzip: true, cwd: appDir, portable: true, follow: true }, paths)
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return Buffer.concat(chunks)
}
