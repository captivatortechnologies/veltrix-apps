import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildAutomoxClient } from '../../lib/automoxApi'
import { listPolicies, getPolicyById, findPolicyByName, type AutomoxPolicy } from '../lib/automoxPolicies'
import { extractPolicySpecs, buildPatchConfiguration } from './_shared'

const POLICY_TYPE = 'patch' as const

/**
 * Detect drift between the deployed Policy configuration and the live org.
 * Re-finds each declared policy by name (scoped to `policy_type_name: patch`)
 * and diffs the managed state: existence (critical); schedule (days/time),
 * and auto_patch/auto_reboot/notify_user/patch_rule (warning); server_groups
 * and notes (info).
 *
 * Best-effort: if the org can't be read the check reports no drift rather than
 * raising a false positive.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildAutomoxClient(ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const specs = extractPolicySpecs(ctx.deployedConfig).filter((s) => s.name)

  let livePolicies: AutomoxPolicy[]
  try {
    livePolicies = await listPolicies(client)
  } catch {
    return { hasDrift: false, diffs } // best-effort
  }

  for (const spec of specs) {
    const match = findPolicyByName(livePolicies, spec.name, POLICY_TYPE)
    if (!match || !match.id) {
      diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }

    // The list endpoint may omit `configuration`; fetch the detailed policy for config-level drift.
    const live = (await getPolicyById(client, match.id)) ?? match

    if ((live.schedule_days ?? 0) !== spec.scheduleDays) {
      diffs.push({
        field: `${spec.name}.schedule_days`,
        expected: String(spec.scheduleDays),
        actual: String(live.schedule_days ?? 0),
        severity: 'warning',
      })
    }
    if (spec.scheduleDays > 0 && (live.schedule_time ?? '') !== spec.scheduleTime) {
      diffs.push({
        field: `${spec.name}.schedule_time`,
        expected: spec.scheduleTime,
        actual: live.schedule_time ?? 'not set',
        severity: 'warning',
      })
    }

    const liveServerGroups = [...(live.server_groups ?? [])].sort((a, b) => a - b)
    const declaredServerGroups = [...spec.serverGroups].sort((a, b) => a - b)
    if (JSON.stringify(liveServerGroups) !== JSON.stringify(declaredServerGroups)) {
      diffs.push({
        field: `${spec.name}.server_groups`,
        expected: declaredServerGroups.join(', ') || '(none)',
        actual: liveServerGroups.join(', ') || '(none)',
        severity: 'info',
      })
    }

    if ((live.notes ?? '') !== spec.notes) {
      diffs.push({ field: `${spec.name}.notes`, expected: 'as declared', actual: 'changed in Automox', severity: 'info' })
    }

    const liveConfig = live.configuration ?? {}
    const builtConfig = buildPatchConfiguration(spec)
    if (!builtConfig.error) {
      for (const field of ['auto_patch', 'auto_reboot', 'notify_user', 'patch_rule'] as const) {
        const expected = builtConfig.configuration[field]
        const actual = liveConfig[field]
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          diffs.push({
            field: `${spec.name}.configuration.${field}`,
            expected: String(expected),
            actual: actual === undefined ? 'not set' : String(actual),
            severity: 'warning',
          })
        }
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
