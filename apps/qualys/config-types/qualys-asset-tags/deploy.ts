import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildQualysClient,
  qpsDataList,
  qpsErrorMessage,
  qpsHasMoreRecords,
  qpsWriteError,
  type QualysClient,
  type QualysJsonResponse,
} from '../../lib/qualys'
import {
  assetTagKey,
  extractAssetTagSpecs,
  isDynamicRule,
  type AssetTagSpec,
  type LiveAssetTag,
} from './validate'

// QPS (Asset Management & Tagging) REST endpoints.
export const TAG_CREATE_PATH = '/qps/rest/2.0/create/am/tag'
export const TAG_UPDATE_PATH = '/qps/rest/2.0/update/am/tag'
export const TAG_SEARCH_PATH = '/qps/rest/2.0/search/am/tag'
export const TAG_DELETE_PATH = '/qps/rest/2.0/delete/am/tag'

// QPS search paginates by id; cap pages and page size so a huge tag set can't
// spin forever (mirrors the classic client's MAX_PAGES guard).
const MAX_TAG_PAGES = 50
const TAG_PAGE_SIZE = 1000

export interface AssetTagRollbackEntry {
  key: string
  label: string
  existed: boolean
  id?: string
  prior?: LiveAssetTag
}

/**
 * Deploy Qualys asset tags via the Asset Management & Tagging QPS API.
 *
 * Identity is the name natural key: search all tags, match on the name, then
 * update an existing tag by id or create a new one. The new tag's id is read from
 * the ServiceResponse so rollback can delete it. Static tags carry no rule;
 * dynamic tags carry ruleType + ruleText.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildQualysClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, platformUrl } = built

  const specs = extractAssetTagSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: AssetTagRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    const existing = await listAssetTags(client)
    const byKey = new Map(existing.map((t) => [assetTagKey(t), t]))

    for (const spec of specs) {
      const label = spec.name
      const key = assetTagKey(spec)
      const live = byKey.get(key)

      if (live) {
        rollbackState.push({ key, label, existed: true, id: live.id, prior: live })
        const res = await client.postJson(`${TAG_UPDATE_PATH}/${encodeURIComponent(live.id)}`, buildTagRequest(spec))
        const failed = qpsWriteError(res)
        if (failed) throw new Error(`Failed to update tag "${label}": ${failed}`)
      } else {
        const res = await client.postJson(TAG_CREATE_PATH, buildTagRequest(spec))
        const failed = qpsWriteError(res)
        if (failed) throw new Error(`Failed to create tag "${label}": ${failed}`)
        const newId = firstTagId(res)
        if (!newId) throw new Error(`Tag "${label}" was created but the API returned no id`)
        rollbackState.push({ key, label, existed: false, id: newId })
        createdIds.push(newId)
      }
      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} asset tag(s) to ${platformUrl}: ${deployed.join(', ')}`,
      artifacts: { platformUrl, deployedTags: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Asset tag deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { platformUrl, deployedTags: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/** Search every asset tag, following QPS id-based pagination; throws on error. */
export async function listAssetTags(client: QualysClient): Promise<LiveAssetTag[]> {
  const tags: LiveAssetTag[] = []
  let lastId = 0
  for (let page = 0; page < MAX_TAG_PAGES; page++) {
    const res = await client.postJson(TAG_SEARCH_PATH, buildSearchRequest(lastId))
    const failed = qpsWriteError(res)
    if (failed) throw new Error(`Failed to search asset tags: ${qpsErrorMessage(res)}`)

    const parsed = qpsDataList(res, 'Tag').map(parseTag).filter((t) => t.id && t.name)
    tags.push(...parsed)
    for (const t of parsed) {
      const n = Number(t.id)
      if (Number.isFinite(n) && n > lastId) lastId = n
    }
    if (!qpsHasMoreRecords(res) || parsed.length === 0) break
  }
  return tags
}

/** A ServiceRequest that returns the next page of tags (id greater than lastId). */
export function buildSearchRequest(lastId: number): Record<string, unknown> {
  return {
    ServiceRequest: {
      preferences: { limitResults: TAG_PAGE_SIZE },
      filters: { Criteria: [{ field: 'id', operator: 'GREATER', value: String(lastId) }] },
    },
  }
}

/** Parse one QPS Tag object into a LiveAssetTag. */
export function parseTag(tag: Record<string, unknown>): LiveAssetTag {
  const str = (v: unknown): string => (v === undefined || v === null ? '' : String(v))
  return {
    id: str(tag.id),
    name: str(tag.name),
    ruleType: str(tag.ruleType).toUpperCase(),
    ruleText: str(tag.ruleText),
    color: str(tag.color),
    criticalityScore: str(tag.criticalityScore),
  }
}

/** The id of the first Tag in a create/update ServiceResponse, or null. */
export function firstTagId(res: Pick<QualysJsonResponse, 'json'>): string | null {
  const data = (res.json as { ServiceResponse?: { data?: unknown } } | null)?.ServiceResponse?.data
  // ServiceResponse.data is normally a list of typed wrappers, but tolerate a
  // single-object form too.
  const entries = Array.isArray(data) ? data : data ? [data] : []
  for (const entry of entries) {
    const tag = (entry as { Tag?: { id?: unknown } } | null)?.Tag
    if (tag && tag.id !== undefined && tag.id !== null) return String(tag.id)
  }
  return null
}

/** Build the ServiceRequest body for a create/update from a spec. */
export function buildTagRequest(spec: AssetTagSpec): {
  ServiceRequest: { data: { Tag: Record<string, unknown> } }
} {
  const tag: Record<string, unknown> = { name: spec.name }
  if (isDynamicRule(spec.ruleType)) {
    tag.ruleType = spec.ruleType
    tag.ruleText = spec.ruleText
  }
  if (spec.color) tag.color = normalizeColor(spec.color)
  if (spec.criticalityScore) tag.criticalityScore = Number(spec.criticalityScore)
  return { ServiceRequest: { data: { Tag: tag } } }
}

/** Ensure a hex color has a leading '#' and is upper-case. */
export function normalizeColor(color: string): string {
  const c = color.trim().toUpperCase()
  return c.startsWith('#') ? c : `#${c}`
}
