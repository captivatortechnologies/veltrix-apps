import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildVaultClient,
  parseJson,
  vaultErrorMessage,
  type VaultClient,
} from '../../lib/vault'
import {
  INTERNAL_TYPE,
  extractGroupSpecs,
  parseMetadataObject,
  type GroupSpec,
  type LiveGroup,
} from './validate'

export interface GroupRollbackEntry {
  name: string
  type: string
  /** false = deploy CREATED this group (rollback deletes it). */
  existed: boolean
  /** Prior authored state captured before an existing group was updated. */
  prior?: {
    type?: string
    policies?: string[]
    member_entity_ids?: string[]
    member_group_ids?: string[]
    metadata?: Record<string, unknown> | null
  }
}

/**
 * Deploy Vault identity groups via the name-keyed /identity/group/name/{name}
 * API. The endpoint is an UPSERT (POST creates or updates), so for each group:
 *
 *   1. GET the live group by name.
 *   2. If it exists with a DIFFERENT type → FAIL. A group's type is immutable;
 *      Vault cannot convert internal↔external, and this app refuses to delete +
 *      recreate silently.
 *   3. POST the desired state. For INTERNAL groups the member lists are sent and
 *      reconciled to exactly the authored set (empty clears them). For EXTERNAL
 *      groups member lists are NEVER sent — Vault manages membership through
 *      group-aliases at login.
 *
 * Rollback state records whether each group already existed (so rollback can
 * delete the ones this deploy created) and the prior authored fields of updated
 * groups (so rollback can restore them). The group name is the stable identity.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildVaultClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractGroupSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: GroupRollbackEntry[] = []
  const createdNames: string[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const live = await findGroup(client, spec.name)

      // Type is IMMUTABLE — a live group with a different type can only be changed
      // by deleting and recreating it. Refuse to do that silently.
      if (live && (live.type ?? '').toLowerCase() !== spec.type) {
        throw new Error(
          `Identity group "${spec.name}" already exists with type "${live.type}", but the configuration requests type "${spec.type}". ` +
            `A group's type is immutable after creation — Vault cannot convert an "${live.type}" group to "${spec.type}". ` +
            `Refusing to change it automatically: delete the group by hand (vault delete identity/group/name/${spec.name}) if you intend to recreate it with the other type, then re-deploy.`,
        )
      }

      if (!live) {
        rollbackState.push({ name: spec.name, type: spec.type, existed: false })
        createdNames.push(spec.name)
      } else {
        // Capture the prior authored fields so rollback can restore them.
        rollbackState.push({
          name: spec.name,
          type: (live.type ?? spec.type).toLowerCase(),
          existed: true,
          prior: {
            type: (live.type ?? spec.type).toLowerCase(),
            policies: Array.isArray(live.policies) ? live.policies : [],
            member_entity_ids: Array.isArray(live.member_entity_ids) ? live.member_entity_ids : [],
            member_group_ids: Array.isArray(live.member_group_ids) ? live.member_group_ids : [],
            metadata: live.metadata ?? {},
          },
        })
      }

      const res = await client.request('POST', `/identity/group/name/${encodeURIComponent(spec.name)}`, {
        body: buildGroupBody(spec),
      })
      if (!res.ok) {
        throw new Error(`Failed to upsert identity group "${spec.name}": ${vaultErrorMessage(res)}`)
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} identity group(s) to Vault at ${baseUrl}: ${deployed.join(', ')}.`,
      artifacts: { baseUrl, deployedGroups: deployed, createdGroups: createdNames },
      rollbackData: { previousState: rollbackState, createdNames },
    }
  } catch (error) {
    return {
      success: false,
      message: `Identity group deployment failed after ${deployed.length} of ${specs.length} group(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedGroups: deployed, createdGroups: createdNames },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState, createdNames },
    }
  }
}

// --- Helpers ---

/** Read a group by name via GET /identity/group/name/{name}; null on 404 (absent). */
export async function findGroup(client: VaultClient, name: string): Promise<LiveGroup | null> {
  const res = await client.request('GET', `/identity/group/name/${encodeURIComponent(name)}`)
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`Failed to read identity group "${name}": ${vaultErrorMessage(res)}`)
  }
  const parsed = parseJson<{ data?: LiveGroup } & LiveGroup>(res.body)
  return parsed?.data ?? parsed ?? null
}

/**
 * Build the POST /identity/group/name/{name} body. `policies` is ALWAYS sent
 * (including empty, to converge and agree with drift). For INTERNAL groups the
 * member lists are ALWAYS sent (empty clears them); for EXTERNAL groups member
 * lists are NEVER sent — Vault manages membership via group-aliases. `metadata`
 * is sent only when authored, so a blank field leaves an existing group's
 * metadata untouched.
 */
export function buildGroupBody(spec: GroupSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    type: spec.type,
    policies: spec.policies,
  }
  if (spec.type === INTERNAL_TYPE) {
    body.member_entity_ids = spec.memberEntityIds
    body.member_group_ids = spec.memberGroupIds
  }
  if (spec.metadataJson) {
    const metadata = parseMetadataObject(spec.metadataJson)
    if (metadata) body.metadata = metadata
  }
  return body
}
