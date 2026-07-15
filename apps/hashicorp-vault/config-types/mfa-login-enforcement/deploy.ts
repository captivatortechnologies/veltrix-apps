import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildVaultClient, parseJson, vaultErrorMessage, type VaultClient } from '../../lib/vault'
import { extractEnforcementSpecs, type EnforcementSpec, type LiveEnforcement } from './validate'

/** The authored (non-computed) fields of an enforcement — captured for rollback. */
export interface EnforcementState {
  mfa_method_ids: string[]
  auth_method_types: string[]
  auth_method_accessors: string[]
  identity_group_ids: string[]
  identity_entity_ids: string[]
}

export interface EnforcementRollbackEntry {
  /** Enforcement name — the stable identity rollback keys on. */
  name: string
  /** Whether the enforcement already existed before this deploy (update vs create). */
  existed: boolean
  /** The prior authored state, captured for enforcements this deploy UPDATED. */
  priorState?: EnforcementState
}

/**
 * Deploy login-MFA enforcements to a Vault cluster via the Login MFA API.
 *
 * An enforcement is a TRUE UPSERT: `POST /identity/mfa/login-enforcement/{name}`
 * with the full body creates or replaces it in a single call — no existence
 * check is required for the write. For each declared enforcement:
 *   - GET  /identity/mfa/login-enforcement/{name}  — read prior state (404 =
 *          absent) to drive rollback (restore-vs-delete + prior authored fields)
 *   - POST /identity/mfa/login-enforcement/{name}  — upsert with the full body
 *
 * The whole authored object is sent every time (all selectors, empty arrays
 * where unset) so the write fully converges the enforcement. Identity is the
 * NAME; validate guarantees at least one mfa_method_id and at least one selector.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildVaultClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractEnforcementSpecs(ctx.canvas).filter((s) => s.name && s.mfaMethodIds.length > 0)
  const rollbackState: EnforcementRollbackEntry[] = []
  const createdNames: string[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      // Read prior state so rollback can restore an updated enforcement or delete
      // a created one. This is NOT an existence check for the write (that is a
      // true upsert) — it only captures rollback state.
      const existing = await getEnforcement(client, spec.name)
      if (existing) {
        rollbackState.push({ name: spec.name, existed: true, priorState: toState(existing) })
      } else {
        rollbackState.push({ name: spec.name, existed: false })
        createdNames.push(spec.name)
      }

      // TRUE UPSERT — one POST creates or replaces the enforcement.
      const res = await client.request(
        'POST',
        `/identity/mfa/login-enforcement/${encodeURIComponent(spec.name)}`,
        { body: buildEnforcementBody(spec) },
      )
      if (!res.ok) {
        throw new Error(`Failed to write login-MFA enforcement "${spec.name}": ${vaultErrorMessage(res)}`)
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} login-MFA enforcement(s) to Vault at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedEnforcements: deployed, createdEnforcements: createdNames },
      rollbackData: { previousState: rollbackState, createdNames },
    }
  } catch (error) {
    return {
      success: false,
      message: `Login-MFA enforcement deployment failed after ${deployed.length} of ${specs.length} enforcement(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedEnforcements: deployed, createdEnforcements: createdNames },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState, createdNames },
    }
  }
}

// --- Helpers ---

/**
 * Read a single login-MFA enforcement by name; null on 404 (absent). Returns the
 * `data` object. Shared by deploy, healthCheck and driftDetect.
 */
export async function getEnforcement(client: VaultClient, name: string): Promise<LiveEnforcement | null> {
  const res = await client.request('GET', `/identity/mfa/login-enforcement/${encodeURIComponent(name)}`)
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`Failed to read login-MFA enforcement "${name}": ${vaultErrorMessage(res)}`)
  }
  return parseJson<{ data?: LiveEnforcement }>(res.body)?.data ?? null
}

/** Build the POST body used to UPSERT an enforcement — the full authored object. */
export function buildEnforcementBody(spec: EnforcementSpec): Record<string, unknown> {
  return {
    mfa_method_ids: spec.mfaMethodIds,
    auth_method_types: spec.authMethodTypes,
    auth_method_accessors: spec.authMethodAccessors,
    identity_group_ids: spec.identityGroupIds,
    identity_entity_ids: spec.identityEntityIds,
  }
}

/** Normalize a live enforcement to its authored fields (arrays, never undefined). */
export function toState(live: LiveEnforcement): EnforcementState {
  return {
    mfa_method_ids: [...(live.mfa_method_ids ?? [])],
    auth_method_types: [...(live.auth_method_types ?? [])],
    auth_method_accessors: [...(live.auth_method_accessors ?? [])],
    identity_group_ids: [...(live.identity_group_ids ?? [])],
    identity_entity_ids: [...(live.identity_entity_ids ?? [])],
  }
}
