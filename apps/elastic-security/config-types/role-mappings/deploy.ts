import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildElasticClient, elasticErrorMessage, parseJson, type ElasticClient } from '../../lib/elastic'
import {
  extractMappingSpecs,
  parseJsonObject,
  type LiveRoleMapping,
  type LiveRoleMappingResponse,
  type MappingSpec,
} from './validate'

export interface MappingRollbackEntry {
  name: string
  /** True when a mapping of this name already existed before the deploy. */
  existed: boolean
  /** The prior live mapping, captured so an update can be restored. */
  prior?: LiveRoleMapping
}

/**
 * Deploy role mappings to an Elasticsearch cluster via the _security API.
 *
 * Identity is the mapping NAME, carried in the path. `PUT /_security/role_mapping/{name}`
 * is a TRUE UPSERT — the same call creates a missing mapping and replaces an
 * existing one — so there is no separate create/update branch. For each mapping:
 *   - GET  /_security/role_mapping/{name}  — read prior state (404 = absent).
 *                                            Capture the prior mapping for
 *                                            rollback and whether it existed. If
 *                                            the live mapping carries
 *                                            `metadata._reserved: true` it is a
 *                                            RESERVED/system mapping and the
 *                                            deploy FAILS (never modify those).
 *   - PUT  /_security/role_mapping/{name}  — upsert the body { enabled, roles, rules, metadata? }.
 *
 * NOTE: only native (API-defined) role mappings are managed here. Mappings
 * defined in each node's `role_mapping.yml` file are file-realm managed and are
 * NOT visible to — or updatable through — this API; they are edited on the ES
 * nodes themselves.
 *
 * Role mappings are an Elasticsearch endpoint, so all requests go through
 * client.elasticsearch(), which requires the "Elasticsearch URL" app setting; if
 * it is unset the first request returns status 0 with an explanatory body, which
 * surfaces here as the deploy failure message.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildElasticClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, kibanaUrl } = built

  const specs = extractMappingSpecs(ctx.canvas).filter((s) => s.name && s.rulesJson)
  const rollbackState: MappingRollbackEntry[] = []
  const createdMappings: string[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      // Validated upstream; re-build here to construct the body and to fail
      // loudly rather than PUT a malformed mapping.
      const body = buildMappingBody(spec)

      const existing = await getRoleMapping(client, spec.name)

      // RESERVED backstop: a reserved/system mapping (metadata._reserved = true)
      // is owned by Elasticsearch and MUST NOT be modified — fail the whole
      // deploy so a name collision with a reserved mapping can never overwrite it.
      if (existing && isReservedMapping(existing)) {
        throw new Error(
          `Role mapping "${spec.name}" is a reserved/system mapping (metadata._reserved = true) — refusing to modify a reserved mapping`,
        )
      }

      rollbackState.push({
        name: spec.name,
        existed: existing !== null,
        prior: existing ?? undefined,
      })
      if (existing === null) createdMappings.push(spec.name)

      // TRUE UPSERT — one PUT both creates and replaces.
      const res = await client.elasticsearch('PUT', `/_security/role_mapping/${encodeURIComponent(spec.name)}`, {
        body,
      })
      if (!res.ok) {
        throw new Error(`Failed to upsert role mapping "${spec.name}": ${elasticErrorMessage(res)}`)
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} role mapping(s) to the Elastic deployment at ${kibanaUrl}: ${deployed.join(', ')}`,
      artifacts: { deployment: kibanaUrl, deployedMappings: deployed },
      rollbackData: { previousState: rollbackState, createdMappings },
    }
  } catch (error) {
    return {
      success: false,
      message: `Role mapping deployment failed after ${deployed.length} of ${specs.length} mapping(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { deployment: kibanaUrl, deployedMappings: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState, createdMappings },
    }
  }
}

// --- Helpers ---

/**
 * Fetch a single role mapping by name; null on 404 (absent). The response is a
 * map keyed by name — `{ "<name>": { enabled, roles, rules, metadata } }` — so we
 * unwrap the entry for the requested name. A non-ok, non-404 status (including
 * the status 0 returned when the Elasticsearch URL setting is unset) throws with
 * the error body so the caller can surface it.
 */
export async function getRoleMapping(client: ElasticClient, name: string): Promise<LiveRoleMapping | null> {
  const res = await client.elasticsearch('GET', `/_security/role_mapping/${encodeURIComponent(name)}`)
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`Failed to read role mapping "${name}": ${elasticErrorMessage(res)}`)
  }
  const parsed = parseJson<LiveRoleMappingResponse>(res.body)
  return parsed?.[name] ?? null
}

/**
 * True when a live mapping is a RESERVED/system mapping, flagged via
 * `metadata._reserved: true`. Reserved mappings are Elasticsearch-owned and are
 * never modified by this app.
 */
export function isReservedMapping(mapping: LiveRoleMapping): boolean {
  const meta = mapping.metadata
  return (
    !!meta &&
    typeof meta === 'object' &&
    !Array.isArray(meta) &&
    (meta as Record<string, unknown>)._reserved === true
  )
}

/**
 * Build the upsert body from a spec. The rules DSL is required and must parse to
 * an object; metadata is optional and, when present, must parse to an object.
 * Throws (failing the deploy loudly) rather than PUTting a malformed mapping.
 */
export function buildMappingBody(spec: MappingSpec): Record<string, unknown> {
  const rules = spec.rulesJson ? parseJsonObject(spec.rulesJson) : null
  if (!rules) {
    throw new Error(`Role mapping "${spec.name}": rules must be a valid JSON object`)
  }

  const body: Record<string, unknown> = {
    enabled: spec.enabled,
    roles: spec.roles,
    rules,
  }

  if (spec.metadataJson) {
    const metadata = parseJsonObject(spec.metadataJson)
    if (!metadata) {
      throw new Error(`Role mapping "${spec.name}": metadata must be a valid JSON object`)
    }
    body.metadata = metadata
  }

  return body
}
