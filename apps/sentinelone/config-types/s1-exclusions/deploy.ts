import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildS1Client,
  MISSING_SCOPE_MESSAGE,
  s1ErrorMessage,
  s1Result,
  type S1Client,
} from '../../lib/s1'
import { exclusionKey, extractExclusionSpecs, type ExclusionSpec, type LiveExclusion } from './validate'

export interface ExclusionRollbackEntry {
  key: string
  label: string
  type: string
  existed: boolean
  id?: string
  prior?: LiveExclusion
}

/**
 * Deploy SentinelOne exclusions via the Management API (scope-filtered collection).
 *
 * Identity is the (type, value, osType) natural key at the configured scope: list
 * /exclusions, match on the key, then PUT an existing exclusion by id or POST a
 * new one. Predefined (source != "user") exclusions are protected — never
 * modified. Scope is carried in the request body's `filter`.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildS1Client(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, consoleUrl } = built
  if (!client.hasScope) return { success: false, message: MISSING_SCOPE_MESSAGE }

  const sf = client.scopeFilter()
  if (sf.error || !sf.filter) return { success: false, message: sf.error ?? MISSING_SCOPE_MESSAGE }
  const filter = sf.filter

  const specs = extractExclusionSpecs(ctx.canvas).filter((s) => s.type && s.value && s.osType)
  const rollbackState: ExclusionRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    const existing = await listExclusions(client)
    const byKey = new Map(
      existing
        .filter((e) => e.type && e.value && e.osType)
        .map((e) => [exclusionKey({ type: e.type as string, value: e.value as string, osType: e.osType as string }), e]),
    )

    for (const spec of specs) {
      const label = `${spec.type} ${spec.value} (${spec.osType})`
      const key = exclusionKey(spec)
      const live = byKey.get(key)

      if (live && live.source && live.source !== 'user') {
        throw new Error(`Exclusion "${label}" is predefined (source ${live.source}) and cannot be modified`)
      }

      if (live && live.id) {
        rollbackState.push({ key, label, type: spec.type, existed: true, id: live.id, prior: live })
        const res = await client.request('PUT', '/exclusions', {
          body: { filter, data: { id: live.id, ...buildData(spec) } },
        })
        if (!res.ok) throw new Error(`Failed to update exclusion "${label}": ${s1ErrorMessage(res)}`)
      } else {
        const res = await client.request('POST', '/exclusions', { body: { filter, data: buildData(spec) } })
        if (!res.ok) throw new Error(`Failed to create exclusion "${label}": ${s1ErrorMessage(res)}`)
        const created = firstResult(s1Result<LiveExclusion | LiveExclusion[]>(res))
        if (!created?.id) throw new Error(`Exclusion "${label}" was created but the API returned no id`)
        rollbackState.push({ key, label, type: spec.type, existed: false, id: created.id })
        createdIds.push(created.id)
      }
      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} exclusion(s) to ${consoleUrl} (${client.currentScope} scope): ${deployed.join(', ')}`,
      artifacts: { consoleUrl, deployedExclusions: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Exclusion deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { consoleUrl, deployedExclusions: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/** List all exclusions at the configured scope; throws on a non-OK response. */
export async function listExclusions(client: S1Client): Promise<LiveExclusion[]> {
  const sq = client.scopeQuery()
  if (sq.error || !sq.query) throw new Error(sq.error ?? 'scope not configured')
  const res = await client.getAll<LiveExclusion>('/exclusions', sq.query)
  if (!res.ok) {
    throw new Error(`Failed to list exclusions: ${s1ErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  }
  return res.items
}

/** POST /exclusions may return the created object or an array; normalize to the first. */
function firstResult(result: LiveExclusion | LiveExclusion[] | null): LiveExclusion | null {
  if (!result) return null
  return Array.isArray(result) ? result[0] ?? null : result
}

function buildData(spec: ExclusionSpec): Record<string, unknown> {
  const data: Record<string, unknown> = {
    type: spec.type,
    value: spec.value,
    osType: spec.osType,
    source: 'user',
    actions: ['detect'],
    description: spec.description ?? '',
  }
  if (spec.type === 'path') {
    data.mode = spec.mode
    data.pathExclusionType = spec.pathExclusionType
  }
  return data
}
