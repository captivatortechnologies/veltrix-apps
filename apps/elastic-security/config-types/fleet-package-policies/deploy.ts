import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildElasticClient, elasticErrorMessage, parseJson, type ElasticClient } from '../../lib/elastic'
import {
  extractPolicySpecs,
  parseJsonArray,
  parseJsonObject,
  type FleetPackagePolicySpec,
  type LiveFleetPackagePolicy,
  type LiveFleetPackagePolicyList,
} from './validate'

/** A generous page size — large enough to list every policy in one request for the reconcile-by-name lookup. */
const LIST_PAGE_SIZE = 1000

export interface FleetPackagePolicyRollbackEntry {
  name: string
  existed: boolean
  /** Fleet-assigned internal id, needed to update/delete via the path. */
  id?: string
  /** The prior live policy, captured so an update can be restored. */
  prior?: LiveFleetPackagePolicy
}

/**
 * Deploy Fleet package (integration) policies via the Kibana Fleet API.
 *
 * Fleet ASSIGNS the internal `id` on create — there is no caller-chosen
 * identity — so this reconciles by NAME:
 *   - GET  /api/fleet/package_policies?perPage=1000  — list, match by name
 *     (client-side; Fleet has no verified name-exact server-side filter here)
 *   - POST /api/fleet/package_policies                — create when absent
 *   - PUT  /api/fleet/package_policies/{id}            — full-replace when present
 *
 * Fleet package policies are a Kibana endpoint, so all requests go through
 * client.kibana().
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildElasticClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, kibanaUrl } = built

  const specs = extractPolicySpecs(ctx.canvas).filter((s) => s.name && s.inputsJson)
  const rollbackState: FleetPackagePolicyRollbackEntry[] = []
  const createdNames: string[] = []
  const deployed: string[] = []

  try {
    const live = await listPolicies(client)
    const liveByName = new Map(live.filter((p) => p.name).map((p) => [p.name as string, p]))

    for (const spec of specs) {
      const label = spec.name
      const body = buildPolicyBody(spec)

      const existing = liveByName.get(spec.name)

      if (!existing) {
        const res = await client.kibana('POST', '/api/fleet/package_policies', { body })
        if (!res.ok) {
          throw new Error(`Failed to create Fleet package policy "${label}": ${elasticErrorMessage(res)}`)
        }
        const created = parseJson<{ item?: LiveFleetPackagePolicy }>(res.body)?.item
        rollbackState.push({ name: spec.name, existed: false, id: created?.id })
        createdNames.push(spec.name)
      } else {
        rollbackState.push({ name: spec.name, existed: true, id: existing.id, prior: existing })
        const res = await client.kibana('PUT', `/api/fleet/package_policies/${encodeURIComponent(existing.id)}`, {
          body,
        })
        if (!res.ok) {
          throw new Error(`Failed to update Fleet package policy "${label}": ${elasticErrorMessage(res)}`)
        }
      }

      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} Fleet package policy(ies) to Kibana at ${kibanaUrl}: ${deployed.join(', ')}`,
      artifacts: { kibanaUrl, deployedPolicies: deployed },
      rollbackData: { previousState: rollbackState, createdNames },
    }
  } catch (error) {
    return {
      success: false,
      message: `Fleet package policy deployment failed after ${deployed.length} of ${specs.length} polic(y/ies): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { kibanaUrl, deployedPolicies: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState, createdNames },
    }
  }
}

// --- Helpers ---

/** List every Fleet package policy (single generous page — see LIST_PAGE_SIZE). */
export async function listPolicies(client: ElasticClient): Promise<LiveFleetPackagePolicy[]> {
  const res = await client.kibana('GET', '/api/fleet/package_policies', { query: { perPage: LIST_PAGE_SIZE } })
  if (!res.ok) {
    throw new Error(`Failed to list Fleet package policies: ${elasticErrorMessage(res)}`)
  }
  return parseJson<LiveFleetPackagePolicyList>(res.body)?.items ?? []
}

/** Fetch a single package policy by its Fleet-assigned id; null on 404 (absent). */
export async function getPolicyById(client: ElasticClient, id: string): Promise<LiveFleetPackagePolicy | null> {
  const res = await client.kibana('GET', `/api/fleet/package_policies/${encodeURIComponent(id)}`)
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`Failed to read Fleet package policy "${id}": ${elasticErrorMessage(res)}`)
  }
  return parseJson<{ item?: LiveFleetPackagePolicy }>(res.body)?.item ?? null
}

/** Build the create/update body (Fleet's NewPackagePolicy shape). Validated upstream; JSON blobs re-parsed here to fail loudly rather than send a malformed policy. */
export function buildPolicyBody(spec: FleetPackagePolicySpec): Record<string, unknown> {
  const inputs = spec.inputsJson ? parseJsonArray(spec.inputsJson) : null
  if (!inputs) {
    throw new Error(`Fleet package policy "${spec.name}": Inputs is not a valid JSON array`)
  }

  const body: Record<string, unknown> = {
    name: spec.name,
    namespace: spec.namespace,
    enabled: spec.enabled,
    policy_ids: spec.policyIds,
    package: {
      name: spec.packageName,
      version: spec.packageVersion,
      title: spec.packageTitle || spec.packageName,
    },
    inputs,
  }
  if (spec.description !== undefined) body.description = spec.description

  if (spec.varsJson) {
    const vars = parseJsonObject(spec.varsJson)
    if (!vars) throw new Error(`Fleet package policy "${spec.name}": Top-level Vars is not a valid JSON object`)
    body.vars = vars
  }

  return body
}
