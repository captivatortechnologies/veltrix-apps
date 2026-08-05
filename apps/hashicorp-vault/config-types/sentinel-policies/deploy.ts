import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildVaultClient, parseJson, vaultErrorMessage, type VaultClient } from '../../lib/vault'
import { extractSentinelPolicySpecs, sentinelKey, type LiveSentinelPolicy, type SentinelPolicySpec, type SentinelScope } from './validate'

export interface SentinelPolicyRollbackEntry {
  scope: SentinelScope
  /** Lowercased policy name — the stable identity rollback keys on. */
  name: string
  /** Whether the policy already existed before this deploy (update vs create). */
  existed: boolean
  /** The prior policy fields, captured for policies this deploy UPDATED. */
  prior?: {
    policy: string
    enforcementLevel: string
    /** EGP only. */
    paths?: string[]
  }
}

/**
 * Deploy Sentinel (RGP/EGP) policies to a Vault cluster (Enterprise only) via
 * the Policies API.
 *
 * A Sentinel policy is a TRUE UPSERT: `POST /sys/policies/{scope}/{name}` with
 * `{ policy, enforcement_level, paths? }` creates or replaces the policy in a
 * single call — no existence check is required for the write. For each
 * declared policy:
 *   - GET  /sys/policies/{scope}/{name}   — read prior state (404 = absent) to
 *                                            drive rollback (restore-vs-delete)
 *   - POST /sys/policies/{scope}/{name}   — upsert with the authored Sentinel body
 *
 * `paths` is only sent for scope=egp (validate rejects it for rgp).
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildVaultClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractSentinelPolicySpecs(ctx.canvas).filter((s) => s.scope && s.name && s.policy && s.enforcementLevel)
  const rollbackState: SentinelPolicyRollbackEntry[] = []
  const createdKeys: string[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const scope = spec.scope as SentinelScope
      const key = sentinelKey(scope, spec.name)

      const existing = await getSentinelPolicy(client, scope, spec.name)
      if (existing) {
        rollbackState.push({
          scope,
          name: spec.name,
          existed: true,
          prior: {
            policy: typeof existing.policy === 'string' ? existing.policy : '',
            enforcementLevel: typeof existing.enforcement_level === 'string' ? existing.enforcement_level : '',
            paths: scope === 'egp' && Array.isArray(existing.paths) ? existing.paths : undefined,
          },
        })
      } else {
        rollbackState.push({ scope, name: spec.name, existed: false })
        createdKeys.push(key)
      }

      const res = await client.request('POST', `/sys/policies/${scope}/${encodeURIComponent(spec.name)}`, {
        body: buildPolicyBody(spec, scope),
      })
      if (!res.ok) {
        if (res.status === 404) {
          throw new Error(
            `Failed to write Sentinel policy "${key}": Sentinel policies are a Vault Enterprise feature and ` +
              `this cluster returned 404 — confirm the cluster is running Vault Enterprise (${vaultErrorMessage(res)})`,
          )
        }
        throw new Error(`Failed to write Sentinel policy "${key}": ${vaultErrorMessage(res)}`)
      }

      deployed.push(key)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} Sentinel polic(ies) to Vault at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedPolicies: deployed, createdPolicies: createdKeys },
      rollbackData: { previousState: rollbackState, createdKeys },
    }
  } catch (error) {
    return {
      success: false,
      message: `Sentinel policy deployment failed after ${deployed.length} of ${specs.length} polic(ies): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedPolicies: deployed, createdPolicies: createdKeys },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState, createdKeys },
    }
  }
}

// --- Helpers ---

/**
 * Read a single Sentinel policy by (scope, name); null on 404 (absent).
 * Returns the `data` object (`{ name, policy, enforcement_level, paths? }`).
 */
export async function getSentinelPolicy(
  client: VaultClient,
  scope: SentinelScope,
  name: string,
): Promise<LiveSentinelPolicy | null> {
  const res = await client.request('GET', `/sys/policies/${scope}/${encodeURIComponent(name)}`)
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`Failed to read Sentinel policy "${sentinelKey(scope, name)}": ${vaultErrorMessage(res)}`)
  }
  return parseJson<{ data?: LiveSentinelPolicy }>(res.body)?.data ?? null
}

/** Build the POST /sys/policies/{scope}/{name} body. `paths` only for scope=egp. */
function buildPolicyBody(spec: SentinelPolicySpec, scope: SentinelScope): Record<string, unknown> {
  const body: Record<string, unknown> = {
    policy: spec.policy,
    enforcement_level: spec.enforcementLevel,
  }
  if (scope === 'egp') body.paths = spec.paths
  return body
}
