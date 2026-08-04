// Shared helpers for the Recorded Future Fusion Files config type
// (deploy + rollback + drift). Pure + network-free so they can be unit-tested.
//
// Surface: the Recorded Future Fusion Files API — a raw-bytes file store on the
// SAME host and `X-RFToken` auth as the List API, rooted at `<base>/fusion/v3`.
// Confirmed against docs.recordedfuture.com:
//   POST   /fusion/v3/files/{path}            (raw body)  → upload (create or overwrite)
//   GET    /fusion/v3/files/{path}                          → the file's raw bytes
//   HEAD   /fusion/v3/files/{path}                          → ETag (sha256) + Last-Modified, no body
//   DELETE /fusion/v3/files/{path}                          → remove (org files only)
//   Refs: fusion-files-upload, fusion-files-get, fusion-files-stat, fusion-files-delete
//
// `{path}` is the FULL logical path (e.g. /home/acme-corp/watchlists/vendors.csv),
// percent-encoded as one path segment (encodeURIComponent already turns "/" into
// "%2F", matching the documented encoding). Only paths under `/home/` are
// customer-writable — `/public/...` is Recorded Future-managed and read-only
// (confirmed: "public Recorded Future-managed files cannot be deleted"). Whether
// the org segment must be a literal Recorded Future org id or is auto-resolved is
// NOT documented — VERIFY against a live account; this app takes the operator's
// full path as given rather than guessing an org id.

import { createHash } from 'node:crypto'

/** Fusion Files API root, hanging off the same base URL as the List API. */
export const FUSION_API_PREFIX = '/fusion/v3'

/** Only this path prefix is customer-writable; /public/... is read-only. */
export const WRITABLE_PATH_PREFIX = '/home/'

/**
 * Content is treated as text (CSV / JSON / plain-text feed files), matching the
 * canvas `textarea` field this type uses — not an arbitrary-binary file store.
 * Bounds how much prior content a rollback entry may need to retain.
 */
export const MAX_CONTENT_LENGTH = 200_000

export const fusionPaths = {
  file: (path: string) => `${FUSION_API_PREFIX}/files/${encodeURIComponent(path)}`,
} as const

/** Trim a declared path; does not alter case (Fusion paths are case-sensitive). */
export function normalizePath(value: unknown): string {
  return String(value ?? '').trim()
}

/** True when `path` is under the customer-writable /home/ namespace. */
export function isWritablePath(path: string): boolean {
  return path.startsWith(WRITABLE_PATH_PREFIX)
}

/** True when `path` contains a `..` segment (basic traversal hygiene). */
export function hasTraversalSegment(path: string): boolean {
  return path.split('/').some((segment) => segment === '..')
}

/** SHA-256 of declared text content, hex-encoded — comparable to Fusion's ETag. */
export function contentSha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

/** Strip a weak-validator prefix and surrounding quotes from an ETag header value. */
export function normalizeEtag(value: string | null): string {
  if (!value) return ''
  return value.trim().replace(/^W\//, '').replace(/^"|"$/g, '').toLowerCase()
}

/** Human-readable message from a Fusion Files error response. Never throws. */
export function fusionErrorMessage(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: unknown; message?: unknown } | null
    if (parsed && typeof parsed === 'object') {
      if (typeof parsed.message === 'string' && parsed.message) return parsed.message
      if (typeof parsed.error === 'string' && parsed.error) return parsed.error
    }
  } catch {
    // fall through to the raw-body / status fallback below
  }
  const trimmed = (body || '').trim()
  if (trimmed) return trimmed.slice(0, 200)
  return `HTTP ${status}`
}
