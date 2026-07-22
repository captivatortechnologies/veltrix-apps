import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient, sameSet } from '../../lib/falcon'
import { attachDriftActor, veltrixActorLogins } from '../lib/crowdstrikeAudit'
import { currentGroupIds, findPreventionPolicy } from './deploy'
import {
  extractPolicySpecs,
  flattenLiveSettings,
  parsePolicySettings,
  type PolicySetting,
} from './validate'

/**
 * Detect drift between the deployed prevention policy configuration and the
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

  const specs = extractPolicySpecs(ctx.deployedConfig).filter((s) => s.name)

  for (const spec of specs) {
    const before = diffs.length
    try {
      const live = await findPreventionPolicy(client, spec.name, spec.platform)

      if (!live) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      // Enablement decides whether the policy protects anything
      if (live.enabled !== spec.enabled) {
        diffs.push({
          field: `${spec.name}.enabled`,
          expected: spec.enabled,
          actual: live.enabled ?? false,
          severity: 'critical',
        })
      }

      // Declared settings vs live values
      const { settings: declared } = parsePolicySettings(spec.settingsRaw)
      const liveSettings = new Map(flattenLiveSettings(live).map((s) => [s.id, s.value]))
      for (const setting of declared) {
        const liveValue = liveSettings.get(setting.id)
        if (!liveValue) {
          diffs.push({
            field: `${spec.name}.settings.${setting.id}`,
            expected: JSON.stringify(setting.value),
            actual: 'not present on policy',
            severity: 'warning',
          })
          continue
        }
        if (!settingMatches(setting, liveValue)) {
          // A protection toggle that should be on but is off leaves hosts exposed
          const declaredOn = setting.value.enabled === true
          const liveOff = liveValue.enabled === false
          diffs.push({
            field: `${spec.name}.settings.${setting.id}`,
            expected: JSON.stringify(setting.value),
            actual: JSON.stringify(pickKeys(liveValue, Object.keys(setting.value))),
            severity: declaredOn && liveOff ? 'critical' : 'warning',
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

/** Compare only the keys the canvas declares — extra live keys are not drift. */
function settingMatches(declared: PolicySetting, live: Record<string, unknown>): boolean {
  return Object.entries(declared.value).every(([key, value]) => live[key] === value)
}

function pickKeys(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const picked: Record<string, unknown> = {}
  for (const key of keys) {
    if (key in obj) picked[key] = obj[key]
  }
  return picked
}
