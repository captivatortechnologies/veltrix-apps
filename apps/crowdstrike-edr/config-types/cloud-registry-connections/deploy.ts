import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildFalconClient,
  falconErrorMessage,
  falconFailure,
  parseEnvelope,
  type FalconClient,
} from '../../lib/falcon'
import {
  extractRegistrySpecs,
  hasCredential,
  REGISTRY_STATE_DISABLED,
  REGISTRY_STATE_ENABLED,
  type LiveRegistry,
  type RegistrySpec,
} from './validate'

/** Collection paths for registry connections. */
export const REGISTRY_ENTITY = '/container-security/entities/registries/v1'
export const REGISTRY_QUERIES = '/container-security/queries/registries/v1'

/**
 * Rollback state for one registry. `prior` carries ONLY non-secret fields — the
 * write-only credential is never read back or stored, so a restored registry
 * keeps whatever credential it already had.
 */
export interface RegistryRollbackEntry {
  name: string
  existed: boolean
  id?: string
  prior?: {
    type?: string
    url?: string
    url_uniqueness_key?: string
    user_defined_alias?: string
    state?: string
    scan_interval?: number
  }
}

/**
 * Deploy registry connections to a Falcon tenant via the Cloud Security
 * container registries API.
 *
 * For each declared registry (identity = name / user_defined_alias):
 *   - list registries (queries + entities) and match by alias
 *   - POST  …/registries/v1              — create when absent
 *   - PATCH …/registries/v1?id=<id>      — update when present (PATCH, not PUT)
 *
 * ⚠ SECRET: the credential (username/password or token) is sent on create AND
 * update when supplied, and is NEVER read back, diffed, logged, or stored in
 * rollbackData / artifacts / error messages.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractRegistrySpecs(ctx.canvas).filter((s) => s.name && s.url && s.type)
  const rollbackState: RegistryRollbackEntry[] = []
  const deployed: string[] = []

  try {
    // One list serves all lookups — the collection has no name filter.
    const live = await listRegistries(client)

    for (const spec of specs) {
      const existing = findByAlias(live, spec.name)

      if (existing && (existing.id || existing.uuid)) {
        const id = (existing.id ?? existing.uuid) as string
        rollbackState.push({ name: spec.name, existed: true, id, prior: priorNonSecret(existing) })

        const res = await client.request('PATCH', `${REGISTRY_ENTITY}?id=${encodeURIComponent(id)}`, {
          body: buildRegistryBody(spec),
        })
        const patchFailure = falconFailure(res)
        if (patchFailure) {
          throw new Error(`Failed to update registry "${spec.name}": ${patchFailure}`)
        }
      } else {
        const res = await client.request('POST', REGISTRY_ENTITY, { body: buildRegistryBody(spec) })
        const createFailure = falconFailure(res)
        if (createFailure) {
          throw new Error(`Failed to create registry "${spec.name}": ${createFailure}`)
        }
        const created = parseEnvelope<LiveRegistry>(res.body)?.resources?.[0]
        const id = created?.id ?? created?.uuid
        rollbackState.push({ name: spec.name, existed: false, id })
        if (!id) {
          throw new Error(`Registry "${spec.name}" was created but the API returned no registry id`)
        }
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} registry connection(s) to Falcon tenant at ${baseUrl}: ${deployed.join(', ')}`,
      // artifacts carry names only — never the credential.
      artifacts: { baseUrl, deployedRegistries: deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Registry connection deployment failed after ${deployed.length} of ${specs.length} registry(ies): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedRegistries: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState },
    }
  }
}

// --- Helpers ---

/**
 * Load every registry connection (ids via the queries endpoint, then full
 * entities). The queries endpoint has no name filter, so find-by-name is done
 * client-side on the returned aliases.
 */
export async function listRegistries(client: FalconClient): Promise<LiveRegistry[]> {
  const limit = 100
  const ids: string[] = []
  for (let offset = 0; ; offset += limit) {
    const res = await client.request('GET', REGISTRY_QUERIES, { query: { limit, offset } })
    if (!res.ok) {
      throw new Error(`Failed to list registries: ${falconErrorMessage(res)}`)
    }
    const page = (parseEnvelope<string>(res.body)?.resources ?? []).filter(
      (id): id is string => typeof id === 'string',
    )
    ids.push(...page)
    if (page.length < limit) break
  }
  if (ids.length === 0) return []

  const registries: LiveRegistry[] = []
  // The FalconClient query serializer can't repeat ids=, so id batches are
  // encoded into the path (mirrors lib/entityAdapter.ts).
  for (let i = 0; i < ids.length; i += limit) {
    const batch = ids.slice(i, i + limit)
    const path = `${REGISTRY_ENTITY}?${batch.map((id) => `ids=${encodeURIComponent(id)}`).join('&')}`
    const res = await client.request('GET', path)
    if (!res.ok) {
      throw new Error(`Failed to read registries: ${falconErrorMessage(res)}`)
    }
    registries.push(...(parseEnvelope<LiveRegistry>(res.body)?.resources ?? []))
  }
  return registries
}

/** Find a registry by its alias (exact, then a single case-insensitive match). */
export function findByAlias(registries: LiveRegistry[], name: string): LiveRegistry | null {
  const exact = registries.find((r) => r.user_defined_alias === name)
  if (exact) return exact
  const ci = registries.filter((r) => r.user_defined_alias?.toLowerCase() === name.toLowerCase())
  return ci.length === 1 ? ci[0] : null
}

/**
 * Build the registry request body. Verified fields (type, url, alias, uniqueness
 * key) are always sent. Scan settings (state from `enabled`, `scan_interval`) are
 * best-effort — the published SDK does not enumerate them, so they are applied
 * optimistically and any rejection surfaces via the standard error envelope.
 *
 * ⚠ The credential is attached ONLY when a username or secret is supplied, so a
 * non-credential update never wipes an existing secret.
 */
export function buildRegistryBody(spec: RegistrySpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    user_defined_alias: spec.name,
    url: spec.url,
    url_uniqueness_key: spec.name,
    type: spec.type,
    state: spec.enabled ? REGISTRY_STATE_ENABLED : REGISTRY_STATE_DISABLED,
  }
  if (spec.scanInterval !== undefined) body.scan_interval = spec.scanInterval

  const details: Record<string, unknown> = {}
  if (spec.username) details.username = spec.username
  if (hasCredential(spec)) details.password = spec.credential // ⚠ write-only secret
  if (Object.keys(details).length > 0) body.credential = { details }

  return body
}

/** Capture a live registry's non-secret fields for rollback (never the credential). */
function priorNonSecret(live: LiveRegistry): RegistryRollbackEntry['prior'] {
  return {
    type: live.type,
    url: live.url,
    url_uniqueness_key: live.url_uniqueness_key,
    user_defined_alias: live.user_defined_alias,
    state: live.state,
    scan_interval: live.scan_interval,
  }
}
