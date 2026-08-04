import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildFleetUrl, buildAuthHeader } from '../../lib/fleetApi'
import { normalizeItem, groupByTeam, listProfilesForTeam, downloadProfileContentBase64 } from './_shared'

/**
 * Drift for configuration profiles: per team scope, compare the SET of
 * declared profile names against the live list (missing/unexpected), then for
 * every declared profile that IS live, download and compare its content.
 * Matching is by NAME — for Windows/DDM profiles Fleet's live `name` is the
 * declared `displayName`; for .mobileconfig profiles it's the profile's own
 * embedded PayloadDisplayName, so keeping the canvas `name` field aligned with
 * that is on the operator. Best-effort — a profile that can't be read is
 * skipped rather than raising false drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const rawItems = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const base = buildFleetUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const items = rawItems.map((item) => normalizeItem(item.fields)).filter((item) => item.name)
  const groups = groupByTeam(items)

  for (const [teamId, teamItems] of groups) {
    const scopeLabel = teamId === undefined ? 'Unassigned' : `team ${teamId}`
    const live = await listProfilesForTeam(base, headers, teamId)
    const liveByName = new Map(live.filter((p) => p.name).map((p) => [p.name as string, p]))
    const declaredNames = new Set(teamItems.map((item) => item.name))

    for (const item of teamItems) {
      const liveProfile = liveByName.get(item.name)
      if (!liveProfile) {
        diffs.push({ field: `${scopeLabel}.${item.name}`, expected: 'present', actual: 'missing', severity: 'warning' })
        continue
      }
      const liveContentBase64 = await downloadProfileContentBase64(base, headers, liveProfile.profile_uuid)
      if (liveContentBase64 === null) continue // best-effort: skip a profile we can't download
      const expectedBase64 = Buffer.from(item.profileContent, 'utf8').toString('base64')
      if (liveContentBase64 !== expectedBase64) {
        diffs.push({ field: `${scopeLabel}.${item.name}.content`, expected: '(declared content)', actual: '(live content differs)', severity: 'warning' })
      }
    }

    for (const [name] of liveByName) {
      if (!declaredNames.has(name)) {
        diffs.push({ field: `${scopeLabel}.${name}`, expected: 'absent (not declared)', actual: 'present in Fleet', severity: 'info' })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
