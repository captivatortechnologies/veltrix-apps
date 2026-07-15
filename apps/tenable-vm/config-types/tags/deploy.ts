import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildTenableClient,
  parseJson,
  tenableErrorMessage,
  type TenableClient,
} from '../../lib/tenable'
import { extractTagSpecs, parseFilterObject, type LiveTag, type TagSpec } from './validate'

export interface TagRollbackEntry {
  category: string
  value: string
  existed: boolean
  uuid?: string
  prior?: Partial<Pick<LiveTag, 'value' | 'description' | 'filters' | 'category_name'>>
}

/**
 * Deploy asset tags to a Tenable tenant via the Tags API.
 *
 * A tag is a category:value pair; the UUID Tenable assigns belongs to the
 * VALUE, and the category is auto-created the first time a value references a
 * new category_name. For each declared tag:
 *   - GET  /tags/values          — list, then match on (category_name, value)
 *   - PUT  /tags/values/{uuid}    — update an existing value (capture prior body)
 *   - POST /tags/values          — create a missing value (capture new uuid)
 *
 * Identity is the (category, value) PAIR. Because we match on both halves,
 * changing a value's category is NOT an update — the pair no longer matches, so
 * the value is created anew under the new category (the old value is left
 * intact), which is exactly how Tenable treats a cross-category move.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildTenableClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractTagSpecs(ctx.canvas).filter((s) => s.category && s.value)
  const rollbackState: TagRollbackEntry[] = []
  const createdUuids: string[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const label = `${spec.category}:${spec.value}`

      // Filters are validated upstream; re-parse here to build the API body and
      // to fail loudly rather than send a malformed filter.
      const filters = spec.filters ? parseFilterObject(spec.filters) : undefined
      if (spec.filters && filters === null) {
        throw new Error(`Tag "${label}": asset filter is not a valid JSON object`)
      }

      const existing = await findTagValue(client, spec.category, spec.value)

      if (existing && existing.uuid) {
        rollbackState.push({
          category: spec.category,
          value: spec.value,
          existed: true,
          uuid: existing.uuid,
          prior: {
            value: existing.value,
            // Capture an explicit empty so rollback can clear a description the
            // deployment sets on a tag that previously had none.
            description: existing.description ?? '',
            filters: existing.filters,
            category_name: existing.category_name,
          },
        })

        const res = await client.request('PUT', `/tags/values/${existing.uuid}`, {
          body: buildUpdatePayload(spec, filters ?? undefined),
        })
        if (!res.ok) {
          throw new Error(`Failed to update tag "${label}": ${tenableErrorMessage(res)}`)
        }
      } else {
        const res = await client.request('POST', '/tags/values', {
          body: buildCreatePayload(spec, filters ?? undefined),
        })
        if (!res.ok) {
          throw new Error(`Failed to create tag "${label}": ${tenableErrorMessage(res)}`)
        }
        const created = parseJson<LiveTag>(res.body)
        if (!created?.uuid) {
          throw new Error(`Tag "${label}" was created but the API returned no value uuid`)
        }
        rollbackState.push({ category: spec.category, value: spec.value, existed: false, uuid: created.uuid })
        createdUuids.push(created.uuid)
      }

      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} tag(s) to Tenable tenant at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedTags: deployed },
      rollbackData: { previousState: rollbackState, createdUuids },
    }
  } catch (error) {
    return {
      success: false,
      message: `Tag deployment failed after ${deployed.length} of ${specs.length} tag(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedTags: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState, createdUuids },
    }
  }
}

// --- Helpers ---

/**
 * Find a tag VALUE by its (category_name, value) pair; null when absent.
 * A plain GET /tags/values returns the full value list (default limit 5000).
 */
export async function findTagValue(
  client: TenableClient,
  category: string,
  value: string,
): Promise<LiveTag | null> {
  const res = await client.request('GET', '/tags/values', { query: { limit: 5000 } })
  if (!res.ok) {
    throw new Error(`Failed to list tag values while resolving "${category}:${value}": ${tenableErrorMessage(res)}`)
  }
  const values = parseJson<{ values?: LiveTag[] }>(res.body)?.values ?? []
  // The pair is the logical key — match both halves exactly. A value with the
  // same name under a different category is a DIFFERENT tag and must not be
  // adopted, or the deployment would mutate the wrong assets' tagging.
  return values.find((v) => v.category_name === category && v.value === value) ?? null
}

/** Fetch a single tag value by uuid; null on 404. */
export async function getTagValueByUuid(
  client: TenableClient,
  uuid: string,
): Promise<LiveTag | null> {
  const res = await client.request('GET', `/tags/values/${uuid}`)
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`Failed to fetch tag value ${uuid}: ${tenableErrorMessage(res)}`)
  }
  return parseJson<LiveTag>(res.body)
}

function buildCreatePayload(
  spec: TagSpec,
  filters: Record<string, unknown> | undefined,
): Record<string, unknown> {
  // Provide category_name (not category_uuid) so Tenable auto-creates the
  // category when it does not yet exist.
  const payload: Record<string, unknown> = { category_name: spec.category, value: spec.value }
  if (spec.description) payload.description = spec.description
  // category_description is only honoured when the category is auto-created.
  if (spec.categoryDescription) payload.category_description = spec.categoryDescription
  // A filter makes the tag DYNAMIC; omit it for a static tag.
  if (filters) payload.filters = filters
  return payload
}

function buildUpdatePayload(
  spec: TagSpec,
  filters: Record<string, unknown> | undefined,
): Record<string, unknown> {
  // category_name is echoed back unchanged (we matched on it) so the record is
  // fully specified; description is always sent so clearing it on the canvas
  // converges the live tag (and drift detection agrees about the target state).
  const payload: Record<string, unknown> = {
    category_name: spec.category,
    value: spec.value,
    description: spec.description ?? '',
  }
  if (filters) payload.filters = filters
  return payload
}
