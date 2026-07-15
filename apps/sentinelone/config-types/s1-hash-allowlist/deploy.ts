import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildS1Client,
  MISSING_SCOPE_MESSAGE,
  s1ErrorMessage,
  s1Result,
  type S1Client,
} from '../../lib/s1'
import { extractHashSpecs, hashKey, type HashSpec, type LiveRestriction } from './validate'

/** SentinelOne restriction type this config type manages. */
export const RESTRICTION_TYPE = 'white_hash'

export interface HashRollbackEntry {
  value: string
  osType: string
  label: string
  existed: boolean
  id?: string
}

/**
 * Deploy SentinelOne allowlisted hashes via the Management API (scope-filtered
 * collection of /restrictions, type white_hash).
 *
 * Identity is the (SHA1, osType) natural key at the configured scope. Restrictions
 * have no update operation, so deploy is purely additive: list /restrictions
 * (type white_hash), match on the key, and POST a new entry only when it is
 * missing (capturing the created id). Entries that already exist are left as-is
 * and never deleted — deploy only removes what it created, during rollback.
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

  const specs = extractHashSpecs(ctx.canvas).filter((s) => s.sha1 && s.osType)
  const rollbackState: HashRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    const existing = await listRestrictions(client)
    const byKey = new Map(
      existing
        .filter((e) => e.value && e.osType)
        .map((e) => [hashKey({ sha1: e.value as string, osType: e.osType as string }), e]),
    )

    for (const spec of specs) {
      const label = `${spec.sha1} (${spec.osType})`
      const key = hashKey(spec)
      const live = byKey.get(key)

      if (live && live.id) {
        // Already present — restrictions have no update, so this is a no-op.
        rollbackState.push({ value: spec.sha1, osType: spec.osType, label, existed: true, id: live.id })
      } else {
        const res = await client.request('POST', '/restrictions', { body: { filter, data: buildData(spec) } })
        if (!res.ok) throw new Error(`Failed to create allowlisted hash "${label}": ${s1ErrorMessage(res)}`)
        const created = firstResult(s1Result<LiveRestriction | LiveRestriction[]>(res))
        if (!created?.id) throw new Error(`Allowlisted hash "${label}" was created but the API returned no id`)
        rollbackState.push({ value: spec.sha1, osType: spec.osType, label, existed: false, id: created.id })
        createdIds.push(created.id)
      }
      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} allowlisted hash(es) to ${consoleUrl} (${client.currentScope} scope): ${deployed.join(', ')}`,
      artifacts: { consoleUrl, deployedHashes: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Hash allowlist deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { consoleUrl, deployedHashes: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/** List all allowlisted hashes at the configured scope; throws on a non-OK response. */
export async function listRestrictions(client: S1Client): Promise<LiveRestriction[]> {
  const sq = client.scopeQuery()
  if (sq.error || !sq.query) throw new Error(sq.error ?? 'scope not configured')
  const res = await client.getAll<LiveRestriction>('/restrictions', { ...sq.query, type: RESTRICTION_TYPE })
  if (!res.ok) {
    throw new Error(`Failed to list hash restrictions: ${s1ErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  }
  return res.items
}

/** POST /restrictions may return the created object or an array; normalize to the first. */
function firstResult(result: LiveRestriction | LiveRestriction[] | null): LiveRestriction | null {
  if (!result) return null
  return Array.isArray(result) ? result[0] ?? null : result
}

function buildData(spec: HashSpec): Record<string, unknown> {
  return {
    value: spec.sha1,
    sha256Value: spec.sha256 ?? '',
    osType: spec.osType,
    type: RESTRICTION_TYPE,
    source: '',
    description: spec.description ?? '',
  }
}
