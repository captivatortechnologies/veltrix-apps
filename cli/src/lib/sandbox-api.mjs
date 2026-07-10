// ============================================================================
// Sandbox API — thin wrappers over /api/sandboxes plus error decoration.
//
// Server contract (platform module/sandbox):
//   POST   /api/sandboxes                     {name, appId}        → sandbox
//   GET    /api/sandboxes                                          → sandbox[]
//   GET    /api/sandboxes/:id                                      → sandbox
//   DELETE /api/sandboxes/:id                                      → {message}
//   GET    /api/sandboxes/:id/files           ?limit&offset        → {files, totalCount, ...}
//   GET    /api/sandboxes/:id/file            ?path=<rel>          → {path, sha256, size, content, encoding}
//   POST   /api/sandboxes/:id/sync/manifest   [{path,sha256,size}] → {upload, delete}
//   PUT    /api/sandboxes/:id/sync/files      tar.gz body          → {status, validation, ...}
//   POST   /api/sandboxes/:id/run             {configTypeId, handler} → {ok, result|error, logs, durationMs}
//     (the run endpoint ships with the sandbox runner — older platforms 404)
//
// Auth: `Authorization: ApiKey <key>` with sandbox:read / sandbox:write
// scopes. Every route 404s while the platform's SANDBOX_ENABLED flag is off.
//
// Writers stamp an `X-Veltrix-Origin-Client-Id` header on sync uploads so the
// platform can attribute the resulting `sandbox:file-changed` events and every
// peer (portal + CLI) can ignore its own echoes. Older servers ignore the
// header harmlessly.
// ============================================================================

import { apiRequest, apiUpload, ApiError } from './api.mjs'

const BASE = 'api/sandboxes'
const ORIGIN_HEADER = 'X-Veltrix-Origin-Client-Id'

function originHeaders(originClientId) {
  return originClientId ? { [ORIGIN_HEADER]: originClientId } : {}
}

export async function listSandboxes(profile) {
  return apiRequest(profile, 'GET', BASE)
}

export async function createSandbox(profile, name, appId) {
  return apiRequest(profile, 'POST', BASE, { name, appId })
}

export async function getSandbox(profile, id) {
  return apiRequest(profile, 'GET', `${BASE}/${id}`)
}

export async function deleteSandbox(profile, id) {
  return apiRequest(profile, 'DELETE', `${BASE}/${id}`)
}

export async function postManifest(profile, id, entries, { originClientId } = {}) {
  return apiRequest(profile, 'POST', `${BASE}/${id}/sync/manifest`, entries, originHeaders(originClientId))
}

export async function putFiles(profile, id, tarball, { originClientId } = {}) {
  return apiUpload(profile, 'PUT', `${BASE}/${id}/sync/files`, tarball, 'application/gzip', originHeaders(originClientId))
}

export async function runHandler(profile, id, configTypeId, handler) {
  return apiRequest(profile, 'POST', `${BASE}/${id}/run`, { configTypeId, handler })
}

/** Read one file's current content from the sandbox (reverse-sync pull). */
export async function getSandboxFile(profile, id, relPath) {
  const query = new URLSearchParams({ path: relPath }).toString()
  return apiRequest(profile, 'GET', `${BASE}/${id}/file?${query}`)
}

/** One page of the sandbox's synced file list: {files, totalCount, ...}. */
export async function listSandboxFilesPage(profile, id, { limit, offset } = {}) {
  const query = new URLSearchParams()
  if (limit != null) query.set('limit', String(limit))
  if (offset != null) query.set('offset', String(offset))
  const suffix = query.toString() ? `?${query}` : ''
  return apiRequest(profile, 'GET', `${BASE}/${id}/files${suffix}`)
}

/** Every synced file [{path, sha256, size}], following pagination to the end. */
export async function listAllSandboxFiles(profile, id) {
  const files = []
  const limit = 1000
  for (let offset = 0; ; ) {
    const page = await listSandboxFilesPage(profile, id, { limit, offset })
    const batch = Array.isArray(page.files) ? page.files : []
    files.push(...batch)
    const total = Number.isFinite(page.totalCount) ? page.totalCount : files.length
    offset += batch.length
    if (batch.length === 0 || files.length >= total) break
  }
  return files
}

/** Find a sandbox by its per-tenant unique name. Returns null when absent. */
export async function resolveSandboxByName(profile, name) {
  const sandboxes = await listSandboxes(profile)
  return sandboxes.find((sandbox) => sandbox.name === name) || null
}

/** True when a 404 means "this sandbox is gone" rather than "no sandbox API". */
export function isSandboxMissingError(error) {
  return error instanceof ApiError && error.status === 404 && /sandbox not found/i.test(error.message)
}

/**
 * Attach an actionable `hint` to sandbox API errors. The platform's
 * feature gate answers 404 "Not found" for EVERY sandbox route when
 * SANDBOX_ENABLED is off, which deserves a better message than "Not found".
 */
export function improveSandboxError(error) {
  if (!(error instanceof ApiError)) return error

  switch (error.status) {
    case 404:
      if (!isSandboxMissingError(error)) {
        error.message = 'The sandbox API is not available on this platform (HTTP 404)'
        error.hint =
          'Sandboxes may be disabled (SANDBOX_ENABLED) or not included in your plan — ask your platform admin.'
      }
      break
    case 401:
      error.hint = 'Your API key was rejected — run `veltrix login` again.'
      break
    case 403:
      error.hint =
        'Your API key is missing the sandbox:read / sandbox:write scopes — create a new key in Settings → Keys & Tokens.'
      break
    case 410:
      error.hint = 'This sandbox expired after its idle TTL. Create a fresh one with `veltrix sandbox create`.'
      break
    case 413:
      error.hint = 'Trim the app directory or add rules to .veltrixignore to stay under the sandbox limits.'
      break
    default:
      break
  }
  return error
}
