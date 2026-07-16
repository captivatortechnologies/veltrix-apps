import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildInsightVMClient,
  insightVMErrorMessage,
  parseJson,
  type InsightVMClient,
} from '../../lib/insightvm'
import { extractPoolSpecs, poolKey, type LiveEngine, type LivePool, type PoolSpec } from './validate'

export interface PoolRollbackEntry {
  key: string
  label: string
  existed: boolean
  id?: number
  prior?: LivePool
}

/**
 * Deploy Rapid7 InsightVM scan engine pools via the Console API.
 *
 * Identity is the pool name. Member engines are declared by NAME, so the handler
 * first lists /scan_engines to resolve each name to its live id (an unknown name
 * fails the deploy). Then it lists /scan_engine_pools, matches by name, and PUTs
 * an existing pool by id or POSTs a new one with { name, engines: [ids] }.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildInsightVMClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, consoleUrl } = built

  const specs = extractPoolSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: PoolRollbackEntry[] = []
  const createdIds: number[] = []
  const deployed: string[] = []

  try {
    // Resolve scan-engine names → ids once, up front. A pool that references an
    // unknown engine name must fail before any write happens.
    const engineIdByName = await listEngineIdsByName(client)

    const existing = await listPools(client)
    const byKey = new Map(
      existing.filter((p) => p.name).map((p) => [poolKey({ name: p.name as string }), p]),
    )

    for (const spec of specs) {
      const label = spec.name
      const key = poolKey(spec)
      const engineIds = resolveEngineIds(spec, engineIdByName)
      const live = byKey.get(key)

      if (live && live.id != null) {
        rollbackState.push({ key, label, existed: true, id: live.id, prior: live })
        const res = await client.request('PUT', `/scan_engine_pools/${live.id}`, { body: buildBody(spec, engineIds) })
        if (!res.ok) throw new Error(`Failed to update scan engine pool "${label}": ${insightVMErrorMessage(res)}`)
      } else {
        const res = await client.request('POST', '/scan_engine_pools', { body: buildBody(spec, engineIds) })
        if (!res.ok) throw new Error(`Failed to create scan engine pool "${label}": ${insightVMErrorMessage(res)}`)
        const created = parseJson<{ id?: number }>(res.body)
        if (created?.id == null) throw new Error(`Scan engine pool "${label}" was created but the API returned no id`)
        rollbackState.push({ key, label, existed: false, id: created.id })
        createdIds.push(created.id)
      }
      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} scan engine pool(s) to ${consoleUrl}: ${deployed.join(', ')}`,
      artifacts: { consoleUrl, deployedPools: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Scan engine pool deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { consoleUrl, deployedPools: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/** List all scan engine pools; throws on a non-OK response. */
export async function listPools(client: InsightVMClient): Promise<LivePool[]> {
  const res = await client.getAll<LivePool>('/scan_engine_pools')
  if (!res.ok) {
    throw new Error(
      `Failed to list scan engine pools: ${insightVMErrorMessage({ status: res.status, ok: false, body: res.body })}`,
    )
  }
  return res.items
}

/** List all scan engines and index their ids by (lowercased) name; throws on a non-OK response. */
export async function listEngineIdsByName(client: InsightVMClient): Promise<Map<string, number>> {
  const res = await client.getAll<LiveEngine>('/scan_engines')
  if (!res.ok) {
    throw new Error(
      `Failed to list scan engines: ${insightVMErrorMessage({ status: res.status, ok: false, body: res.body })}`,
    )
  }
  const byName = new Map<string, number>()
  for (const engine of res.items) {
    if (engine.name && engine.id != null) byName.set(engine.name.trim().toLowerCase(), engine.id)
  }
  return byName
}

/** Map a pool's declared engine names to their live ids; throw on any unknown name. */
export function resolveEngineIds(spec: PoolSpec, engineIdByName: Map<string, number>): number[] {
  const ids: number[] = []
  for (const name of spec.engines) {
    const id = engineIdByName.get(name.toLowerCase())
    if (id == null) {
      throw new Error(`Scan engine "${name}" (referenced by pool "${spec.name}") was not found on the console`)
    }
    ids.push(id)
  }
  return ids
}

function buildBody(spec: PoolSpec, engineIds: number[]): Record<string, unknown> {
  return { name: spec.name, engines: engineIds }
}
