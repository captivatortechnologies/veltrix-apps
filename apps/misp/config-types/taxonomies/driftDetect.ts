import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildMispUrl, buildAuthHeader, getJson } from '../../lib/mispApi'
import { taxonomiesFromList, findTaxonomy, normalizeEnabled } from './_shared'

/**
 * Drift for taxonomies: compare the enabled state we declare against the live
 * taxonomy in MISP. Best-effort — a taxonomy that can't be matched (missing /
 * transient error) is skipped rather than raising false drift. Read-only:
 * GET /taxonomies. Verify against a live MISP 2.4 instance.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const base = buildMispUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let live
  try {
    live = taxonomiesFromList(await getJson<unknown>(`${base}/taxonomies`, headers))
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read taxonomies, no drift asserted
  }

  for (const item of items) {
    const namespace = String(item.fields.namespace ?? '').trim()
    const match = findTaxonomy(live, namespace)
    if (!match) continue

    const expectedEnabled = normalizeEnabled(item.fields.state)
    const actualEnabled = normalizeEnabled(match.enabled)
    if (actualEnabled !== expectedEnabled) {
      diffs.push({ field: `${namespace}.enabled`, expected: expectedEnabled, actual: actualEnabled, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
