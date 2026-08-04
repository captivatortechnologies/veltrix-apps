import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildElasticClient, elasticErrorMessage, parseJson, type ElasticClient } from '../../lib/elastic'
import {
  extractRoleSpecs,
  isReservedRole,
  parseJsonArray,
  parseJsonObject,
  type LiveRole,
  type LiveRoleResponse,
  type RoleSpec,
} from './validate'

export interface RoleRollbackEntry {
  name: string
  /** True when a role of this name already existed before the deploy. */
  existed: boolean
  /** The prior live role, captured so an update can be restored. */
  prior?: LiveRole
}

/**
 * Deploy Elasticsearch security roles via the _security API.
 *
 * Identity is the role NAME, carried in the path. `PUT /_security/role/{name}`
 * is a TRUE UPSERT — the same call creates a missing role and replaces an
 * existing one — so there is no separate create/update branch. For each role:
 *   - GET  /_security/role/{name}  — read prior state (404 = absent). Capture
 *                                    the prior role for rollback and whether it
 *                                    existed. If the live role carries
 *                                    `metadata._reserved: true` it is a
 *                                    RESERVED/built-in role and the deploy FAILS
 *                                    (never modify those).
 *   - PUT  /_security/role/{name}  — upsert the body { cluster?, indices?, applications?, run_as?, metadata?, description? }.
 *
 * Roles are an Elasticsearch endpoint, so all requests go through
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

  const specs = extractRoleSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: RoleRollbackEntry[] = []
  const createdRoles: string[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const body = buildRoleBody(spec)

      const existing = await getRole(client, spec.name)

      // RESERVED backstop: a built-in role (metadata._reserved = true) is owned
      // by Elasticsearch/Kibana and MUST NOT be modified — fail the whole deploy
      // so a name collision with a reserved role can never overwrite it.
      if (existing && isReservedRole(existing)) {
        throw new Error(
          `Role "${spec.name}" is a reserved/built-in role (metadata._reserved = true) — refusing to modify a reserved role`,
        )
      }

      rollbackState.push({ name: spec.name, existed: existing !== null, prior: existing ?? undefined })
      if (existing === null) createdRoles.push(spec.name)

      // TRUE UPSERT — one PUT both creates and replaces.
      const res = await client.elasticsearch('PUT', `/_security/role/${encodeURIComponent(spec.name)}`, { body })
      if (!res.ok) {
        throw new Error(`Failed to upsert role "${spec.name}": ${elasticErrorMessage(res)}`)
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} role(s) to the Elastic deployment at ${kibanaUrl}: ${deployed.join(', ')}`,
      artifacts: { deployment: kibanaUrl, deployedRoles: deployed },
      rollbackData: { previousState: rollbackState, createdRoles },
    }
  } catch (error) {
    return {
      success: false,
      message: `Role deployment failed after ${deployed.length} of ${specs.length} role(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { deployment: kibanaUrl, deployedRoles: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState, createdRoles },
    }
  }
}

// --- Helpers ---

/**
 * Fetch a single role by name; null on 404 (absent). The response is a map
 * keyed by name — `{ "<name>": { cluster, indices, ... } }` — so we unwrap the
 * entry for the requested name.
 */
export async function getRole(client: ElasticClient, name: string): Promise<LiveRole | null> {
  const res = await client.elasticsearch('GET', `/_security/role/${encodeURIComponent(name)}`)
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`Failed to read role "${name}": ${elasticErrorMessage(res)}`)
  }
  const parsed = parseJson<LiveRoleResponse>(res.body)
  return parsed?.[name] ?? null
}

/**
 * Build the upsert body from a spec. Validated upstream; JSON blobs are
 * re-parsed here to build the API body and to fail loudly rather than PUT a
 * malformed role.
 */
export function buildRoleBody(spec: RoleSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  if (spec.description !== undefined) body.description = spec.description
  // Always send cluster/run_as as arrays (possibly empty) so clearing them on
  // the canvas converges the live role.
  body.cluster = spec.cluster
  body.run_as = spec.runAs

  if (spec.indicesJson) {
    const indices = parseJsonArray(spec.indicesJson)
    if (!indices) throw new Error(`Role "${spec.name}": Index Privileges is not a valid JSON array`)
    body.indices = indices
  } else {
    body.indices = []
  }

  if (spec.applicationsJson) {
    const applications = parseJsonArray(spec.applicationsJson)
    if (!applications) throw new Error(`Role "${spec.name}": Application Privileges is not a valid JSON array`)
    body.applications = applications
  } else {
    body.applications = []
  }

  if (spec.metadataJson) {
    const metadata = parseJsonObject(spec.metadataJson)
    if (!metadata) throw new Error(`Role "${spec.name}": Metadata is not a valid JSON object`)
    body.metadata = metadata
  }

  return body
}
