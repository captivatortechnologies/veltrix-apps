import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildIntuneClient } from '../../lib/intune'
import { attachDriftActor, veltrixActorLogins } from '../../lib/intuneAuditLog'
import {
  formatCustomSettings,
  readLiveAppGroupType,
  readLiveAssignment,
  readLiveCustomSettings,
  readLiveTargetedApps,
  sameCustomSettings,
  sameGroups,
} from './appConfig'
import { getAppConfig, listAppConfigs } from './deploy'
import { extractAppConfigSpecs, policyKey } from './validate'

/**
 * Detect drift between the deployed app configuration policies and the live
 * tenant. A declared policy that no longer exists is critical drift; custom
 * settings (compared order-insensitively by name), the app group / targeted apps,
 * or an assignment group that differs from the declared configuration is warning
 * drift. Only state the canvas declared is compared, so server-managed fields are
 * never reported as drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildIntuneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built

  const specs = extractAppConfigSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  // Veltrix's own app-only deploys appear under the app registration identity —
  // excluded so attribution reflects the MANUAL change, not a Veltrix deploy.
  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  try {
    const live = await listAppConfigs(client)
    const byName = new Map(live.filter((p) => p.displayName && p.id).map((p) => [policyKey(p.displayName as string), p]))

    for (const spec of specs) {
      const before = diffs.length
      const livePolicy = byName.get(policyKey(spec.name))
      if (!livePolicy || !livePolicy.id) {
        diffs.push({ field: `policy:${spec.name}`, expected: 'exists', actual: 'missing', severity: 'critical' })
        await attachDriftActor(client, diffs.slice(before), { targetName: spec.name, excludeActorLogins })
        continue
      }

      const full = await getAppConfig(client, livePolicy.id)
      if (!full) continue

      const haveSettings = readLiveCustomSettings(full)
      if (!sameCustomSettings(spec.customSettings, haveSettings)) {
        diffs.push({
          field: `${spec.name}.customSettings`,
          expected: formatCustomSettings(spec.customSettings),
          actual: formatCustomSettings(haveSettings),
          severity: 'warning',
        })
      }

      const haveGroupType = readLiveAppGroupType(full)
      if (spec.appGroupType !== haveGroupType) {
        diffs.push({ field: `${spec.name}.appGroupType`, expected: spec.appGroupType, actual: haveGroupType, severity: 'warning' })
      }

      if (spec.appGroupType === 'selectedPublicApps') {
        const haveApps = readLiveTargetedApps(full, spec.platform)
        if (!sameGroups(spec.targetedApps, haveApps)) {
          diffs.push({ field: `${spec.name}.targetedApps`, expected: spec.targetedApps.join(', ') || 'none', actual: haveApps.join(', ') || 'none', severity: 'warning' })
        }
      }

      const wantA = spec.assignment
      const haveA = readLiveAssignment(full)
      if (!sameGroups(wantA.includeGroupIds, haveA.includeGroupIds)) {
        diffs.push({ field: `${spec.name}.includeGroups`, expected: wantA.includeGroupIds.join(', ') || 'none', actual: haveA.includeGroupIds.join(', ') || 'none', severity: 'warning' })
      }
      if (!sameGroups(wantA.excludeGroupIds, haveA.excludeGroupIds)) {
        diffs.push({ field: `${spec.name}.excludeGroups`, expected: wantA.excludeGroupIds.join(', ') || 'none', actual: haveA.excludeGroupIds.join(', ') || 'none', severity: 'warning' })
      }
      if (Boolean(wantA.allUsers) !== haveA.allUsers) {
        diffs.push({ field: `${spec.name}.allUsers`, expected: String(Boolean(wantA.allUsers)), actual: String(haveA.allUsers), severity: 'warning' })
      }

      // Attribute every diff this policy produced to the last human change (once);
      // a no-op (no query) when the policy did not drift.
      await attachDriftActor(client, diffs.slice(before), { targetId: livePolicy.id, targetName: spec.name, excludeActorLogins })
    }
  } catch (error) {
    diffs.push({ field: 'intune', expected: 'reachable', actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`, severity: 'critical' })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
