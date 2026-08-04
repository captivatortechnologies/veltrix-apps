import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildClient, vqlTimeoutMs, readServerMetadata, serverSetMetadataVQL, GET_SERVER_METADATA_VQL } from './_shared'

interface PreviousEntry {
  key: string
  existed: boolean
  priorValue: string | null
}

/**
 * Undo a server-metadata deploy from rollbackData.previous (written by deploy()):
 *   - a key this deploy CREATED (existed=false) → removed from the dict
 *   - a key that existed with a known prior value → restored to that value
 * Only the recorded keys are touched — any OTHER key on the server's metadata
 * store (set by Velociraptor itself or another process) is read fresh at
 * rollback time and left untouched, matching deploy()'s upsert-only semantics.
 * Applied over the gRPC API (mutual TLS).
 *
 * VERIFY against a live Velociraptor server: server_metadata() / server_set_metadata().
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: PreviousEntry[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for server-metadata rollback' }
  }

  const timeoutMs = vqlTimeoutMs(settings)
  let client
  try {
    client = await buildClient(component, credential, connectivity, settings)
  } catch (error) {
    return { success: false, message: `Could not connect to Velociraptor: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }

  try {
    let current: Record<string, unknown> = {}
    try {
      current = readServerMetadata(await client.runVQL(GET_SERVER_METADATA_VQL, { timeoutMs }))
    } catch {
      current = {} // best-effort: proceed with an empty base rather than fail rollback outright
    }

    const merged: Record<string, string> = { ...(current as Record<string, string>) }
    let restored = 0
    let removed = 0
    for (const { key, existed, priorValue } of previous) {
      if (existed) {
        merged[key] = priorValue ?? ''
        restored++
      } else {
        delete merged[key]
        removed++
      }
    }

    await client.runVQL(serverSetMetadataVQL(merged), { timeoutMs })
    return { success: true, message: `Rolled back server metadata: ${restored} key(s) restored, ${removed} key(s) removed.` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  } finally {
    await client.close().catch(() => {})
  }
}
