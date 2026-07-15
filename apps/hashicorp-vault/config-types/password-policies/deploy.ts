import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildVaultClient, parseJson, vaultErrorMessage, type VaultClient } from '../../lib/vault'
import { extractPasswordPolicySpecs, type LivePasswordPolicy } from './validate'

export interface PasswordPolicyRollbackEntry {
  /** Policy name — the stable identity rollback keys on. */
  name: string
  /** Whether the policy already existed before this deploy (update vs create). */
  existed: boolean
  /** The prior HCL body, captured for policies this deploy UPDATED. */
  priorPolicy?: string
}

/**
 * Deploy password GENERATION policies to a Vault cluster via the Password
 * Policies API. These are the templates secret engines use to mint random
 * passwords — distinct from ACL policies.
 *
 * A password policy is a TRUE UPSERT: `POST /sys/policies/password/{name}` with
 * `{ "policy": "<HCL>" }` creates or replaces the policy in a single call — no
 * existence check is required for the write. For each declared policy:
 *   - GET  /sys/policies/password/{name}   — read prior state (404 = absent) to
 *                                            drive rollback (restore-vs-delete)
 *   - POST /sys/policies/password/{name}   — upsert the policy with authored HCL
 *
 * Identity is the NAME (used verbatim, as Vault stores it).
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildVaultClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractPasswordPolicySpecs(ctx.canvas).filter((s) => s.name && s.policy)
  const rollbackState: PasswordPolicyRollbackEntry[] = []
  const createdNames: string[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      // Read prior state so rollback can restore an updated policy or delete a
      // created one. This is NOT an existence check for the write (that is a true
      // upsert) — it only captures rollback state.
      const existing = await getPasswordPolicy(client, spec.name)
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
      const res = await client.request('POST', `/sys/policies/password/${encodeURIComponent(spec.name)}`, {
        body: { policy: spec.policy },
      })
      if (!res.ok) {
        throw new Error(`Failed to write password policy "${spec.name}": ${vaultErrorMessage(res)}`)
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} password policy(ies) to Vault at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedPasswordPolicies: deployed, createdPasswordPolicies: createdNames },
      rollbackData: { previousState: rollbackState, createdNames },
    }
  } catch (error) {
    return {
      success: false,
      message: `Password policy deployment failed after ${deployed.length} of ${specs.length} policy(ies): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedPasswordPolicies: deployed, createdPasswordPolicies: createdNames },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState, createdNames },
    }
  }
}

// --- Helpers ---

/**
 * Read a single password policy by name; null on 404 (absent). Returns the
 * `data` object (`{ policy }`). Shared by deploy, healthCheck and driftDetect.
 */
export async function getPasswordPolicy(client: VaultClient, name: string): Promise<LivePasswordPolicy | null> {
  const res = await client.request('GET', `/sys/policies/password/${encodeURIComponent(name)}`)
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`Failed to read password policy "${name}": ${vaultErrorMessage(res)}`)
  }
  return parseJson<{ data?: LivePasswordPolicy }>(res.body)?.data ?? null
}
