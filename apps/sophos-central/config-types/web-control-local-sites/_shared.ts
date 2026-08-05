// =============================================================================
// Shared helpers for the Sophos Central Web Control Local Sites config type.
//
// A local site is reconciled by its `url` — Sophos assigns the id on create.
// Unlike blocked/allowed items, PATCH accepts every field (categoryId, tags,
// url, comment), so an existing match can always be patched in place.
// =============================================================================

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'
import { canonicalJson, readOptionalNumber, splitList, str } from '../../lib/sophosCommon'
import type { SophosLocalSite } from '../../lib/sophosApi'

export interface LocalSiteSpec {
  itemName: string
  url: string
  categoryId?: number
  tags: string[]
  comment: string
}

/** The site's logical identity: its URL, lower-cased for matching. */
export function localSiteKey(url: string): string {
  return url.trim().toLowerCase()
}

export function extractLocalSiteSpecs(canvas: CanvasSnapshot): LocalSiteSpec[] {
  return (canvas.items ?? canvas.sections ?? []).map((item) => {
    const fields = item.fields ?? {}
    return {
      itemName: item.name,
      url: str(fields.url),
      categoryId: readOptionalNumber(fields.categoryId),
      tags: splitList(fields.tags),
      comment: str(fields.comment),
    }
  })
}

/** Build the create/update request body from a declared spec. */
export function buildLocalSiteBody(
  spec: LocalSiteSpec,
): Pick<SophosLocalSite, 'url'> & Partial<Pick<SophosLocalSite, 'categoryId' | 'tags' | 'comment'>> {
  const body: Pick<SophosLocalSite, 'url'> & Partial<Pick<SophosLocalSite, 'categoryId' | 'tags' | 'comment'>> = { url: spec.url }
  if (spec.categoryId !== undefined) body.categoryId = spec.categoryId
  if (spec.tags.length > 0) body.tags = spec.tags
  if (spec.comment) body.comment = spec.comment
  return body
}

/** Does the live site already match the declared categoryId/tags/comment? */
export function localSiteMatches(spec: LocalSiteSpec, live: SophosLocalSite): boolean {
  const expected = { categoryId: spec.categoryId, tags: [...spec.tags].sort(), comment: spec.comment || '' }
  const actual = { categoryId: live.categoryId, tags: [...(live.tags ?? [])].sort(), comment: live.comment || '' }
  return canonicalJson(expected) === canonicalJson(actual)
}
