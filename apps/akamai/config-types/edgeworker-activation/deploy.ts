import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildAkamaiClient, parseJson, type AkamaiClient } from '../../lib/akamaiApi'
import {
  activationsFromResponse,
  activationsPath,
  edgeWorkersFromResponse,
  edgeWorkersPath,
  effectiveVersion,
  findEdgeWorker,
  isInFlight,
  latestForNetwork,
  readActivationFields,
  type EdgeWorker,
} from './_shared'

/**
 * Deploy = TRIGGER an EdgeWorker activation over the EdgeWorkers API v1
 * (EdgeGrid-signed):
 *   resolve EdgeWorker by name: GET  /edgeworkers/v1/ids
 *   read current activations:   GET  /edgeworkers/v1/ids/{id}/activations
 *   activate:                    POST /edgeworkers/v1/ids/{id}/activations   { network, version, note }
 *
 * This is an ACTION, not a desired-state object, so deploy is modelled
 * idempotently: an EdgeWorker already effective at the declared version on
 * the target network is SKIPPED, and one with an activation already in
 * flight (PRESUBMIT/PENDING/IN_PROGRESS/CANCELLING) is left alone rather than
 * re-triggered. `rollbackData.previous` records the prior effective version
 * per target (null when never activated there) AND the version this deploy
 * activated — rollback.ts uses the real deactivation resource this API
 * exposes to genuinely undo it (see rollback.ts).
 */

interface PriorEntry {
  edgeWorkerName: string
  edgeWorkerId: number
  network: string
  priorEffectiveVersion: string | null
  activatedVersion: string | null
  /** 'activated' | 'skipped-active' | 'skipped-pending' */
  outcome: string
}

async function listAllEdgeWorkers(client: AkamaiClient): Promise<EdgeWorker[]> {
  const res = await client.request('GET', edgeWorkersPath)
  if (!res.ok) throw new Error(`GET ${edgeWorkersPath} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
  return edgeWorkersFromResponse(parseJson<unknown>(res.body))
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
    const live = await listAllEdgeWorkers(client)

    for (const item of items) {
      const fields = readActivationFields(item.fields)
      if (!fields.edgeWorkerName) continue

      const edgeWorker = findEdgeWorker(live, fields.edgeWorkerName)
      if (edgeWorker?.edgeWorkerId == null) {
        throw new Error(`EdgeWorker "${fields.edgeWorkerName}" was not found — create it (EdgeWorkers config type) before activating it.`)
      }
      const edgeWorkerId = edgeWorker.edgeWorkerId
      const label = `${fields.edgeWorkerName} → ${fields.network}`

      const actRes = await client.request('GET', activationsPath(edgeWorkerId))
      const activations = actRes.ok ? activationsFromResponse(parseJson<unknown>(actRes.body)) : []
      const priorEffectiveVersion = effectiveVersion(activations, fields.network)

      if (priorEffectiveVersion === fields.version) {
        skippedActive.push(label)
        previous.push({ edgeWorkerName: fields.edgeWorkerName, edgeWorkerId, network: fields.network, priorEffectiveVersion, activatedVersion: null, outcome: 'skipped-active' })
        continue
      }

      const latest = latestForNetwork(activations, fields.network)
      if (latest && isInFlight(latest.status)) {
        skippedPending.push(label)
        previous.push({ edgeWorkerName: fields.edgeWorkerName, edgeWorkerId, network: fields.network, priorEffectiveVersion, activatedVersion: null, outcome: 'skipped-pending' })
        continue
      }

      const body: Record<string, unknown> = { network: fields.network, version: fields.version }
      if (fields.note) body.note = fields.note

      const res = await client.request('POST', activationsPath(edgeWorkerId), { body })
      if (!res.ok) throw new Error(`activate "${label}" (v${fields.version}) → HTTP ${res.status}: ${res.body.slice(0, 300)}`)

      activated.push(label)
      previous.push({ edgeWorkerName: fields.edgeWorkerName, edgeWorkerId, network: fields.network, priorEffectiveVersion, activatedVersion: fields.version, outcome: 'activated' })
    }

    const parts = [`${activated.length} activation(s) triggered${activated.length ? `: ${activated.join(', ')}` : ''}`]
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
      message: `EdgeWorker activation failed after ${activated.length} trigger(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { activated, skippedActive, skippedPending },
      rollbackData: { previous },
    }
  }
}
