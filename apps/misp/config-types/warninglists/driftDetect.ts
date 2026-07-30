import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildMispUrl, buildAuthHeader, getJson } from '../../lib/mispApi'
import { warninglistsFromList, findWarninglist, normalizeEnabled } from './_shared'

/**
 * Drift for warninglists: compare the enabled state we declare against the live
 * warninglist in MISP. Best-effort — a warninglist that can't be matched (missing /
 * transient error) is skipped rather than raising false drift. Read-only:
 * GET /warninglists. Verify against a live MISP 2.4 instance.
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
    live = warninglistsFromList(await getJson<unknown>(`${base}/warninglists`, headers))
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read warninglists, no drift asserted
  }

  for (const item of items) {
    const name = String(item.fields.name ?? '').trim()
    const match = findWarninglist(live, name)
    if (!match) continue

    const expectedEnabled = normalizeEnabled(item.fields.state)
    const actualEnabled = normalizeEnabled(match.enabled)
    if (actualEnabled !== expectedEnabled) {
      diffs.push({ field: `${name}.enabled`, expected: expectedEnabled, actual: actualEnabled, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
