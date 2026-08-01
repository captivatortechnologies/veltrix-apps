import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildVectraApiBase, buildAuthHeader, getJson } from '../../lib/vectraApi'
import { proxiesFromList, findProxy, considerProxyOf, normalizeBool } from './_shared'

/**
 * Drift for proxies: compare the considerProxy flag we declare against the live
 * proxy in Vectra, matched by address. Best-effort — a proxy that can't be matched
 * (missing / transient error) is skipped rather than raising false drift. Read-only:
 * GET /proxies. Verify against a live Vectra brain.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const base = buildVectraApiBase(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let live
  try {
    live = proxiesFromList(await getJson<unknown>(`${base}/proxies`, headers))
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read proxies, no drift asserted
  }

  for (const item of items) {
    const address = String(item.fields.address ?? '').trim()
    const match = findProxy(live, address)
    if (!match) continue

    const expected = normalizeBool(item.fields.considerProxy)
    const actual = considerProxyOf(match)
    if (expected !== actual) {
      diffs.push({ field: `${address}.considerProxy`, expected, actual, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
