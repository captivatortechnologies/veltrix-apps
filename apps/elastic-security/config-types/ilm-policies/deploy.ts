import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildElasticClient, elasticErrorMessage, parseJson, type ElasticClient } from '../../lib/elastic'
import {
  extractIlmPolicySpecs,
  parsePolicyObject,
  type LiveIlmPolicyEntry,
  type LiveIlmPolicyResponse,
} from './validate'

export interface IlmPolicyRollbackEntry {
  name: string
  /** True when a policy of this name already existed before the deploy. */
  existed: boolean
  /** The prior `.policy` object, captured so an update can be restored. */
  priorPolicy?: Record<string, unknown>
}

/**
 * Deploy ILM policies to an Elasticsearch cluster via the _ilm API.
 *
 * Identity is the policy NAME, carried in the path. `PUT /_ilm/policy/{name}` is
 * a TRUE UPSERT — the same call creates a missing policy and replaces an
 * existing one — so there is no separate create/update branch. For each policy:
 *   - GET  /_ilm/policy/{name}   — read prior state (404 = absent). Capture the
 *                                  prior `.policy` for rollback and whether it
 *                                  existed. If the live policy carries
 *                                  `_meta.managed: true` it is Elastic-MANAGED
 *                                  and the deploy FAILS (never modify those).
 *   - PUT  /_ilm/policy/{name}   — upsert the body { policy: <authored object> }.
 *
 * ILM policies are an Elasticsearch endpoint, so all requests go through
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

  const specs = extractIlmPolicySpecs(ctx.canvas).filter((s) => s.name && s.policyJson)
  const rollbackState: IlmPolicyRollbackEntry[] = []
  const createdPolicies: string[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      // Validated upstream; re-parse here to build the body and to fail loudly
      // rather than PUT a malformed policy.
      const parsed = spec.policyJson ? parsePolicyObject(spec.policyJson) : null
      if (!parsed) {
        throw new Error(`ILM policy "${spec.name}": policy is not a valid JSON object`)
      }

      const existing = await getIlmPolicy(client, spec.name)

      // Live-managed backstop: never modify an Elastic-managed policy, even if
      // the (non-reserved) authored name happens to collide with one.
      if (existing && isManagedPolicy(existing)) {
        throw new Error(
          `ILM policy "${spec.name}" is Elastic-managed (_meta.managed = true) — refusing to modify a managed policy`,
        )
      }

      rollbackState.push({
        name: spec.name,
        existed: existing !== null,
        priorPolicy: existing?.policy,
      })
      if (existing === null) createdPolicies.push(spec.name)

      // TRUE UPSERT — one PUT both creates and replaces. Body wraps the policy.
      const res = await client.elasticsearch('PUT', `/_ilm/policy/${encodeURIComponent(spec.name)}`, {
        body: { policy: parsed },
      })
      if (!res.ok) {
        throw new Error(`Failed to upsert ILM policy "${spec.name}": ${elasticErrorMessage(res)}`)
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} ILM policy(ies) to the Elastic deployment at ${kibanaUrl}: ${deployed.join(', ')}`,
      artifacts: { deployment: kibanaUrl, deployedPolicies: deployed },
      rollbackData: { previousState: rollbackState, createdPolicies },
    }
  } catch (error) {
    return {
      success: false,
      message: `ILM policy deployment failed after ${deployed.length} of ${specs.length} policy(ies): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { deployment: kibanaUrl, deployedPolicies: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState, createdPolicies },
    }
  }
}

// --- Helpers ---

/**
 * Fetch a single ILM policy by name; null on 404. The response is a map keyed by
 * name — `{ "<name>": { version, modified_date, policy } }` — so we unwrap the
 * entry for the requested name. A non-ok, non-404 status (including the status 0
 * returned when the Elasticsearch URL setting is unset) throws with the error
 * body so the caller can surface it.
 */
export async function getIlmPolicy(client: ElasticClient, name: string): Promise<LiveIlmPolicyEntry | null> {
  const res = await client.elasticsearch('GET', `/_ilm/policy/${encodeURIComponent(name)}`)
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`Failed to read ILM policy "${name}": ${elasticErrorMessage(res)}`)
  }
  const parsed = parseJson<LiveIlmPolicyResponse>(res.body)
  return parsed?.[name] ?? null
}

/** True when a live policy is flagged Elastic-managed via `_meta.managed: true`. */
export function isManagedPolicy(entry: LiveIlmPolicyEntry): boolean {
  const meta = entry.policy?._meta
  return (
    !!meta &&
    typeof meta === 'object' &&
    !Array.isArray(meta) &&
    (meta as Record<string, unknown>).managed === true
  )
}
