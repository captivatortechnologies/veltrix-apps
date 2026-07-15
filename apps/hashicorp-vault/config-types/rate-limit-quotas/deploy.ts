import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildVaultClient,
  parseJson,
  vaultErrorMessage,
  type VaultClient,
} from '../../lib/vault'
import {
  extractQuotaSpecs,
  type LiveQuota,
  type QuotaSpec,
} from './validate'

export interface QuotaRollbackEntry {
  name: string
  /** false = deploy CREATED this quota (rollback DELETES it). */
  existed: boolean
  /** The authored scope path for this quota; "" means it is the GLOBAL limiter. */
  path: string
  /** Prior quota fields captured before deploy overwrote an existing quota (update branch). */
  prior?: {
    rate?: number
    path?: string
    interval?: number
    block_interval?: number
    role?: string
  }
}

/**
 * Deploy Vault rate limit quotas via the /sys/quotas/rate-limit API. A quota's
 * identity is its NAME (the {name} in the path) and the write is a name-in-path
 * UPSERT: POST /sys/quotas/rate-limit/{name} creates the quota if absent and
 * overwrites it if present. For each declared quota:
 *
 *   1. GET first to capture rollback state (absent → created; present → prior).
 *   2. POST to converge to the authored { rate, path, interval, block_interval, role }.
 *
 * A quota whose `path` is EMPTY is the GLOBAL limiter for the entire cluster —
 * it throttles every request to Vault. Deploy surfaces that in the result so an
 * operator is not surprised by a cluster-wide limiter appearing.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildVaultClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractQuotaSpecs(ctx.canvas).filter((s) => s.name && Number.isFinite(s.rate) && s.rate > 0)
  const rollbackState: QuotaRollbackEntry[] = []
  const createdNames: string[] = []
  const deployed: string[] = []
  const globalWarnings: string[] = []

  try {
    for (const spec of specs) {
      // GET first: an UPSERT overwrites in place, so capture whether the quota
      // already existed (and, if so, its prior fields) for rollback.
      const live = await getQuota(client, spec.name)

      if (!live) {
        rollbackState.push({ name: spec.name, existed: false, path: spec.path })
        createdNames.push(spec.name)
      } else {
        rollbackState.push({
          name: spec.name,
          existed: true,
          path: spec.path,
          prior: {
            rate: typeof live.rate === 'number' ? live.rate : undefined,
            path: typeof live.path === 'string' ? live.path : undefined,
            interval: typeof live.interval === 'number' ? live.interval : undefined,
            block_interval: typeof live.block_interval === 'number' ? live.block_interval : undefined,
            role: typeof live.role === 'string' ? live.role : undefined,
          },
        })
      }

      const res = await client.request('POST', `/sys/quotas/rate-limit/${spec.name}`, {
        body: buildQuotaBody(spec),
      })
      if (!res.ok) {
        throw new Error(`Failed to apply rate limit quota "${spec.name}": ${vaultErrorMessage(res)}`)
      }

      // An empty path is the global limiter — call it out for the operator.
      if (spec.path === '') {
        globalWarnings.push(
          `quota "${spec.name}" has an empty path and is the GLOBAL rate limiter — it throttles every request to Vault`,
        )
      }

      deployed.push(spec.name)
    }

    const warnSuffix = globalWarnings.length ? ` WARNING: ${globalWarnings.join('; ')}.` : ''
    return {
      success: true,
      message: `Deployed ${deployed.length} rate limit quota(s) to Vault at ${baseUrl}: ${deployed.join(', ')}.${warnSuffix}`,
      artifacts: { baseUrl, deployedQuotas: deployed, createdQuotas: createdNames },
      rollbackData: { previousState: rollbackState, createdNames },
    }
  } catch (error) {
    return {
      success: false,
      message: `Rate limit quota deployment failed after ${deployed.length} of ${specs.length} quota(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedQuotas: deployed, createdQuotas: createdNames },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState, createdNames },
    }
  }
}

// --- Helpers ---

/** Read a quota by name via GET /sys/quotas/rate-limit/{name}; null on 404 (absent). */
export async function getQuota(client: VaultClient, name: string): Promise<LiveQuota | null> {
  const res = await client.request('GET', `/sys/quotas/rate-limit/${name}`)
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`Failed to read rate limit quota "${name}": ${vaultErrorMessage(res)}`)
  }
  const parsed = parseJson<{ data?: LiveQuota } & LiveQuota>(res.body)
  return parsed?.data ?? parsed ?? null
}

/** Build the POST /sys/quotas/rate-limit/{name} body used to UPSERT a quota. */
function buildQuotaBody(spec: QuotaSpec): Record<string, unknown> {
  // rate is required; path is ALWAYS sent (including "") because an empty path is
  // the deliberate global-limiter choice and must converge, not be left alone.
  const body: Record<string, unknown> = { rate: spec.rate, path: spec.path }
  if (spec.interval !== undefined) body.interval = spec.interval
  if (spec.blockInterval !== undefined) body.block_interval = spec.blockInterval
  if (spec.role !== undefined) body.role = spec.role
  return body
}
