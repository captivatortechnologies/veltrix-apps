import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildVaultClient,
  parseJson,
  vaultErrorMessage,
  type VaultClient,
} from '../../lib/vault'
import {
  extractLeaseCountQuotaSpecs,
  type LeaseCountQuotaSpec,
  type LiveLeaseCountQuota,
} from './validate'

export interface LeaseCountQuotaRollbackEntry {
  name: string
  /** false = deploy CREATED this quota (rollback DELETES it). */
  existed: boolean
  /** The authored scope path for this quota; "" means it is the GLOBAL limiter. */
  path: string
  /** Prior quota fields captured before deploy overwrote an existing quota (update branch). */
  prior?: {
    max_leases?: number
    path?: string
    role?: string
    inheritable?: boolean
  }
}

/**
 * Deploy Vault lease count quotas via the /sys/quotas/lease-count API
 * (Enterprise only). A quota's identity is its NAME and the write is a
 * name-in-path UPSERT: POST /sys/quotas/lease-count/{name} creates the quota if
 * absent and overwrites it if present. For each declared quota:
 *
 *   1. GET first to capture rollback state (absent → created; present → prior).
 *   2. POST to converge to the authored { max_leases, path, role, inheritable }.
 *
 * A quota whose `path` is EMPTY is the GLOBAL limiter for the entire cluster —
 * it caps concurrent leases for every mount. Deploy surfaces that in the result
 * so an operator is not surprised by a cluster-wide limiter appearing.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildVaultClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractLeaseCountQuotaSpecs(ctx.canvas).filter(
    (s) => s.name && Number.isInteger(s.maxLeases) && s.maxLeases > 0,
  )
  const rollbackState: LeaseCountQuotaRollbackEntry[] = []
  const createdNames: string[] = []
  const deployed: string[] = []
  const globalWarnings: string[] = []

  try {
    for (const spec of specs) {
      // GET first: an UPSERT overwrites in place, so capture whether the quota
      // already existed (and, if so, its prior fields) for rollback.
      const live = await getLeaseCountQuota(client, spec.name)

      if (!live) {
        rollbackState.push({ name: spec.name, existed: false, path: spec.path })
        createdNames.push(spec.name)
      } else {
        rollbackState.push({
          name: spec.name,
          existed: true,
          path: spec.path,
          prior: {
            max_leases: typeof live.max_leases === 'number' ? live.max_leases : undefined,
            path: typeof live.path === 'string' ? live.path : undefined,
            role: typeof live.role === 'string' ? live.role : undefined,
            inheritable: typeof live.inheritable === 'boolean' ? live.inheritable : undefined,
          },
        })
      }

      const res = await client.request('POST', `/sys/quotas/lease-count/${spec.name}`, {
        body: buildQuotaBody(spec),
      })
      if (!res.ok) {
        if (res.status === 404) {
          throw new Error(
            `Failed to apply lease count quota "${spec.name}": lease count quotas are a Vault ` +
              `Enterprise feature and this cluster returned 404 — confirm the cluster is running ` +
              `Vault Enterprise (${vaultErrorMessage(res)})`,
          )
        }
        throw new Error(`Failed to apply lease count quota "${spec.name}": ${vaultErrorMessage(res)}`)
      }

      // An empty path is the global limiter — call it out for the operator.
      if (spec.path === '') {
        globalWarnings.push(
          `quota "${spec.name}" has an empty path and is the GLOBAL lease count limiter — it caps concurrent leases for every mount in Vault`,
        )
      }

      deployed.push(spec.name)
    }

    const warnSuffix = globalWarnings.length ? ` WARNING: ${globalWarnings.join('; ')}.` : ''
    return {
      success: true,
      message: `Deployed ${deployed.length} lease count quota(s) to Vault at ${baseUrl}: ${deployed.join(', ')}.${warnSuffix}`,
      artifacts: { baseUrl, deployedQuotas: deployed, createdQuotas: createdNames },
      rollbackData: { previousState: rollbackState, createdNames },
    }
  } catch (error) {
    return {
      success: false,
      message: `Lease count quota deployment failed after ${deployed.length} of ${specs.length} quota(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedQuotas: deployed, createdQuotas: createdNames },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState, createdNames },
    }
  }
}

// --- Helpers ---

/** Read a quota by name via GET /sys/quotas/lease-count/{name}; null on 404 (absent). */
export async function getLeaseCountQuota(client: VaultClient, name: string): Promise<LiveLeaseCountQuota | null> {
  const res = await client.request('GET', `/sys/quotas/lease-count/${name}`)
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`Failed to read lease count quota "${name}": ${vaultErrorMessage(res)}`)
  }
  const parsed = parseJson<{ data?: LiveLeaseCountQuota } & LiveLeaseCountQuota>(res.body)
  return parsed?.data ?? parsed ?? null
}

/** Build the POST /sys/quotas/lease-count/{name} body used to UPSERT a quota. */
function buildQuotaBody(spec: LeaseCountQuotaSpec): Record<string, unknown> {
  // max_leases is required; path is ALWAYS sent (including "") because an empty
  // path is the deliberate global-limiter choice and must converge, not be left
  // alone. inheritable is always sent so clearing it on the canvas converges too.
  const body: Record<string, unknown> = {
    max_leases: spec.maxLeases,
    path: spec.path,
    inheritable: spec.inheritable,
  }
  if (spec.role !== undefined) body.role = spec.role
  return body
}
