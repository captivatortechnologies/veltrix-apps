import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildJumpCloudClient } from '../../lib/jumpcloudApi'
import { listPolicies, getPolicyById } from './deploy'
import {
  extractPolicySpecs,
  parsePolicyValues,
  findPolicyByName,
  type JumpCloudPolicy,
  type JumpCloudPolicyValue,
} from './_shared'

/**
 * Detect drift between the deployed Policy configuration and the live org.
 * Re-finds each declared policy by name and diffs the managed state: existence
 * (critical), `active` (warning) and each DECLARED config value (info). Only the
 * values the canvas actually declares are compared, so unmanaged template fields
 * never register as drift.
 *
 * Best-effort: if the org can't be read the check reports no drift rather than
 * raising a false positive.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildJumpCloudClient(ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const specs = extractPolicySpecs(ctx.deployedConfig).filter((s) => s.name)

  let livePolicies: JumpCloudPolicy[]
  try {
    livePolicies = await listPolicies(client)
  } catch {
    return { hasDrift: false, diffs } // best-effort
  }

  for (const spec of specs) {
    const match = findPolicyByName(livePolicies, spec.name)
    if (!match) {
      diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }

    // The list endpoint may omit `values`; fetch the detailed policy for value drift.
    const live = match.id ? (await getPolicyById(client, match.id)) ?? match : match

    if (typeof live.active === 'boolean' && live.active !== spec.active) {
      diffs.push({ field: `${spec.name}.active`, expected: String(spec.active), actual: String(live.active), severity: 'warning' })
    }

    const parsed = parsePolicyValues(spec.valuesRaw)
    if (parsed.error) continue // an unparseable declaration is a validate error, not drift
    const liveByKey = indexValues(live.values ?? [])
    for (const declared of parsed.values) {
      const key = String(declared.configFieldID ?? declared.configFieldName ?? '')
      if (!key) continue
      const liveValue = liveByKey.get(key)
      if (liveValue === undefined) {
        diffs.push({ field: `${spec.name}.${key}`, expected: stringify(declared.value), actual: 'not set', severity: 'info' })
      } else if (stringify(liveValue) !== stringify(declared.value)) {
        diffs.push({ field: `${spec.name}.${key}`, expected: stringify(declared.value), actual: stringify(liveValue), severity: 'info' })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

/** Index a policy's live values by configFieldID (falling back to configFieldName). */
function indexValues(values: JumpCloudPolicyValue[]): Map<string, unknown> {
  const map = new Map<string, unknown>()
  for (const v of values) {
    const id = String(v.configFieldID ?? '')
    const name = String(v.configFieldName ?? '')
    if (id) map.set(id, v.value)
    if (name) map.set(name, v.value)
  }
  return map
}

/** Stable string form of a value for comparison (objects compared structurally). */
function stringify(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  return String(value)
}
