import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient, sameSet } from '../../lib/falcon'
import { currentGroupIds, findPolicyByName } from '../../lib/policyAdapter'
import { attachDriftActor, veltrixActorLogins } from '../lib/crowdstrikeAudit'
import {
  DEVICE_CONTROL_ENDPOINTS,
  asSettingsObject,
  extractDeviceControlSpecs,
  parseDeviceControlSettings,
} from './validate'

/**
 * Detect drift between the deployed device control policy configuration and the
 * live tenant state. Looks up each declared policy and diffs enablement,
 * declared settings, host group assignments, and description.
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

  const specs = extractDeviceControlSpecs(ctx.deployedConfig).filter((s) => s.name)

  for (const spec of specs) {
    const before = diffs.length
    try {
      const live = await findPolicyByName(
        client,
        DEVICE_CONTROL_ENDPOINTS,
        spec.name,
        spec.platform,
      )

      if (!live) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      // Enablement decides whether the policy enforces anything
      if (live.enabled !== spec.enabled) {
        diffs.push({
          field: `${spec.name}.enabled`,
          expected: spec.enabled,
          actual: live.enabled ?? false,
          severity: 'critical',
        })
      }

      // Declared settings vs live values — compare only the keys the canvas
      // declares (device classes not listed keep their tenant values).
      const { settings: declared } = parseDeviceControlSettings(spec.settingsRaw)
      if (declared) {
        const liveSettings = asSettingsObject(live.settings)
        if (!liveSettings || !matchesDeclared(declared, liveSettings)) {
          diffs.push({
            field: `${spec.name}.settings`,
            expected: JSON.stringify(declared),
            actual: JSON.stringify(liveSettings ? pickKeys(liveSettings, Object.keys(declared)) : null),
            severity: 'warning',
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

/**
 * Recursively test whether every value the canvas DECLARES is present and equal
 * in the live object. Extra live keys — and device classes the canvas does not
 * list — are not drift. Object arrays that carry an `id` (classes, exceptions)
 * match by id so Falcon returning them in a different order is not drift.
 */
function matchesDeclared(declared: unknown, live: unknown): boolean {
  if (Array.isArray(declared)) {
    if (!Array.isArray(live)) return false
    if (declared.every((e) => isIdObject(e))) {
      return declared.every((entry) => {
        const id = (entry as { id: string }).id
        const match = live.find((l) => isIdObject(l) && l.id === id)
        return match !== undefined && matchesDeclared(entry, match)
      })
    }
    if (declared.length !== live.length) return false
    return declared.every((entry, index) => matchesDeclared(entry, live[index]))
  }
  if (typeof declared === 'object' && declared !== null) {
    if (typeof live !== 'object' || live === null) return false
    const liveObj = live as Record<string, unknown>
    return Object.entries(declared as Record<string, unknown>).every(([key, value]) =>
      matchesDeclared(value, liveObj[key]),
    )
  }
  return declared === live
}

function isIdObject(value: unknown): value is { id: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { id?: unknown }).id === 'string'
  )
}

function pickKeys(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const picked: Record<string, unknown> = {}
  for (const key of keys) {
    if (key in obj) picked[key] = obj[key]
  }
  return picked
}
