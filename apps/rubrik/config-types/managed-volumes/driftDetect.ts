import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { rubrikConnect, getJson, resolveServiceAccount } from '../../lib/rubrikApi'
import {
  buildManagedVolumeBody,
  findManagedVolumeByName,
  managedVolumesFromList,
  normalizeName,
  summarizeManagedVolume,
  type RubrikManagedVolume,
} from './_shared'

/**
 * Drift for Managed Volumes: compare channel count, volume size, application tag,
 * subnet and export host patterns we declare against the live MV in Rubrik.
 * Best-effort — an MV that can't be matched (missing / transient error) is skipped
 * rather than raising false drift. Read-only: GET /api/internal/managed_volume.
 * FLAG: verify against a live Rubrik CDM.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!resolveServiceAccount(credential)) return { hasDrift: false, diffs }

  let conn
  try {
    conn = await rubrikConnect(component, credential, settings)
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't connect, no drift asserted
  }

  let live
  try {
    live = managedVolumesFromList(await getJson<unknown>(conn, '/api/internal/managed_volume'))
  } catch {
    return { hasDrift: false, diffs }
  }

  // Channels/size are provisioned at creation (immutable), so a mismatch there is
  // a critical, unrecoverable-in-place drift; export scope is a softer warning.
  const FIELD_SEVERITY: Record<string, DriftDiff['severity']> = {
    channels: 'critical',
    sizeBytes: 'critical',
    applicationTag: 'warning',
    subnet: 'warning',
    hostPatterns: 'info',
  }

  for (const item of items) {
    const name = normalizeName(item.fields.name)
    const match = findManagedVolumeByName(live, name)
    if (!match) continue

    const expected = summarizeManagedVolume(buildManagedVolumeBody(item.fields) as RubrikManagedVolume)
    const actual = summarizeManagedVolume(match)

    for (const key of Object.keys(FIELD_SEVERITY)) {
      const e = expected[key] ?? ''
      const a = actual[key] ?? ''
      if (e !== a) {
        diffs.push({ field: `${name}.${key}`, expected: e || '(empty)', actual: a || '(empty)', severity: FIELD_SEVERITY[key] })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
