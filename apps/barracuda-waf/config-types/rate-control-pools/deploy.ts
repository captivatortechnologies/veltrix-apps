import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildBarracudaClient, barracudaErrorMessage } from '../../lib/barracudaWaf'
import {
  buildRateControlPoolBody,
  extractRateControlPoolSpecs,
  listRateControlPools,
  rateControlPoolKey,
  rateControlPoolPath,
  type LiveRateControlPool,
} from './validate'

export type RateControlPoolRollbackEntry =
  | { action: 'created'; name: string }
  | { action: 'updated'; name: string; prior: LiveRateControlPool }
  | { action: 'deleted'; name: string; prior: LiveRateControlPool }

export interface RateControlPoolsRollbackData {
  entries: RateControlPoolRollbackEntry[]
}

/**
 * Deploy the Application's Rate Control Pools via
 * /applications/{appName}/rate_control/pools/.
 *
 * This config type OWNS the pool set: the canvas is the complete desired
 * list, reconciled by pool name. Existing pools not declared are removed;
 * declared pools not yet present are created (POST); declared pools that
 * already exist are updated (PUT) unconditionally, so any out-of-band edit is
 * corrected. Every touched pool's prior state is captured for rollback.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildBarracudaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl, appName } = built

  const specs = extractRateControlPoolSpecs(ctx.canvas).filter((s) => s.name)
  const rollback: RateControlPoolRollbackEntry[] = []
  let created = 0
  let updated = 0
  let removed = 0

  try {
    const existing = await listRateControlPools(client, appName)
    const byKey = new Map(existing.filter((p) => p.name).map((p) => [rateControlPoolKey(p.name as string), p]))
    const declaredKeys = new Set(specs.map((s) => rateControlPoolKey(s.name)))

    for (const spec of specs) {
      const key = rateControlPoolKey(spec.name)
      const live = byKey.get(key)
      const body = buildRateControlPoolBody(spec)

      if (live) {
        rollback.push({ action: 'updated', name: spec.name, prior: live })
        const res = await client.request('PUT', rateControlPoolPath(client, appName, spec.name), { body })
        if (!res.ok) throw new Error(`Failed to update Rate Control Pool "${spec.name}": ${barracudaErrorMessage(res)}`)
        updated++
      } else {
        const res = await client.request('POST', `${client.appPath(appName)}/rate_control/pools/`, { body })
        if (!res.ok) throw new Error(`Failed to create Rate Control Pool "${spec.name}": ${barracudaErrorMessage(res)}`)
        rollback.push({ action: 'created', name: spec.name })
        created++
      }
    }

    for (const pool of existing) {
      if (!pool.name || declaredKeys.has(rateControlPoolKey(pool.name))) continue
      rollback.push({ action: 'deleted', name: pool.name, prior: pool })
      const res = await client.request('DELETE', rateControlPoolPath(client, appName, pool.name))
      if (res.status !== 404 && !res.ok) {
        throw new Error(`Failed to remove undeclared Rate Control Pool "${pool.name}": ${barracudaErrorMessage(res)}`)
      }
      removed++
    }

    return {
      success: true,
      message: `Deployed Rate Control Pools to Application "${appName}": ${created} created, ${updated} updated, ${removed} removed.`,
      artifacts: { baseUrl, appName, created, updated, removed },
      rollbackData: { entries: rollback } satisfies RateControlPoolsRollbackData,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rate Control Pools deployment failed after ${created + updated} upsert(s), ${removed} removal(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, appName, created, updated, removed },
      rollbackData: { entries: rollback } satisfies RateControlPoolsRollbackData,
    }
  }
}
