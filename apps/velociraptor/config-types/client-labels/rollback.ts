import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildClient, vqlTimeoutMs, labelSetVQL, labelRemoveVQL } from './_shared'
import type { LabelRollbackEntry } from './deploy'

/**
 * Undo a client-labels deploy from rollbackData.previous (written by deploy()) by
 * REVERSING the applied delta per label:
 *   - each client id the deploy ADDED the label to has it removed again,
 *   - each client id the deploy REMOVED the label from has it added back,
 * restoring exactly the prior membership without re-reading live state. Applied
 * over the gRPC API (mutual TLS).
 *
 * VERIFY against a live Velociraptor server: label() (see ./_shared.ts).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: LabelRollbackEntry[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for client-labels rollback' }
  }

  const timeoutMs = vqlTimeoutMs(settings)
  let client
  try {
    client = await buildClient(component, credential, connectivity, settings)
  } catch (error) {
    return { success: false, message: `Could not connect to Velociraptor: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }

  let reverted = 0
  try {
    for (const { label, added, removed } of previous) {
      for (const clientId of added) await client.runVQL(labelRemoveVQL(clientId, label), { timeoutMs })
      for (const clientId of removed) await client.runVQL(labelSetVQL(clientId, label), { timeoutMs })
      reverted++
    }
    return { success: true, message: `Rolled back membership for ${reverted} label(s).` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted} of ${previous.length} label(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  } finally {
    await client.close().catch(() => {})
  }
}
