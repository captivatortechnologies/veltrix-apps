import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildPingOneClient, stableStringify } from '../../lib/pingOne'
import { findPopulation } from './deploy'
import { extractPopulationSpecs } from './validate'

/**
 * Detect drift between the deployed population configuration and the live
 * PingOne environment. Each declared population is re-found by name and its
 * meaningful fields are compared: description, default, preferredLanguage,
 * alternativeIdentifiers (order-insensitive) and passwordPolicy.id.
 *
 * defaultIdentityProvider is intentionally NOT diffed here - it lives behind a
 * separate GET /populations/{id}/defaultIdentityProvider call, and checking it
 * for every population would double the round-trips per drift sweep. Drift
 * detection is deliberately scoped to the main population object.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildPingOneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractPopulationSpecs(ctx.deployedConfig).filter((s) => s.name)

  for (const spec of specs) {
    try {
      const live = await findPopulation(client, spec.name)

      if (!live) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      const liveDescription = live.description ?? ''
      const expectedDescription = spec.description ?? ''
      if (expectedDescription !== liveDescription) {
        diffs.push({
          field: `${spec.name}.description`,
          expected: spec.description ?? 'not set',
          actual: live.description ?? 'not set',
          severity: 'warning',
        })
      }

      const liveDefault = live.default === true
      if (spec.default !== liveDefault) {
        diffs.push({
          field: `${spec.name}.default`,
          expected: spec.default,
          actual: liveDefault,
          severity: 'warning',
        })
      }

      const livePreferredLanguage = live.preferredLanguage ?? ''
      const expectedPreferredLanguage = spec.preferredLanguage ?? ''
      if (expectedPreferredLanguage !== livePreferredLanguage) {
        diffs.push({
          field: `${spec.name}.preferredLanguage`,
          expected: spec.preferredLanguage ?? 'not set',
          actual: live.preferredLanguage ?? 'not set',
          severity: 'warning',
        })
      }

      const liveAlternativeIdentifiers = Array.isArray(live.alternativeIdentifiers)
        ? live.alternativeIdentifiers
        : []
      const expectedIdentifiersKey = stableStringify([...spec.alternativeIdentifiers].sort())
      const liveIdentifiersKey = stableStringify([...liveAlternativeIdentifiers].sort())
      if (expectedIdentifiersKey !== liveIdentifiersKey) {
        diffs.push({
          field: `${spec.name}.alternativeIdentifiers`,
          expected: spec.alternativeIdentifiers,
          actual: liveAlternativeIdentifiers,
          severity: 'warning',
        })
      }

      const livePasswordPolicyId = live.passwordPolicy?.id ?? ''
      const expectedPasswordPolicyId = spec.passwordPolicyId ?? ''
      if (expectedPasswordPolicyId !== livePasswordPolicyId) {
        diffs.push({
          field: `${spec.name}.passwordPolicyId`,
          expected: spec.passwordPolicyId ?? 'not set',
          actual: livePasswordPolicyId || 'not set',
          severity: 'warning',
        })
      }
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
