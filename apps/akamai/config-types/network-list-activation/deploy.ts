import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildAkamaiClient, NETWORK_LISTS_PATH, parseJson, type AkamaiClient } from '../../lib/akamaiApi'
import {
  activatePath,
  findList,
  isActiveAt,
  isPending,
  listsFromResponse,
  readActivationFields,
  readStatusOrNull,
  type NetworkList,
} from './_shared'

/**
 * Deploy = TRIGGER a Network List activation over the Network Lists API v2
 * (EdgeGrid-signed):
 *   resolve list by name: GET  /network-list/v2/network-lists
 *   read current status:  GET  /network-list/v2/network-lists/{id}/environments/{env}/status
 *   activate:             POST /network-list/v2/network-lists/{id}/environments/{env}/activate
 *
 * This is an ACTION, not a desired-state object, so deploy is modelled
 * idempotently: a list already ACTIVE at (or beyond) its current syncPoint on
 * the target environment is SKIPPED, and a list with an activation already in
 * flight (PENDING_ACTIVATION / PENDING_DEACTIVATION) is left alone rather than
 * re-triggered. Everything else fires one activation.
 *
 * NOTE: activation is a forward-only action. `rollbackData.previous` records the
 * prior status per target for audit, but rollback() CANNOT un-activate a list —
 * the public Network Lists API v2 exposes no deactivation endpoint (see
 * rollback.ts). Fast activation typically completes in <10 minutes; a triggered
 * activation returns PENDING_ACTIVATION and finishes asynchronously.
 */

interface PriorEntry {
  networkListName: string
  network: string
  uniqueId: string
  /** Status before this deploy fired (null when it had never been activated here). */
  priorStatus: string | null
  priorSyncPoint: number | null
  /** What this deploy did: 'activated' | 'skipped-active' | 'skipped-pending'. */
  outcome: string
}

async function listAll(client: AkamaiClient): Promise<NetworkList[]> {
  const res = await client.request('GET', NETWORK_LISTS_PATH, { query: { includeElements: false } })
  if (!res.ok) throw new Error(`GET ${NETWORK_LISTS_PATH} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
  return listsFromResponse(parseJson<unknown>(res.body))
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  const built = buildAkamaiClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previous: PriorEntry[] = []
  const activated: string[] = []
  const skippedActive: string[] = []
  const skippedPending: string[] = []

  try {
    const live = await listAll(client)

    for (const item of items) {
      const fields = readActivationFields(item.fields)
      if (!fields.networkListName) continue

      const list = findList(live, fields.networkListName)
      if (!list || !list.uniqueId) {
        throw new Error(
          `Network list "${fields.networkListName}" was not found — create and sync it ` +
            '(Network Lists config type) before activating it.',
        )
      }
      const uniqueId = list.uniqueId
      const targetSyncPoint = list.syncPoint ?? 0
      const label = `${fields.networkListName} → ${fields.network}`

      const status = await readStatusOrNull(client, uniqueId, fields.network)

      if (isActiveAt(status, targetSyncPoint)) {
        skippedActive.push(label)
        previous.push({
          networkListName: fields.networkListName,
          network: fields.network,
          uniqueId,
          priorStatus: status?.activationStatus ?? null,
          priorSyncPoint: status?.syncPoint ?? null,
          outcome: 'skipped-active',
        })
        continue
      }

      if (isPending(status)) {
        skippedPending.push(label)
        previous.push({
          networkListName: fields.networkListName,
          network: fields.network,
          uniqueId,
          priorStatus: status?.activationStatus ?? null,
          priorSyncPoint: status?.syncPoint ?? null,
          outcome: 'skipped-pending',
        })
        continue
      }

      const body: Record<string, unknown> = {}
      if (fields.comments) body.comments = fields.comments
      if (fields.recipients.length) body.notificationRecipients = fields.recipients

      const res = await client.request('POST', activatePath(uniqueId, fields.network), { body })
      if (!res.ok) throw new Error(`activate "${label}" → HTTP ${res.status}: ${res.body.slice(0, 300)}`)

      activated.push(label)
      previous.push({
        networkListName: fields.networkListName,
        network: fields.network,
        uniqueId,
        priorStatus: status?.activationStatus ?? null,
        priorSyncPoint: status?.syncPoint ?? null,
        outcome: 'activated',
      })
    }

    const parts = [
      `${activated.length} activation(s) triggered${activated.length ? `: ${activated.join(', ')}` : ''}`,
    ]
    if (skippedActive.length) parts.push(`${skippedActive.length} already active`)
    if (skippedPending.length) parts.push(`${skippedPending.length} in-flight (left alone)`)

    return {
      success: true,
      message: parts.join('; '),
      artifacts: { activated, skippedActive, skippedPending },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Network list activation failed after ${activated.length} trigger(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { activated, skippedActive, skippedPending },
      rollbackData: { previous },
    }
  }
}
