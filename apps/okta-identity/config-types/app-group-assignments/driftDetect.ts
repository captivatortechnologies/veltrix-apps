import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient } from '../../lib/okta'
import { getAssignment } from './deploy'
import { extractAppGroupAssignmentSpecs, parseJsonObject } from './validate'

/**
 * Detect drift between the deployed app-group assignment configuration and the
 * live Okta org. Each declared (appId, groupId) assignment is re-fetched and its
 * authored fields are compared:
 *   - existence — a missing assignment is CRITICAL (the group was unassigned)
 *   - priority  — WARNING; only compared when authored (blank lets Okta assign)
 *   - profile   — WARNING; SUBSET comparison so app-injected defaults do not read
 *                 as drift; only compared when authored
 * Server-managed readOnly fields (id, created, lastUpdated, _links, _embedded)
 * are never modeled so they cannot read as drift. Unmanaged assignments on the
 * app are never inspected — this only tracks the declared pairs.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractAppGroupAssignmentSpecs(ctx.deployedConfig).filter((s) => s.appId && s.groupId)

  for (const spec of specs) {
    const label = `${spec.appId}:${spec.groupId}`
    try {
      const live = await getAssignment(client, spec.appId, spec.groupId)

      if (!live) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      // priority — only diff when the canvas authored one (blank means Okta owns
      // it, so a server value is not drift).
      if (spec.priority !== undefined) {
        const livePriority = typeof live.priority === 'number' ? live.priority : undefined
        if (spec.priority !== livePriority) {
          diffs.push({
            field: `${label}.priority`,
            expected: spec.priority,
            actual: livePriority ?? 'not set',
            severity: 'warning',
          })
        }
      }

      // profile — subset comparison so app-populated defaults do not read as
      // drift; only diff when the canvas authored a profile.
      const authoredProfile = spec.profileJson ? parseJsonObject(spec.profileJson) : null
      if (authoredProfile) {
        const liveProfile = (live.profile as Record<string, unknown> | undefined) ?? {}
        if (!isSubset(authoredProfile, liveProfile)) {
          diffs.push({
            field: `${label}.profile`,
            expected: stableStringify(authoredProfile),
            actual: stableStringify(liveProfile),
            severity: 'warning',
          })
        }
      }
    } catch (error) {
      diffs.push({
        field: label,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

/**
 * True when every key in `expected` is present in `actual` with an equal value.
 * Objects recurse; arrays and primitives compare by stable stringify. Lets a
 * declared profile subset match a live object that also carries app defaults, so
 * those defaults do not read as drift.
 */
function isSubset(expected: unknown, actual: unknown): boolean {
  if (expected === null || typeof expected !== 'object') {
    return stableStringify(expected) === stableStringify(actual)
  }
  if (Array.isArray(expected)) {
    return stableStringify(expected) === stableStringify(actual)
  }
  if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) return false
  const exp = expected as Record<string, unknown>
  const act = actual as Record<string, unknown>
  return Object.keys(exp).every((key) => isSubset(exp[key], act[key]))
}

/** Deterministic JSON stringify with recursively sorted object keys. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}
