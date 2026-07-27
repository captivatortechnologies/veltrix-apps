import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient, sameSet } from '../../lib/falcon'
import { currentGroupIds, findPolicyByName } from '../../lib/policyAdapter'
import { attachDriftActor, veltrixActorLogins } from '../lib/crowdstrikeAudit'
import { SENSOR_UPDATE_ENDPOINTS } from './deploy'
import { extractPolicySpecs, readSensorSettings } from './validate'

/**
 * Detect drift between the deployed sensor update policy configuration and the
 * live tenant state. Looks up each declared policy and diffs enablement, build
 * pinning, uninstall protection, host group assignments, and description.
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

  const specs = extractPolicySpecs(ctx.deployedConfig).filter((s) => s.name)

  for (const spec of specs) {
    const before = diffs.length
    try {
      const live = await findPolicyByName(client, SENSOR_UPDATE_ENDPOINTS, spec.name, spec.platform)

      if (!live) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      // Enablement decides whether the policy governs anything
      if (live.enabled !== spec.enabled) {
        diffs.push({
          field: `${spec.name}.enabled`,
          expected: spec.enabled,
          actual: live.enabled ?? false,
          severity: 'critical',
        })
      }

      const liveSettings = readSensorSettings(live)

      // Build pinning — compared only when the canvas declares a build
      if (spec.build && (liveSettings.build ?? '') !== spec.build) {
        diffs.push({
          field: `${spec.name}.settings.build`,
          expected: spec.build,
          actual: liveSettings.build || 'not set',
          severity: 'warning',
        })
      }

      // Uninstall protection — weakening it (declared protection now off) is critical
      const liveProtection = liveSettings.uninstall_protection ?? 'DISABLED'
      if (liveProtection !== spec.uninstallProtection) {
        const weakened = spec.uninstallProtection === 'ENABLED' && liveProtection !== 'ENABLED'
        diffs.push({
          field: `${spec.name}.settings.uninstall_protection`,
          expected: spec.uninstallProtection,
          actual: liveProtection,
          severity: weakened ? 'critical' : 'warning',
        })
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
