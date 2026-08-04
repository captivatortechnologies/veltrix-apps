import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildThehiveUrl, buildAuthHeader, listProfiles } from '../../lib/thehiveApi'
import { findProfile, parsePermissions, profilesFromList, type Profile } from './_shared'

/**
 * Drift for profiles: compare the declared permission set against the live
 * profile in TheHive (order-independent). Best-effort — a profile that can't be
 * matched (missing / transient error) is skipped rather than raising false
 * drift. Read-only. Verify against a live TheHive (see README, v4 vs v5).
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const base = buildThehiveUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let live: Profile[]
  try {
    live = profilesFromList(await listProfiles<Profile>(base, headers))
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read profiles, no drift asserted
  }

  for (const item of items) {
    const name = String(item.fields.name ?? '').trim()
    if (!name) continue
    const match = findProfile(live, name)
    if (!match) {
      diffs.push({ field: name, expected: 'present', actual: 'missing', severity: 'warning' })
      continue
    }

    const expected = parsePermissions((item.fields.permissions as string) ?? '').sort()
    const actual = (Array.isArray(match.permissions) ? match.permissions.map(String) : []).sort()
    if (expected.join(',') !== actual.join(',')) {
      diffs.push({ field: `${name}.permissions`, expected: expected.join(', '), actual: actual.join(', '), severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
