import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildAuthentikUrl, buildApiBase, resolveApiToken, resolveVerifyTls, getJsonOrNull } from '../../lib/authentikApi'
import { readManagedFields, readSourceType, sameManagedFields, snapshotManagedFields, SOURCE_ENDPOINT_SEGMENT, type AuthentikSource } from './_shared'

/**
 * Drift for sources: re-fetch by slug WITHIN the item's own type's endpoint,
 * compare managed fields. Secrets are never compared (write-only, never read
 * back — see _shared.ts).
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, deployedConfig, settings } = ctx
  const items = deployedConfig.items ?? deployedConfig.sections ?? []
  const diffs: DriftDiff[] = []

  const token = resolveApiToken(credential)
  if (!token) return { hasDrift: false, diffs }

  const base = buildApiBase(buildAuthentikUrl(component, connectivity, connectivityProvider))
  const verifyTls = resolveVerifyTls(settings)

  for (const item of items) {
    const slug = String(item.fields.slug ?? '').trim()
    if (!slug) continue
    const type = readSourceType(item.fields.type)
    const path = `${base}/sources/${SOURCE_ENDPOINT_SEGMENT[type]}/${encodeURIComponent(slug)}/`

    let live: AuthentikSource | null
    try {
      live = await getJsonOrNull<AuthentikSource>(path, token, { verifyTls })
    } catch {
      continue
    }

    const label = `${slug} (${type})`
    if (!live) {
      diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }

    const expected = readManagedFields(item.fields)
    const actual = snapshotManagedFields(live, type)
    if (sameManagedFields(expected, actual)) continue

    // Coarse: flag the whole source as changed rather than diffing every
    // type-specific field individually (the field set varies by type, and
    // secrets are never compared).
    diffs.push({ field: label, expected: 'matches declared configuration', actual: 'differs from declared configuration', severity: 'warning' })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
