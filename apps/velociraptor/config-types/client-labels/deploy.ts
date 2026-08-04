import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { splitList, asBool } from '../../lib/velociraptorApi'
import { buildClient, vqlTimeoutMs, liveClientIdsForLabel, diffIds, labelSetVQL, labelRemoveVQL } from './_shared'

/** Per-label reconcile record: which client ids this deploy added/removed. */
export interface LabelRollbackEntry {
  label: string
  /** Client ids the label was ADDED to by this deploy (rollback removes it). */
  added: string[]
  /** Client ids the label was REMOVED from by this deploy (rollback re-adds it). */
  removed: string[]
}

/**
 * Deploy Velociraptor client labels over the gRPC API (mutual TLS):
 *   read (per label):  SELECT client_id FROM clients(search='label:<label>') — live members
 *   reconcile:         SELECT label(client_id=, labels=[<label>], op='set'|'remove')
 *
 * Each declared label is reconciled to an EXACT membership: client ids in the
 * declared list but not currently labelled get the label added; client ids
 * currently labelled (via a prior deploy of this same label) but no longer
 * declared get it removed. A disabled label reconciles to an empty desired set
 * (every current member is removed). rollbackData records the exact add/remove
 * delta per label so rollback can reverse it symmetrically, without re-reading
 * live state.
 *
 * VERIFY against a live Velociraptor server: label() / clients(search=) (see ./_shared.ts).
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for client-labels deployment' }
  }

  const timeoutMs = vqlTimeoutMs(settings)
  let client
  try {
    client = await buildClient(component, credential, connectivity, settings)
  } catch (error) {
    return { success: false, message: `Could not connect to Velociraptor: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }

  const previous: LabelRollbackEntry[] = []
  const applied: string[] = []
  try {
    for (const item of items) {
      const label = String(item.fields.label ?? '').trim()
      if (!label) continue
      const enabled = asBool(item.fields.enabled, true)
      const desiredIds = enabled ? splitList(item.fields.clientIds) : []

      const liveIds = await liveClientIdsForLabel(client, label, timeoutMs)
      const toAdd = diffIds(desiredIds, liveIds)
      const toRemove = diffIds(liveIds, desiredIds)

      for (const clientId of toAdd) await client.runVQL(labelSetVQL(clientId, label), { timeoutMs })
      for (const clientId of toRemove) await client.runVQL(labelRemoveVQL(clientId, label), { timeoutMs })

      previous.push({ label, added: toAdd, removed: toRemove })
      applied.push(`${label} (+${toAdd.length}/-${toRemove.length})`)
    }

    return {
      success: true,
      message: `Reconciled ${previous.length} label(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Client-labels deploy failed after ${previous.length} of ${items.length} label(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } finally {
    await client.close().catch(() => {})
  }
}
