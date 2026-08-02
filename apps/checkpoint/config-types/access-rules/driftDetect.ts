import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildCheckpointClient } from '../../lib/checkpointApi'
import { sameStringSet } from '../lib/checkpointShared'
import { listAllRules } from './deploy'
import { extractAccessRuleSpecs, liveActionName, liveTrackType, memberNames, ruleGroupKey, ruleKey, type LiveAccessRule } from './validate'

/**
 * Detect drift between the deployed access-rule configuration and the live
 * rulebase. Re-finds each declared rule by name within its (layer, package)
 * and diffs the managed fields: a missing rule or a changed action is
 * critical drift; a changed match condition (source/destination/service),
 * track, enabled state or install-on is a warning. Position drift is NOT
 * evaluated (rule-number is a volatile ordinal, not a stable "expected
 * position" to diff against — see README). Read-only.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildCheckpointClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built

  const specs = extractAccessRuleSpecs(ctx.deployedConfig).filter((s) => s.name && s.layer)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  const login = await client.login()
  if (login.error) return { hasDrift: false, diffs: [] }

  try {
    const liveByGroup = new Map<string, Map<string, LiveAccessRule>>()
    for (const spec of specs) {
      const groupKey = ruleGroupKey(spec.layer, spec.package)
      if (liveByGroup.has(groupKey)) continue
      const live = await listAllRules(client, spec.layer, spec.package)
      liveByGroup.set(groupKey, new Map(live.filter((r) => r.name).map((r) => [ruleKey(r.name as string), r])))
    }

    for (const spec of specs) {
      const found = liveByGroup.get(ruleGroupKey(spec.layer, spec.package))?.get(ruleKey(spec.name))
      const label = `${spec.layer}/${spec.name}`

      if (!found) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      const liveAction = liveActionName(found.action)
      if (liveAction && liveAction !== spec.action) {
        diffs.push({ field: `${label}.action`, expected: spec.action, actual: liveAction, severity: 'critical' })
      }
      const liveTrack = liveTrackType(found.track)
      if (liveTrack && liveTrack !== spec.track) {
        diffs.push({ field: `${label}.track`, expected: spec.track, actual: liveTrack, severity: 'warning' })
      }
      if (found.enabled != null && found.enabled !== spec.enabled) {
        diffs.push({ field: `${label}.enabled`, expected: spec.enabled, actual: found.enabled, severity: 'warning' })
      }

      const wantSource = spec.source.length > 0 ? spec.source : ['Any']
      if (!sameStringSet(memberNames(found.source), wantSource)) {
        diffs.push({
          field: `${label}.source`,
          expected: wantSource.join(', '),
          actual: memberNames(found.source).join(', ') || '(none)',
          severity: 'warning',
        })
      }
      const wantDestination = spec.destination.length > 0 ? spec.destination : ['Any']
      if (!sameStringSet(memberNames(found.destination), wantDestination)) {
        diffs.push({
          field: `${label}.destination`,
          expected: wantDestination.join(', '),
          actual: memberNames(found.destination).join(', ') || '(none)',
          severity: 'warning',
        })
      }
      const wantService = spec.service.length > 0 ? spec.service : ['Any']
      if (!sameStringSet(memberNames(found.service), wantService)) {
        diffs.push({
          field: `${label}.service`,
          expected: wantService.join(', '),
          actual: memberNames(found.service).join(', ') || '(none)',
          severity: 'warning',
        })
      }
      if (spec.installOn.length > 0 && !sameStringSet(memberNames(found['install-on']), spec.installOn)) {
        diffs.push({
          field: `${label}.installOn`,
          expected: spec.installOn.join(', '),
          actual: memberNames(found['install-on']).join(', ') || '(none)',
          severity: 'warning',
        })
      }
      if (spec.comments || found.comments) {
        const liveComments = found.comments ?? ''
        if (liveComments !== spec.comments) {
          diffs.push({ field: `${label}.comments`, expected: spec.comments, actual: liveComments, severity: 'warning' })
        }
      }
    }
  } catch {
    diffs.push({ field: 'checkpoint', expected: 'reachable', actual: 'unreachable', severity: 'critical' })
  } finally {
    await client.logout()
  }

  return { hasDrift: diffs.length > 0, diffs }
}
