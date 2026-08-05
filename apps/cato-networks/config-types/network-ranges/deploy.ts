import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildCatoClient, responseError } from '../../lib/cato'
import { CREATE_GLOBAL_IP_RANGE_BULK, UPDATE_GLOBAL_IP_RANGE_BULK, findGlobalIpRange, globalIpRangesFromList, LIST_GLOBAL_IP_RANGES } from './_shared'
import { buildNetworkRangeBody, extractNetworkRangeSpecs, type NetworkRangeSpec } from './validate'

export interface NetworkRangeRollbackEntry {
  name: string
  existed: boolean
  id?: string
  priorSpec?: NetworkRangeSpec
}

/**
 * Deploy Network Ranges (Global IP Range objects) via the BULK create/update
 * mutations - one call for every new range, one call for every updated range.
 * Identity is the NAME (no upsert): list globalIpRangeList, match by name,
 * partition into create/update, then call each bulk mutation once. Applies
 * IMMEDIATELY - there is no publish/revision step for this object.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildCatoClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client, accountId } = built

  const specs = extractNetworkRangeSpecs(ctx.canvas).filter((s) => s.name)
  const previousSpecs = ctx.previousConfig ? extractNetworkRangeSpecs(ctx.previousConfig) : []
  const previousByName = new Map(previousSpecs.map((s) => [s.name.trim().toLowerCase(), s]))

  const rollbackState: NetworkRangeRollbackEntry[] = []
  const deployed: string[] = []

  try {
    const listRes = await client.graphql(LIST_GLOBAL_IP_RANGES, { accountId })
    const listErr = responseError(listRes)
    if (listErr) throw new Error(`Failed to list Network Ranges: ${listErr}`)
    const live = globalIpRangesFromList(listRes.data)

    const toCreate: NetworkRangeSpec[] = []
    const toUpdate: Array<{ spec: NetworkRangeSpec; id: string }> = []
    for (const spec of specs) {
      const existing = findGlobalIpRange(live, spec.name)
      if (existing) toUpdate.push({ spec, id: existing.id })
      else toCreate.push(spec)
    }

    if (toUpdate.length > 0) {
      const res = await client.graphql(UPDATE_GLOBAL_IP_RANGE_BULK, {
        accountId,
        input: toUpdate.map(({ spec, id }) => ({ ...buildNetworkRangeBody(spec), id })),
      })
      const err = responseError(res)
      if (err) throw new Error(`Failed to update network range(s): ${err}`)
      for (const { spec, id } of toUpdate) {
        rollbackState.push({ name: spec.name, existed: true, id, priorSpec: previousByName.get(spec.name.trim().toLowerCase()) })
        deployed.push(spec.name)
      }
    }

    if (toCreate.length > 0) {
      const res = await client.graphql(CREATE_GLOBAL_IP_RANGE_BULK, { accountId, input: toCreate.map((spec) => buildNetworkRangeBody(spec)) })
      const err = responseError(res)
      if (err) throw new Error(`Failed to create network range(s): ${err}`)
      const created: Array<{ id?: string; name?: string }> = (res.data as any)?.object?.createGlobalIpRangeBulk?.globalIpRange ?? []
      toCreate.forEach((spec, i) => {
        const id = created[i]?.id
        if (!id) throw new Error(`Network range "${spec.name}" was created but the API returned no id`)
        rollbackState.push({ name: spec.name, existed: false, id })
        deployed.push(spec.name)
      })
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} Network Range(s) on Cato account ${accountId}: ${deployed.join(', ')}`,
      artifacts: { accountId, deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Network Range deployment failed after ${deployed.length} of ${specs.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { accountId, deployed },
      rollbackData: { previousState: rollbackState },
    }
  }
}
