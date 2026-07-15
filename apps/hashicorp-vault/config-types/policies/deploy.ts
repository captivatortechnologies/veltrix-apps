import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildVaultClient, parseJson, vaultErrorMessage, type VaultClient } from '../../lib/vault'
import { extractPolicySpecs, isRootPolicy, type LivePolicy } from './validate'

export interface PolicyRollbackEntry {
  /** Lowercased policy name — the stable identity rollback keys on. */
  name: string
  /** Whether the policy already existed before this deploy (update vs create). */
  existed: boolean
  /** The prior HCL body, captured for policies this deploy UPDATED. */
  priorPolicy?: string
}

/**
 * Deploy ACL policies to a Vault cluster via the Policies API.
 *
 * An ACL policy is a TRUE UPSERT: `POST /sys/policies/acl/{name}` with
 * `{ "policy": "<HCL>" }` creates or replaces the policy in a single call — no
 * existence check is required for the write. For each declared policy:
 *   - GET  /sys/policies/acl/{name}   — read prior state (404 = absent) to drive
 *                                       rollback (restore-vs-delete + prior body)
 *   - POST /sys/policies/acl/{name}   — upsert the policy with the authored HCL
 *
 * Identity is the (lowercased) NAME. validate rejects the reserved `root`, so it
 * is never targeted; a defensive guard here refuses it too.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildVaultClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractPolicySpecs(ctx.canvas).filter((s) => s.name && s.policy)
  const rollbackState: PolicyRollbackEntry[] = []
  const createdNames: string[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      // Defensive: never create or modify the reserved root policy.
      if (isRootPolicy(spec.name)) {
        throw new Error(`Policy "${spec.name}" is reserved — the root policy cannot be created or modified`)
      }

      // Read prior state so rollback can restore an updated policy or delete a
      // created one. This is NOT an existence check for the write (that is a true
      // upsert) — it only captures rollback state.
      const existing = await getPolicy(client, spec.name)
      if (existing) {
        rollbackState.push({
          name: spec.name,
          existed: true,
          // Capture the prior HCL verbatim so rollback restores the exact body.
          priorPolicy: typeof existing.policy === 'string' ? existing.policy : '',
        })
      } else {
        rollbackState.push({ name: spec.name, existed: false })
        createdNames.push(spec.name)
      }

      // TRUE UPSERT — one POST creates or replaces the policy.
      const res = await client.request('POST', `/sys/policies/acl/${encodeURIComponent(spec.name)}`, {
        body: { policy: spec.policy },
      })
      if (!res.ok) {
        throw new Error(`Failed to write policy "${spec.name}": ${vaultErrorMessage(res)}`)
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} ACL policy(ies) to Vault at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedPolicies: deployed },
      rollbackData: { previousState: rollbackState, createdNames },
    }
  } catch (error) {
    return {
      success: false,
      message: `Policy deployment failed after ${deployed.length} of ${specs.length} policy(ies): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedPolicies: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState, createdNames },
    }
  }
}

// --- Helpers ---

/**
 * Read a single ACL policy by name; null on 404 (absent). Returns the `data`
 * object (`{ name, policy }`). Shared by deploy, healthCheck and driftDetect.
 */
export async function getPolicy(client: VaultClient, name: string): Promise<LivePolicy | null> {
  const res = await client.request('GET', `/sys/policies/acl/${encodeURIComponent(name)}`)
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`Failed to read policy "${name}": ${vaultErrorMessage(res)}`)
  }
  return parseJson<{ data?: LivePolicy }>(res.body)?.data ?? null
}
