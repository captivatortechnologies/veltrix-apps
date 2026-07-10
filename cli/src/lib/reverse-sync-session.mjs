// ============================================================================
// Reverse-sync session — the live pull half of `veltrix dev`.
//
// Owns the single realtime socket, subscribes to `sandbox:file-changed` (and
// `sandbox:file-deleted` if the platform emits it), and applies portal edits
// to the local workspace under the echo guard + conflict rule from
// reverse-sync.mjs. On every (re)connect it reconciles by hash-diffing the
// sandbox file list against local disk, so edits made while the CLI was
// offline still land.
//
// Applies are serialized through a single promise chain so writes and the
// shared `baseline` hash map never interleave. All terminal output goes
// through semantic callbacks (onApplied / onDeleted / onConflict / …) so the
// command layer owns formatting and color.
//
// Graceful degradation: if the handshake is refused (older platform) OR the
// file API is absent (a 404 from GET /:id/file), `onUnavailable` fires once,
// the session disables itself, and the one-way watcher keeps working.
// ============================================================================

import fs from 'node:fs'
import { ApiError } from './api.mjs'
import { getSandboxFile, listAllSandboxFiles } from './sandbox-api.mjs'
import { connectSandboxSocket } from './sandbox-realtime.mjs'
import {
  atomicWrite,
  decideApply,
  decodeFileContent,
  hashLocalFile,
  reconcile,
  safeResolve,
  sha256Hex,
  shouldIgnoreEvent,
} from './reverse-sync.mjs'

const FILE_CHANGED = 'sandbox:file-changed'
const FILE_DELETED = 'sandbox:file-deleted'
const PASSTHROUGH_EVENTS = ['sandbox:log', 'sandbox:status', 'sandbox:run-result']

/**
 * @param profile  { url, apiKey }
 * @param options  {
 *   sandboxId:         string
 *   appDir:            string
 *   originClientId:    string
 *   baseline:          Map<path,sha>   — shared with the forward loop; the
 *                      hashes we last wrote/synced (echo guard + reconcile base)
 *   forcePull:         boolean         — take the remote side on every conflict
 *   loadLocalManifest: () => [{path, sha256}]   — current local manifest
 *   onApplied:         ({path}) => void
 *   onDeleted:         ({path}) => void
 *   onConflict:        ({path, reason}) => void
 *   onReconcile:       ({pulled, removed, conflicts, why}) => void
 *   onError:           ({message}) => void
 *   onUnavailable:     (reason) => void          — called once
 *   onLog:             (name, payload) => void    — optional --logs passthrough
 * }
 * @returns { close() }
 */
export function startReverseSync(profile, options) {
  const {
    sandboxId,
    appDir,
    originClientId,
    baseline,
    forcePull = false,
    loadLocalManifest,
    onApplied,
    onDeleted,
    onConflict,
    onReconcile,
    onError,
    onUnavailable,
    onLog,
  } = options

  let disabled = false
  let queue = Promise.resolve() // serializes all disk writes + baseline updates

  const disable = (reason) => {
    if (disabled) return
    disabled = true
    onUnavailable?.(reason)
  }

  const enqueue = (task) => {
    queue = queue.then(task).catch(handleError)
    return queue
  }

  const handleError = (error) => {
    if (error instanceof ApiError && error.status === 404) {
      // The file read API isn't on this platform — pull can't work at all.
      disable('file API unavailable')
      return
    }
    onError?.({ message: error?.message || String(error) })
  }

  // ---- apply primitives ---------------------------------------------------

  async function pullFile(relPath, source) {
    const abs = safeResolve(appDir, relPath)
    if (!abs) {
      onError?.({ message: `ignored unsafe remote path: ${relPath}` })
      return false
    }
    const file = await getSandboxFile(profile, sandboxId, relPath)
    const buffer = decodeFileContent(file.content, file.encoding)
    atomicWrite(abs, buffer)
    baseline.set(relPath, sha256Hex(buffer))
    if (source !== 'reconcile') onApplied?.({ path: relPath })
    return true
  }

  function removeFile(relPath, source) {
    const abs = safeResolve(appDir, relPath)
    if (!abs) return false
    try {
      fs.rmSync(abs)
    } catch {
      // already gone — treat as removed
    }
    baseline.delete(relPath)
    if (source !== 'reconcile') onDeleted?.({ path: relPath })
    return true
  }

  // ---- live event handlers ------------------------------------------------

  async function applyRemoteChange(event) {
    if (disabled) return
    // Some servers signal a delete inline on the change event.
    if (event.size === null || event.sha256 === null) {
      return applyRemoteDelete(event)
    }

    if (shouldIgnoreEvent(event, { originClientId, lastWritten: baseline }).ignore) return

    const abs = safeResolve(appDir, event.path)
    if (!abs) {
      onError?.({ message: `ignored unsafe remote path: ${event.path}` })
      return
    }

    const localSha = hashLocalFile(abs)
    if (decideApply({ localSha, previousSha256: event.previousSha256, forcePull }) === 'skip') {
      onConflict?.({ path: event.path, reason: 'local modified' })
      return
    }
    await pullFile(event.path, 'event')
  }

  async function applyRemoteDelete(event) {
    if (disabled) return
    if (event.originClientId && originClientId && event.originClientId === originClientId) return

    const abs = safeResolve(appDir, event.path)
    if (!abs) return
    const localSha = hashLocalFile(abs)
    if (localSha === null) {
      baseline.delete(event.path)
      return // already gone locally
    }
    const baseSha = baseline.has(event.path) ? baseline.get(event.path) : null
    if (!forcePull && localSha !== baseSha) {
      onConflict?.({ path: event.path, reason: 'deleted in sandbox, modified locally' })
      return
    }
    removeFile(event.path, 'event')
  }

  // ---- reconciliation on (re)connect --------------------------------------

  async function reconcileNow(why) {
    if (disabled) return
    let remoteEntries
    try {
      remoteEntries = await listAllSandboxFiles(profile, sandboxId)
    } catch (error) {
      handleError(error)
      return
    }

    const localEntries = loadLocalManifest()
    const plan = reconcile({ localEntries, remoteEntries, baseline, forcePull })

    for (const conflict of plan.conflict) onConflict?.(conflict)

    let pulled = 0
    let removed = 0
    for (const item of plan.pull) {
      // eslint-disable-next-line no-await-in-loop
      const ok = await pullFile(item.path, 'reconcile').catch(handleError)
      if (ok) pulled++
    }
    for (const item of plan.remove) {
      if (removeFile(item.path, 'reconcile')) removed++
    }

    if (pulled > 0 || removed > 0 || plan.conflict.length > 0) {
      onReconcile?.({ pulled, removed, conflicts: plan.conflict.length, why })
    }
  }

  // ---- socket -------------------------------------------------------------

  const socket = connectSandboxSocket(profile, {
    events: [FILE_CHANGED, FILE_DELETED, ...(onLog ? PASSTHROUGH_EVENTS : [])],
    sandboxId,
    onConnected: () => enqueue(() => reconcileNow('connected')),
    onReconnect: () => enqueue(() => reconcileNow('reconnected')),
    onUnavailable: (reason) => disable(reason),
    onEvent: (name, payload) => {
      if (name === FILE_CHANGED) enqueue(() => applyRemoteChange(payload))
      else if (name === FILE_DELETED) enqueue(() => applyRemoteDelete(payload))
      else onLog?.(name, payload)
    },
  })

  return {
    close() {
      socket.close()
    },
  }
}
