import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildIntuneClient } from '../../lib/intune'
import { attachDriftActor, veltrixActorLogins } from '../../lib/intuneAuditLog'
import {
  COMPLIANCE_FIELDS,
  PLATFORMS,
  hasAnyAssignment,
  normalizeOdataType,
  readLiveAssignment,
  type CompliancePlatform,
} from './compliance'
import { getCompliancePolicy, listCompliancePolicies } from './deploy'
import { extractComplianceSpecs, policyKey } from './validate'

/** Compare two group-id sets order-insensitively. */
function sameGroups(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(a)
  return b.every((id) => set.has(id))
}

/**
 * Detect drift between the deployed compliance policies and the live tenant. A declared
 * policy that no longer exists (or whose platform type changed) is critical drift; a
 * declared field value or assignment group that differs from the declared configuration
 * is warning drift. Only fields the canvas actually declared are compared.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildIntuneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built

  const specs = extractComplianceSpecs(ctx.deployedConfig).filter((s) => s.name && s.platform)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  // Veltrix's own app-only deploys appear under the app registration identity —
  // excluded so attribution reflects the MANUAL change, not a Veltrix deploy.
  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  try {
    const live = await listCompliancePolicies(client)
    const byName = new Map(live.filter((p) => p.displayName && p.id).map((p) => [policyKey(p.displayName as string), p]))

    for (const spec of specs) {
      const before = diffs.length
      const platform = spec.platform as CompliancePlatform
      const livePolicy = byName.get(policyKey(spec.name))
      if (!livePolicy || !livePolicy.id) {
        diffs.push({ field: `policy:${spec.name}`, expected: 'exists', actual: 'missing', severity: 'critical' })
        await attachDriftActor(client, diffs.slice(before), { targetName: spec.name, excludeActorLogins })
        continue
      }

      const wantType = normalizeOdataType(PLATFORMS[platform].odataType)
      const liveType = normalizeOdataType(livePolicy['@odata.type'])
      if (liveType && liveType !== wantType) {
        diffs.push({ field: `${spec.name}.platform`, expected: PLATFORMS[platform].label, actual: liveType, severity: 'critical' })
      }

      const full = await getCompliancePolicy(client, livePolicy.id)
      if (!full) continue

      for (const f of COMPLIANCE_FIELDS) {
        const name = f.graphProp(platform)
        const want = spec.settings[f.key]
        if (!name || want === undefined) continue
        const have = full[name]
        if (want !== have) {
          diffs.push({ field: `${spec.name}.${f.key}`, expected: String(want), actual: have === undefined || have === null ? 'unset' : String(have), severity: 'warning' })
        }
      }

      // Compare assignments only when the canvas declares targets — when it
      // declares none, deploy preserves the live/manual assignments, so they are
      // intentionally NOT managed here and must not read as drift.
      if (hasAnyAssignment(spec.assignment)) {
        const wantA = spec.assignment
        const haveA = readLiveAssignment(full)
        if (!sameGroups(wantA.includeGroupIds, haveA.includeGroupIds)) {
          diffs.push({ field: `${spec.name}.include_groups`, expected: wantA.includeGroupIds.join(', ') || 'none', actual: haveA.includeGroupIds.join(', ') || 'none', severity: 'warning' })
        }
        if (!sameGroups(wantA.excludeGroupIds, haveA.excludeGroupIds)) {
          diffs.push({ field: `${spec.name}.exclude_groups`, expected: wantA.excludeGroupIds.join(', ') || 'none', actual: haveA.excludeGroupIds.join(', ') || 'none', severity: 'warning' })
        }
        if (Boolean(wantA.allDevices) !== haveA.allDevices) {
          diffs.push({ field: `${spec.name}.all_devices`, expected: String(Boolean(wantA.allDevices)), actual: String(haveA.allDevices), severity: 'warning' })
        }
        if (Boolean(wantA.allUsers) !== haveA.allUsers) {
          diffs.push({ field: `${spec.name}.all_users`, expected: String(Boolean(wantA.allUsers)), actual: String(haveA.allUsers), severity: 'warning' })
        }
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
