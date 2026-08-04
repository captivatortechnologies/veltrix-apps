import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildVectraApiBase, buildAuthHeader, getJson } from '../../lib/vectraApi'
import { parseTags, tagsFromGet, taggingPath, sortedJoin } from './_shared'

/**
 * Drift for entity tags: compare the declared tag set against the live tags on each
 * entity. Best-effort — an entity that can't be read (missing / transient error) is
 * skipped rather than raising false drift. Read-only: GET /tagging/{host|account}/{id}.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const base = buildVectraApiBase(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  for (const item of items) {
    const entityType = String(item.fields.entity_type ?? '').trim()
    const entityId = String(item.fields.entity_id ?? '').trim()
    if (!entityType || !entityId) continue

    let actual: string[]
    try {
      actual = tagsFromGet(await getJson<unknown>(`${base}${taggingPath(entityType, entityId)}`, headers))
    } catch {
      continue
    }

    const expected = parseTags(item.fields.tags)
    if (sortedJoin(expected) !== sortedJoin(actual)) {
      diffs.push({
        field: `${entityType}:${entityId}.tags`,
        expected: expected.join(', '),
        actual: actual.join(', '),
        severity: 'warning',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
