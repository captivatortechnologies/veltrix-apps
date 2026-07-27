import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient, sameSet } from '../../lib/falcon'
import { currentGroupIds } from '../../lib/policyAdapter'
import { attachDriftActor, veltrixActorLogins } from '../lib/crowdstrikeAudit'
import { findContentUpdatePolicy } from './deploy'
import {
  extractContentUpdatePolicySpecs,
  parseContentUpdateSettings,
  type RingAssignmentSetting,
} from './validate'

/**
 * Detect drift between the deployed content update policy configuration and the
 * live tenant state. Looks up each declared policy and diffs enablement,
 * ring assignment settings, host group assignments, and description.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  // Connection identity our own deploys are recorded under — excluded so
  // attribution reflects the MANUAL change, not a Veltrix deploy.
  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  const specs = extractContentUpdatePolicySpecs(ctx.deployedConfig).filter((s) => s.name)

  for (const spec of specs) {
    const before = diffs.length
    try {
      const live = await findContentUpdatePolicy(client, spec.name)

      if (!live) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      // Enablement decides whether the policy governs its hosts' content rings
      if (live.enabled !== spec.enabled) {
        diffs.push({
          field: `${spec.name}.enabled`,
          expected: spec.enabled,
          actual: live.enabled ?? false,
          severity: 'critical',
        })
      }

      // Declared ring assignments vs live values
      const { settings: declared } = parseContentUpdateSettings(spec.settingsRaw)
      const liveRings = new Map(
        (live.settings?.ring_assignment_settings ?? []).map((r) => [r.id, r]),
      )
      for (const ring of declared?.ring_assignment_settings ?? []) {
        const liveRing = liveRings.get(ring.id)
        if (!liveRing) {
          diffs.push({
            field: `${spec.name}.settings.${ring.id}`,
            expected: JSON.stringify(ring),
            actual: 'not present on policy',
            severity: 'warning',
          })
          continue
        }
        if (!ringMatches(ring, liveRing)) {
          // Content updates paused when they should flow leaves protection stale
          const declaredActive = ring.ring_assignment !== 'pause'
          const livePaused = liveRing.ring_assignment === 'pause'
          diffs.push({
            field: `${spec.name}.settings.${ring.id}`,
            expected: JSON.stringify(ring),
            actual: JSON.stringify({
              ring_assignment: liveRing.ring_assignment,
              delay_hours: liveRing.delay_hours,
            }),
            severity: declaredActive && livePaused ? 'critical' : 'warning',
          })
        }
      }

      // Host group assignments decide which hosts the policy applies to
      const liveGroups = currentGroupIds(live)
      if (!sameSet(liveGroups, spec.hostGroups)) {
        diffs.push({
          field: `${spec.name}.hostGroups`,
          expected: spec.hostGroups.join(', ') || 'none',
          actual: liveGroups.join(', ') || 'none',
          severity: 'warning',
        })
      }

      const liveDescription = (live.description ?? '').trim()
      if ((spec.description ?? '') !== liveDescription) {
        diffs.push({
          field: `${spec.name}.description`,
          expected: spec.description ?? 'not set',
          actual: liveDescription || 'not set',
          severity: 'info',
        })
      }

      // Attribute every diff this policy produced to Falcon's recorded last
      // modifier (once) — no-op when nothing drifted or the change was ours.
      attachDriftActor(diffs.slice(before), live, { excludeActorLogins })
    } catch (error) {
      diffs.push({
        field: spec.name,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

/** Compare only the fields the canvas declares — an unset delay_hours is not drift. */
function ringMatches(declared: RingAssignmentSetting, live: RingAssignmentSetting): boolean {
  if (declared.ring_assignment !== live.ring_assignment) return false
  if (declared.delay_hours !== undefined && declared.delay_hours !== live.delay_hours) return false
  return true
}
