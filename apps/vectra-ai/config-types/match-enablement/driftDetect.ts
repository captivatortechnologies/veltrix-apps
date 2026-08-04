import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildVectraApiBase, buildAuthHeader, getJson } from '../../lib/vectraApi'
import { enabledFromGet, normalizeBool } from './_shared'

/**
 * Drift for match-enablement: compare the declared enabled flag against the live
 * sensor state, matched by device_serial. Best-effort — a sensor whose state can't
 * be read (missing / transient error) is skipped rather than raising false drift.
 * Read-only: GET /vectra-match/enablement?device_serial={serial}.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const base = buildVectraApiBase(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  for (const item of items) {
    const deviceSerial = String(item.fields.device_serial ?? '').trim()
    if (!deviceSerial) continue

    let actual: boolean | null
    try {
      actual = enabledFromGet(
        await getJson<unknown>(`${base}/vectra-match/enablement?device_serial=${encodeURIComponent(deviceSerial)}`, headers),
      )
    } catch {
      continue
    }
    if (actual == null) continue

    const expected = normalizeBool(item.fields.enabled)
    if (expected !== actual) {
      diffs.push({ field: `${deviceSerial}.enabled`, expected, actual, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
