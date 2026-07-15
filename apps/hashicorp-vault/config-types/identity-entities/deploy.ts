import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildVaultClient, parseJson, vaultErrorMessage, type VaultClient } from '../../lib/vault'
import {
  extractEntitySpecs,
  normalizeList,
  normalizeMetadata,
  resolveMetadata,
  type EntitySpec,
  type LiveEntity,
} from './validate'

export interface EntityRollbackEntry {
  name: string
  /** false = deploy CREATED this entity (rollback deletes it, revoking its tokens). */
  existed: boolean
  /** Prior authored state captured before deploy overwrote an existing entity. */
  prior?: {
    policies: string[]
    metadata: Record<string, string>
    disabled: boolean
  }
}

/**
 * Deploy Vault identity entities via the NAME-KEYED endpoint
 * POST /identity/entity/name/{name}. That endpoint is a clean UPSERT: it creates
 * the entity if the name is free and otherwise replaces the authored fields on
 * the existing one — no server-assigned id has to be tracked between runs.
 *
 * For each declared entity:
 *   1. GET /identity/entity/name/{name} to learn whether it already exists and,
 *      if so, capture its prior authored fields for rollback.
 *   2. POST /identity/entity/name/{name} with { policies, metadata, disabled }.
 *      policies and metadata are ALWAYS sent (as [] / {} when cleared) so the
 *      live entity converges to exactly what the canvas declares and drift then
 *      agrees about the target state.
 *
 * Only the authored fields are managed; the server-computed id, aliases,
 * group_ids and timestamps are never written. Entity ALIASES are out of scope.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildVaultClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractEntitySpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: EntityRollbackEntry[] = []
  const createdNames: string[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const live = await getEntity(client, spec.name)

      if (!live) {
        // Absent → create. Its identity is the name in the path, so no id needs
        // to be captured; rollback keys the delete on the name.
        const res = await client.request('POST', `/identity/entity/name/${spec.name}`, {
          body: buildEntityBody(spec),
        })
        if (!res.ok) {
          throw new Error(`Failed to create identity entity "${spec.name}": ${vaultErrorMessage(res)}`)
        }
        rollbackState.push({ name: spec.name, existed: false })
        createdNames.push(spec.name)
      } else {
        // Present → capture prior authored fields, then overwrite (upsert).
        rollbackState.push({
          name: spec.name,
          existed: true,
          prior: {
            policies: normalizeList(live.policies),
            metadata: normalizeMetadata(live.metadata),
            disabled: live.disabled === true,
          },
        })

        const res = await client.request('POST', `/identity/entity/name/${spec.name}`, {
          body: buildEntityBody(spec),
        })
        if (!res.ok) {
          throw new Error(`Failed to update identity entity "${spec.name}": ${vaultErrorMessage(res)}`)
        }
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} identity entity(ies) to Vault at ${baseUrl}: ${deployed.join(', ')}.`,
      artifacts: { baseUrl, deployedEntities: deployed, createdEntities: createdNames },
      rollbackData: { previousState: rollbackState, createdNames },
    }
  } catch (error) {
    return {
      success: false,
      message: `Identity entity deployment failed after ${deployed.length} of ${specs.length} entity(ies): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedEntities: deployed, createdEntities: createdNames },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState, createdNames },
    }
  }
}

// --- Helpers ---

/**
 * Read an entity by name via GET /identity/entity/name/{name}; null when absent
 * (404). Vault wraps the entity under `data`.
 */
export async function getEntity(client: VaultClient, name: string): Promise<LiveEntity | null> {
  const res = await client.request('GET', `/identity/entity/name/${name}`)
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`Failed to read identity entity "${name}": ${vaultErrorMessage(res)}`)
  }
  const parsed = parseJson<{ data?: LiveEntity }>(res.body)
  return parsed?.data ?? null
}

/**
 * Build the POST body used to upsert an entity. policies and metadata are always
 * present so clearing them on the canvas converges the live entity; the name is
 * carried in the path, not the body.
 */
export function buildEntityBody(spec: EntitySpec): Record<string, unknown> {
  return {
    policies: spec.policies,
    metadata: resolveMetadata(spec.metadataJson),
    disabled: spec.disabled,
  }
}
