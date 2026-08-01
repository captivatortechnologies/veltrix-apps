import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { artifactSetVQL, artifactDeleteVQL } from '../../lib/velociraptorApi'
import { buildClient, vqlTimeoutMs } from './_shared'

/**
 * Undo a custom-artifacts deploy from rollbackData.previous (written by deploy()):
 * for each entry, restore the prior definition via artifact_set(), or — when the
 * artifact was newly created (prior definition null) — remove it via
 * artifact_delete(). Applied over the gRPC API (mutual TLS).
 *
 * VERIFY against a live Velociraptor server: artifact_set() restore + artifact_delete().
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ name: string; definition: string | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for custom-artifact rollback' }
  }

  const timeoutMs = vqlTimeoutMs(settings)
  let client
  try {
    client = await buildClient(component, credential, connectivity, settings)
  } catch (error) {
    return { success: false, message: `Could not connect to Velociraptor: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }

  let restored = 0
  let deleted = 0
  try {
    for (const { name, definition } of previous) {
      if (!name) continue
      if (definition) {
        await client.runVQL(artifactSetVQL(definition), { timeoutMs })
        restored++
      } else {
        await client.runVQL(artifactDeleteVQL(name), { timeoutMs })
        deleted++
      }
    }
    return {
      success: true,
      message: `Rolled back custom artifacts: ${restored} restored, ${deleted} deleted.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  } finally {
    await client.close().catch(() => {})
  }
}
