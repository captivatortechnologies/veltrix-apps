import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildCheckpointClient } from '../../lib/checkpointApi'
import { listAllNatRules } from './deploy'
import { extractNatRuleSpecs, liveInstallOnNames, liveNatMemberName, natPackageKey, natRuleKey, type LiveNatRule } from './validate'
import { sameStringSet } from '../lib/checkpointShared'

/**
 * Detect drift between the deployed NAT-rule configuration and the live
 * package rulebase. Re-finds each declared rule by name within its package
 * and diffs the managed fields: a missing rule or a changed translation
 * (method, original source/destination/service, translated
 * source/destination/service) is critical drift; enabled state, install-on
 * and comments are warnings. Automatic NAT rules are never considered (see
 * README). Position drift is not evaluated (same reasoning as access-rules).
 * Read-only.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildCheckpointClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built

  const specs = extractNatRuleSpecs(ctx.deployedConfig).filter((s) => s.name && s.package)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  const login = await client.login()
  if (login.error) return { hasDrift: false, diffs: [] }

  try {
    const liveByPackage = new Map<string, Map<string, LiveNatRule>>()
    for (const spec of specs) {
      const pkgKey = natPackageKey(spec.package)
      if (liveByPackage.has(pkgKey)) continue
      const live = await listAllNatRules(client, spec.package)
      liveByPackage.set(pkgKey, new Map(live.filter((r) => r.name).map((r) => [natRuleKey(r.name as string), r])))
    }

    for (const spec of specs) {
      const found = liveByPackage.get(natPackageKey(spec.package))?.get(natRuleKey(spec.name))
      const label = `${spec.package}/${spec.name}`

      if (!found) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      const liveMethod = found.method || ''
      if (liveMethod && liveMethod !== spec.method) {
        diffs.push({ field: `${label}.method`, expected: spec.method, actual: liveMethod, severity: 'critical' })
      }

      const fieldChecks: Array<[string, string, string]> = [
        ['originalSource', spec.originalSource || 'Any', liveNatMemberName(found['original-source']) || 'Any'],
        ['originalDestination', spec.originalDestination || 'Any', liveNatMemberName(found['original-destination']) || 'Any'],
        ['originalService', spec.originalService || 'Any', liveNatMemberName(found['original-service']) || 'Any'],
        ['translatedSource', spec.translatedSource || 'Original', liveNatMemberName(found['translated-source']) || 'Original'],
        [
          'translatedDestination',
          spec.translatedDestination || 'Original',
          liveNatMemberName(found['translated-destination']) || 'Original',
        ],
        ['translatedService', spec.translatedService || 'Original', liveNatMemberName(found['translated-service']) || 'Original'],
      ]
      for (const [field, expected, actual] of fieldChecks) {
        if (expected !== actual) {
          diffs.push({ field: `${label}.${field}`, expected, actual, severity: 'critical' })
        }
      }

      if (found.enabled != null && found.enabled !== spec.enabled) {
        diffs.push({ field: `${label}.enabled`, expected: spec.enabled, actual: found.enabled, severity: 'warning' })
      }
      if (spec.installOn.length > 0 && !sameStringSet(liveInstallOnNames(found['install-on']), spec.installOn)) {
        diffs.push({
          field: `${label}.installOn`,
          expected: spec.installOn.join(', '),
          actual: liveInstallOnNames(found['install-on']).join(', ') || '(none)',
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
