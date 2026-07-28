import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildIntuneClient } from '../../lib/intune'
import { attachDriftActor, veltrixActorLogins } from '../../lib/intuneAuditLog'
import { MANAGED_FIELDS, hasAnyAssignment, readLiveAssignment, readLiveTargetedApps } from './appProtection'
import { getProtection, listProtections } from './deploy'
import { extractProtectionSpecs, policyKey } from './validate'

/** Compare two id sets order-insensitively. */
function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(a)
  return b.every((id) => set.has(id))
}

/** The expected/actual value of a managed field, or undefined when the checkbox default should be sent. */
function expectedValue(kind: string, value: unknown): boolean | number | string | undefined {
  if (kind === 'checkbox') return value === true
  return value as boolean | number | string | undefined
}

/**
 * Detect drift between the deployed Android app protection policies and the live
 * tenant. A declared policy that no longer exists is critical drift; a declared
 * field value, the targeted app set (for selectedPublicApps) or an assignment
 * group that differs from the declared configuration is warning drift. Only fields
 * the canvas actually declared are compared.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildIntuneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built

  const specs = extractProtectionSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  // Veltrix's own app-only deploys appear under the app registration identity —
  // excluded so attribution reflects the MANUAL change, not a Veltrix deploy.
  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  try {
    const live = await listProtections(client)
    const byName = new Map(live.filter((p) => p.displayName && p.id).map((p) => [policyKey(p.displayName as string), p]))

    for (const spec of specs) {
      const before = diffs.length
      const livePolicy = byName.get(policyKey(spec.name))
      if (!livePolicy || !livePolicy.id) {
        diffs.push({ field: `policy:${spec.name}`, expected: 'exists', actual: 'missing', severity: 'critical' })
        await attachDriftActor(client, diffs.slice(before), { targetName: spec.name, excludeActorLogins })
        continue
      }

      const full = await getProtection(client, livePolicy.id)
      if (!full) continue

      for (const f of MANAGED_FIELDS) {
        const declared = spec.settings[f.key]
        if (f.kind !== 'checkbox' && declared === undefined) continue
        const want = expectedValue(f.kind, declared)
        const have = full[f.key]
        if (want !== have) {
          diffs.push({ field: `${spec.name}.${f.key}`, expected: String(want), actual: have === undefined || have === null ? 'unset' : String(have), severity: 'warning' })
        }
      }

      const wantType = spec.appGroupType
      const haveType = typeof full.appGroupType === 'string' ? full.appGroupType : 'unset'
      if (wantType !== haveType) {
        diffs.push({ field: `${spec.name}.appGroupType`, expected: wantType, actual: haveType, severity: 'warning' })
      }

      if (spec.appGroupType === 'selectedPublicApps') {
        const haveApps = readLiveTargetedApps(full)
        if (!sameSet(spec.targetedApps, haveApps)) {
          diffs.push({ field: `${spec.name}.targetedApps`, expected: spec.targetedApps.join(', ') || 'none', actual: haveApps.join(', ') || 'none', severity: 'warning' })
        }
      }

      // Compare assignments only when the canvas declares targets — when it declares
      // none, deploy preserves manual assignments, so they must not read as drift.
      if (hasAnyAssignment(spec.assignment)) {
        const wantA = spec.assignment
        const haveA = readLiveAssignment(full)
        if (!sameSet(wantA.includeGroupIds, haveA.includeGroupIds)) {
          diffs.push({ field: `${spec.name}.includeGroups`, expected: wantA.includeGroupIds.join(', ') || 'none', actual: haveA.includeGroupIds.join(', ') || 'none', severity: 'warning' })
        }
        if (!sameSet(wantA.excludeGroupIds, haveA.excludeGroupIds)) {
          diffs.push({ field: `${spec.name}.excludeGroups`, expected: wantA.excludeGroupIds.join(', ') || 'none', actual: haveA.excludeGroupIds.join(', ') || 'none', severity: 'warning' })
        }
        if (Boolean(wantA.allUsers) !== haveA.allUsers) {
          diffs.push({ field: `${spec.name}.allUsers`, expected: String(Boolean(wantA.allUsers)), actual: String(haveA.allUsers), severity: 'warning' })
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
