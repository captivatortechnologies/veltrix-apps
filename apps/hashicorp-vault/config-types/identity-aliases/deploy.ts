import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildVaultClient, parseJson, vaultErrorMessage, type VaultClient } from '../../lib/vault'
import {
  aliasKey,
  extractIdentityAliasSpecs,
  resolveMetadata,
  type AliasKind,
  type IdentityAliasSpec,
  type LiveIdentityAlias,
} from './validate'

export interface IdentityAliasRollbackEntry {
  kind: AliasKind
  name: string
  mountAccessor: string
  /** false = deploy CREATED this alias (rollback deletes it). */
  existed: boolean
  /** The server-assigned alias id — the stable rollback key (never name/mountAccessor). */
  aliasId?: string
  /** The prior canonical_id captured before an update, so rollback can restore it. */
  priorCanonicalId?: string
}

/**
 * Deploy Vault identity aliases via `/identity/{kind}-alias` (entity) or
 * `/identity/{kind}-alias` (group).
 *
 * CREATE IS NOT A NAME UPSERT — an alias's real identity is a server-assigned
 * `id` UUID with no name-in-path form, so (like login-MFA methods,
 * config-types/mfa-methods) deploy reconciles on the LABEL Vault actually
 * enforces uniqueness on: the (mount_accessor, name) pair.
 *
 *   1. LIST /identity/{kind}-alias/id             → every alias id of this kind
 *   2. GET  /identity/{kind}-alias/id/{id} each   → find the one whose
 *                                                    (mount_accessor, name) matches
 *   3a. FOUND  → POST /identity/{kind}-alias/id/{id}   (update canonical_id in
 *               place; capture the prior canonical_id for rollback)
 *   3b. ABSENT → POST /identity/{kind}-alias            (create; capture the new
 *               id in createdIds)
 *
 * custom_metadata is only sent for kind=entity — Vault's group-alias API has
 * no such input (validate warns if it is set on a group alias; it is simply
 * not sent here).
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildVaultClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractIdentityAliasSpecs(ctx.canvas).filter(
    (s) => s.kind && s.name && s.canonicalId && s.mountAccessor,
  )
  const rollbackState: IdentityAliasRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const kind = spec.kind as AliasKind
      const key = aliasKey(kind, spec.mountAccessor, spec.name)

      const existing = await findAliasByLabel(client, kind, spec.mountAccessor, spec.name)

      if (existing && existing.id) {
        rollbackState.push({
          kind,
          name: spec.name,
          mountAccessor: spec.mountAccessor,
          existed: true,
          aliasId: existing.id,
          priorCanonicalId: existing.canonical_id,
        })

        const res = await client.request('POST', `/identity/${kind}-alias/id/${existing.id}`, {
          body: buildAliasBody(spec),
        })
        if (!res.ok) {
          throw new Error(`Failed to update ${kind} alias "${key}": ${vaultErrorMessage(res)}`)
        }
      } else {
        const res = await client.request('POST', `/identity/${kind}-alias`, { body: buildAliasBody(spec) })
        if (!res.ok) {
          throw new Error(`Failed to create ${kind} alias "${key}": ${vaultErrorMessage(res)}`)
        }
        const newId = parseCreatedId(res.body)
        if (!newId) {
          throw new Error(`${kind} alias "${key}" was created but the API returned no id`)
        }
        rollbackState.push({ kind, name: spec.name, mountAccessor: spec.mountAccessor, existed: false, aliasId: newId })
        createdIds.push(newId)
      }

      deployed.push(key)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} identity alias(es) to Vault at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedAliases: deployed, createdAliasIds: createdIds },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Identity alias deployment failed after ${deployed.length} of ${specs.length} alias(es): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedAliases: deployed, createdAliasIds: createdIds },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers (shared with driftDetect / healthCheck) --------------------------

/** List the alias ids for a kind; [] when none exist yet (LIST 404). */
export async function listAliasIds(client: VaultClient, kind: AliasKind): Promise<string[]> {
  const res = await client.request('LIST', `/identity/${kind}-alias/id`)
  if (res.status === 404) return []
  if (!res.ok) {
    throw new Error(`Failed to list ${kind} aliases: ${vaultErrorMessage(res)}`)
  }
  const parsed = parseJson<{ data?: { keys?: string[] } }>(res.body)
  return parsed?.data?.keys ?? []
}

/** Read one alias by id; null on 404. */
export async function getAlias(client: VaultClient, kind: AliasKind, id: string): Promise<LiveIdentityAlias | null> {
  const res = await client.request('GET', `/identity/${kind}-alias/id/${id}`)
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`Failed to read ${kind} alias ${id}: ${vaultErrorMessage(res)}`)
  }
  return parseJson<{ data?: LiveIdentityAlias }>(res.body)?.data ?? null
}

/**
 * Find the alias of `kind` whose (mount_accessor, name) matches — the whole
 * point of the reconciliation, since an alias has no addressable name. LISTs
 * the kind, GETs each id and returns the FIRST match (or null when absent).
 */
export async function findAliasByLabel(
  client: VaultClient,
  kind: AliasKind,
  mountAccessor: string,
  name: string,
): Promise<LiveIdentityAlias | null> {
  const ids = await listAliasIds(client, kind)
  for (const id of ids) {
    const live = await getAlias(client, kind, id)
    if (live && live.mount_accessor === mountAccessor && live.name === name) return live
  }
  return null
}

/** Extract the minted alias id from a create response. */
export function parseCreatedId(body: string): string | undefined {
  const parsed = parseJson<{ data?: { id?: string } }>(body)
  const id = parsed?.data?.id
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

/** Build the create/update body. custom_metadata is only sent for kind=entity. */
export function buildAliasBody(spec: IdentityAliasSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: spec.name,
    canonical_id: spec.canonicalId,
    mount_accessor: spec.mountAccessor,
  }
  if (spec.kind === 'entity' && spec.customMetadataJson !== undefined) {
    body.custom_metadata = resolveMetadata(spec.customMetadataJson)
  }
  return body
}
