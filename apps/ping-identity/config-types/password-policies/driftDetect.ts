import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildPingOneClient, stableStringify } from '../../lib/pingOne'
import { buildPasswordPolicyBody, findPasswordPolicyByName } from './deploy'
import { extractPasswordPolicySpecs, type LivePasswordPolicy } from './validate'

/** Scalar boolean fields - undefined/absent normalizes to false on both sides. */
const BOOLEAN_FIELDS = ['default', 'excludesCommonlyUsedPasswords', 'excludesProfileData', 'notSimilarToCurrent'] as const

/** Scalar string fields - undefined/absent normalizes to an empty string on both sides. */
const STRING_FIELDS = ['description'] as const

/** Scalar optional numeric fields - compared as-is (undefined/absent stays distinct from 0). */
const NUMBER_FIELDS = ['maxAgeDays', 'minAgeDays', 'minComplexity', 'minUniqueCharacters', 'maxRepeatedCharacters'] as const

/** Sub-object fields - compared key by key so a diff points at e.g. "<name>.length.min". */
const NESTED_FIELDS = ['history', 'length', 'lockout', 'minCharacters', 'alphabetSequenceRule', 'numberSequenceRule'] as const

/**
 * Detect drift between the deployed password-policy configuration and the
 * live PingOne environment. Each declared policy is re-found by exact name
 * and every modeled field is compared: booleans/description/optional numbers
 * at the top level, and history/length/lockout/minCharacters/
 * alphabetSequenceRule/numberSequenceRule key-by-key (so a diff reads e.g.
 * "MyPolicy.length.min"). Server-managed fields (id, environment, createdAt,
 * updatedAt, _links, populationCount) are never modeled so they cannot read
 * as drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildPingOneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractPasswordPolicySpecs(ctx.deployedConfig).filter((s) => s.name)

  for (const spec of specs) {
    try {
      const live = await findPasswordPolicyByName(client, spec.name)

      if (!live) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      const expected = buildPasswordPolicyBody(spec)

      for (const key of BOOLEAN_FIELDS) {
        const expectedVal = expected[key] === true
        const actualVal = live[key as keyof LivePasswordPolicy] === true
        if (expectedVal !== actualVal) {
          diffs.push({
            field: `${spec.name}.${key}`,
            expected: expectedVal,
            actual: actualVal,
            severity: 'critical',
          })
        }
      }

      for (const key of STRING_FIELDS) {
        const expectedVal = typeof expected[key] === 'string' ? (expected[key] as string) : ''
        const liveRaw = live[key as keyof LivePasswordPolicy]
        const actualVal = typeof liveRaw === 'string' ? liveRaw : ''
        if (expectedVal !== actualVal) {
          diffs.push({
            field: `${spec.name}.${key}`,
            expected: expectedVal || 'not set',
            actual: actualVal || 'not set',
            severity: 'critical',
          })
        }
      }

      for (const key of NUMBER_FIELDS) {
        const expectedVal = expected[key]
        const actualVal = live[key as keyof LivePasswordPolicy]
        if (stableStringify(expectedVal ?? null) !== stableStringify(actualVal ?? null)) {
          diffs.push({
            field: `${spec.name}.${key}`,
            expected: expectedVal ?? 'not set',
            actual: actualVal ?? 'not set',
            severity: 'critical',
          })
        }
      }

      for (const key of NESTED_FIELDS) {
        const expectedObj = expected[key] as Record<string, unknown> | undefined
        const liveObj = live[key as keyof LivePasswordPolicy] as Record<string, unknown> | undefined | null
        if (!expectedObj && !liveObj) continue

        const subKeys = new Set<string>([
          ...Object.keys(expectedObj ?? {}),
          ...Object.keys(liveObj ?? {}),
        ])
        for (const subKey of subKeys) {
          const expectedVal = expectedObj?.[subKey]
          const actualVal = liveObj?.[subKey]
          if (stableStringify(expectedVal ?? null) !== stableStringify(actualVal ?? null)) {
            diffs.push({
              field: `${spec.name}.${key}.${subKey}`,
              expected: expectedVal ?? 'not set',
              actual: actualVal ?? 'not set',
              severity: 'critical',
            })
          }
        }
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
