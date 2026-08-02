import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildAutomoxClient } from '../../lib/automoxApi'
import { listServerGroups, getServerGroupById } from './deploy'
import { extractServerGroupSpecs, findServerGroupByName, boolToTriState, type AutomoxServerGroup } from './_shared'

/**
 * Detect drift between the deployed Server Group configuration and the live
 * org. Re-finds each declared group by name and diffs the managed state:
 * existence (critical); refresh_interval / parent_server_group_id / WSUS &
 * OS-update enforcement (warning); ui_color, notes and linked policies (info).
 *
 * Best-effort: if the org can't be read the check reports no drift rather than
 * raising a false positive.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildAutomoxClient(ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const specs = extractServerGroupSpecs(ctx.deployedConfig).filter((s) => s.name)

  let liveGroups: AutomoxServerGroup[]
  try {
    liveGroups = await listServerGroups(client)
  } catch {
    return { hasDrift: false, diffs } // best-effort
  }

  for (const spec of specs) {
    const match = findServerGroupByName(liveGroups, spec.name)
    if (!match || !match.id) {
      diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }

    const live = (await getServerGroupById(client, match.id)) ?? match

    if ((live.refresh_interval ?? 0) !== spec.refreshInterval) {
      diffs.push({
        field: `${spec.name}.refresh_interval`,
        expected: String(spec.refreshInterval),
        actual: String(live.refresh_interval ?? 'not set'),
        severity: 'warning',
      })
    }
    if ((live.parent_server_group_id ?? null) !== spec.parentServerGroupId) {
      diffs.push({
        field: `${spec.name}.parent_server_group_id`,
        expected: String(spec.parentServerGroupId),
        actual: String(live.parent_server_group_id ?? 'not set'),
        severity: 'warning',
      })
    }
    if (boolToTriState(live.enable_os_auto_update) !== spec.enableOsAutoUpdate) {
      diffs.push({
        field: `${spec.name}.enable_os_auto_update`,
        expected: spec.enableOsAutoUpdate,
        actual: boolToTriState(live.enable_os_auto_update),
        severity: 'warning',
      })
    }
    if (boolToTriState(live.enable_wsus) !== spec.enableWsus) {
      diffs.push({
        field: `${spec.name}.enable_wsus`,
        expected: spec.enableWsus,
        actual: boolToTriState(live.enable_wsus),
        severity: 'warning',
      })
    }

    if ((live.ui_color ?? '') !== spec.uiColor) {
      diffs.push({ field: `${spec.name}.ui_color`, expected: spec.uiColor || '(none)', actual: live.ui_color || '(none)', severity: 'info' })
    }
    if ((live.notes ?? '') !== spec.notes) {
      diffs.push({ field: `${spec.name}.notes`, expected: 'as declared', actual: 'changed in Automox', severity: 'info' })
    }

    const livePolicies = [...(live.policies ?? [])].sort((a, b) => a - b)
    const declaredPolicies = [...spec.policyIds].sort((a, b) => a - b)
    if (JSON.stringify(livePolicies) !== JSON.stringify(declaredPolicies)) {
      diffs.push({
        field: `${spec.name}.policies`,
        expected: declaredPolicies.join(', ') || '(none)',
        actual: livePolicies.join(', ') || '(none)',
        severity: 'info',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
