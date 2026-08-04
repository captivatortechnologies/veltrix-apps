import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildElasticClient, elasticErrorMessage, parseJson, type ElasticClient } from '../../lib/elastic'
import { extractTagSpecs, type LiveTag, type TagSpec } from './validate'

export interface TagRollbackEntry {
  id: string
  existed: boolean
  /** Prior authored fields, captured only when the tag already existed. */
  prior?: Pick<LiveTag, 'name' | 'color' | 'description'>
}

/**
 * Deploy Kibana tags via the Tags API.
 *
 * Identity is the tag ID — caller-chosen, unlike POST /api/tags (which
 * server-generates one). `PUT /api/tags/{id}` is documented as "Upsert a tag" —
 * a TRUE UPSERT — so the same call creates a missing tag and replaces an
 * existing one. For each declared tag:
 *   - GET /api/tags/{id}  — read prior state (404 = absent). Capture the prior
 *                           fields for rollback and whether it existed.
 *   - PUT /api/tags/{id}  — upsert the body { name, color, description }.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildElasticClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, kibanaUrl } = built

  const specs = extractTagSpecs(ctx.canvas).filter((s) => s.id && s.name && s.color)
  const rollbackState: TagRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const existing = await getTag(client, spec.id)

      rollbackState.push({
        id: spec.id,
        existed: existing !== null,
        prior: existing
          ? { name: existing.name, color: existing.color, description: existing.description ?? '' }
          : undefined,
      })
      if (existing === null) createdIds.push(spec.id)

      // TRUE UPSERT — one PUT both creates and replaces.
      const res = await client.kibana('PUT', `/api/tags/${encodeURIComponent(spec.id)}`, { body: buildTagBody(spec) })
      if (!res.ok) {
        throw new Error(`Failed to upsert tag "${spec.id}": ${elasticErrorMessage(res)}`)
      }

      deployed.push(spec.id)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} tag(s) to Kibana at ${kibanaUrl}: ${deployed.join(', ')}`,
      artifacts: { kibanaUrl, deployedTags: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Tag deployment failed after ${deployed.length} of ${specs.length} tag(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { kibanaUrl, deployedTags: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/** Fetch a single tag by id; null on 404 (absent). */
export async function getTag(client: ElasticClient, id: string): Promise<LiveTag | null> {
  const res = await client.kibana('GET', `/api/tags/${encodeURIComponent(id)}`)
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`Failed to fetch tag "${id}": ${elasticErrorMessage(res)}`)
  }
  return parseJson<LiveTag>(res.body)
}

/** Build the upsert body. description is always sent (possibly empty) so clearing it on the canvas converges the live tag. */
export function buildTagBody(spec: TagSpec): Record<string, unknown> {
  return { name: spec.name, color: spec.color, description: spec.description ?? '' }
}
