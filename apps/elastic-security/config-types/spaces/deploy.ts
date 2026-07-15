import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildElasticClient,
  elasticErrorMessage,
  parseJson,
  type ElasticClient,
} from '../../lib/elastic'
import { extractSpaceSpecs, type LiveSpace, type SpaceSpec } from './validate'

/**
 * The spaces API is NOT itself space-scoped — it must be called on the DEFAULT
 * space, so every request passes `space: 'default'` to suppress the `/s/{space}`
 * URL prefix the Kibana client would otherwise add.
 */
const SPACES_SPACE = 'default'

/** Fields captured from a live space so rollback can restore an updated one. */
export interface SpacePriorState {
  name?: string
  description?: string
  disabledFeatures?: string[]
  solution?: string
  initials?: string
  color?: string
}

export interface SpaceRollbackEntry {
  id: string
  existed: boolean
  /** Prior authored fields, captured only when the space already existed. */
  prior?: SpacePriorState
}

/**
 * Deploy Kibana spaces via the Spaces API (all through Kibana on the default
 * space — spaces are not space-scoped). Identity is the space `id`, which is
 * IMMUTABLE: it is the URL key and the value we match on. For each declared
 * space:
 *   - GET  /api/spaces/space/{id}   — 404 => absent
 *   - POST /api/spaces/space        — create when absent (record created id)
 *   - PUT  /api/spaces/space/{id}   — update in place when present (capture prior)
 *
 * PROTECTED default: the built-in `default` space is only ever UPDATED in place
 * (it always exists, so it takes the PUT path). Deploy NEVER issues a DELETE, so
 * it can never delete the default; deletion protection is enforced at the one
 * place a space delete happens — rollback — via isProtectedSpaceId.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildElasticClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, kibanaUrl } = built

  const specs = extractSpaceSpecs(ctx.canvas).filter((s) => s.id && s.name)
  const rollbackState: SpaceRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const existing = await getSpace(client, spec.id)

      if (existing) {
        // Update in place (PUT /{id}). The default space always lands here, so
        // it is updated but never created or deleted — exactly what is allowed.
        rollbackState.push({
          id: spec.id,
          existed: true,
          prior: {
            name: existing.name,
            // Capture explicit empties so rollback can clear a value this deploy
            // sets on a space that previously had none.
            description: existing.description ?? '',
            disabledFeatures: existing.disabledFeatures ?? [],
            solution: existing.solution ?? '',
            initials: existing.initials ?? '',
            color: existing.color ?? '',
          },
        })

        const res = await client.kibana('PUT', `/api/spaces/space/${encodeURIComponent(spec.id)}`, {
          body: buildSpaceBody(spec),
          space: SPACES_SPACE,
        })
        if (!res.ok) {
          throw new Error(`Failed to update space "${spec.id}": ${elasticErrorMessage(res)}`)
        }
      } else {
        // Create (POST). The default space can never reach here (it always
        // exists), so a created space is never the protected default.
        const res = await client.kibana('POST', '/api/spaces/space', {
          body: buildSpaceBody(spec),
          space: SPACES_SPACE,
        })
        if (!res.ok) {
          throw new Error(`Failed to create space "${spec.id}": ${elasticErrorMessage(res)}`)
        }
        rollbackState.push({ id: spec.id, existed: false })
        createdIds.push(spec.id)
      }

      deployed.push(spec.id)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} space(s) to Kibana at ${kibanaUrl}: ${deployed.join(', ')}`,
      artifacts: { kibanaUrl, deployedSpaces: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Space deployment failed after ${deployed.length} of ${specs.length} space(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { kibanaUrl, deployedSpaces: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/** Fetch a single space by id; null on 404 (absent). */
export async function getSpace(client: ElasticClient, id: string): Promise<LiveSpace | null> {
  const res = await client.kibana('GET', `/api/spaces/space/${encodeURIComponent(id)}`, {
    space: SPACES_SPACE,
  })
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`Failed to fetch space "${id}": ${elasticErrorMessage(res)}`)
  }
  return parseJson<LiveSpace>(res.body)
}

/** List every space in the deployment; used by healthCheck for reachability. */
export async function listSpaces(client: ElasticClient): Promise<LiveSpace[]> {
  const res = await client.kibana('GET', '/api/spaces/space', { space: SPACES_SPACE })
  if (!res.ok) {
    throw new Error(`Failed to list spaces: ${elasticErrorMessage(res)}`)
  }
  return parseJson<LiveSpace[]>(res.body) ?? []
}

/**
 * Build the Spaces API body from a spec. `id` and `name` are always sent (both
 * POST and PUT require them; the id is echoed unchanged because it is immutable).
 * disabledFeatures is always sent as an array so clearing it converges the live
 * space; the remaining optional fields are only sent when set.
 */
export function buildSpaceBody(spec: SpaceSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    id: spec.id,
    name: spec.name,
    disabledFeatures: spec.disabledFeatures,
  }
  if (spec.description !== undefined) body.description = spec.description
  if (spec.solution) body.solution = spec.solution
  if (spec.initials !== undefined) body.initials = spec.initials
  if (spec.color !== undefined) body.color = spec.color
  return body
}

/** Shared with rollback so both call the un-scoped spaces API the same way. */
export { SPACES_SPACE }
