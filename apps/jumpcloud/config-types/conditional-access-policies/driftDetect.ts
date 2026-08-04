import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildJumpCloudClient } from '../../lib/jumpcloudApi'
import { listAuthnPolicies, getAuthnPolicyById } from './deploy'
import { extractConditionalAccessPolicySpecs, findAuthnPolicyByName, parseJsonObjectField, type JumpCloudAuthnPolicy } from './_shared'

/**
 * Detect drift between the deployed Authentication Policy configuration and the
 * live org. Re-finds each declared policy by name and diffs: existence
 * (critical), disabled / monitorOnly / action / mfaRequired (warning), and the
 * declared targets / conditions JSON (info, structural comparison).
 *
 * Best-effort: if the org can't be read the check reports no drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildJumpCloudClient(ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const specs = extractConditionalAccessPolicySpecs(ctx.deployedConfig).filter((s) => s.name)

  let livePolicies: JumpCloudAuthnPolicy[]
  try {
    livePolicies = await listAuthnPolicies(client)
  } catch {
    return { hasDrift: false, diffs } // best-effort
  }

  for (const spec of specs) {
    const match = findAuthnPolicyByName(livePolicies, spec.name)
    if (!match) {
      diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }

    const live = match.id ? (await getAuthnPolicyById(client, match.id)) ?? match : match

    if (Boolean(live.disabled) !== spec.disabled) {
      diffs.push({ field: `${spec.name}.disabled`, expected: String(spec.disabled), actual: String(Boolean(live.disabled)), severity: 'warning' })
    }
    if (Boolean(live.monitorOnly) !== spec.monitorOnly) {
      diffs.push({ field: `${spec.name}.monitorOnly`, expected: String(spec.monitorOnly), actual: String(Boolean(live.monitorOnly)), severity: 'warning' })
    }

    const liveAction = String(live.effect?.action ?? '')
    if (liveAction !== spec.action) {
      diffs.push({ field: `${spec.name}.action`, expected: spec.action, actual: liveAction || '(unset)', severity: 'warning' })
    }
    const liveMfaRequired = Boolean(live.effect?.obligations?.mfa?.required)
    if (liveMfaRequired !== spec.mfaRequired) {
      diffs.push({ field: `${spec.name}.mfaRequired`, expected: String(spec.mfaRequired), actual: String(liveMfaRequired), severity: 'warning' })
    }

    const targets = parseJsonObjectField(spec.targetsRaw, 'targets')
    if (!targets.error && stringify(live.targets ?? {}) !== stringify(targets.value)) {
      diffs.push({ field: `${spec.name}.targets`, expected: stringify(targets.value), actual: stringify(live.targets ?? {}), severity: 'info' })
    }
    const conditions = parseJsonObjectField(spec.conditionsRaw, 'conditions')
    if (!conditions.error && stringify(live.conditions ?? {}) !== stringify(conditions.value)) {
      diffs.push({ field: `${spec.name}.conditions`, expected: stringify(conditions.value), actual: stringify(live.conditions ?? {}), severity: 'info' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

/** Stable string form of a JSON value for structural comparison. */
function stringify(value: unknown): string {
  try {
    return JSON.stringify(sortKeysDeep(value))
  } catch {
    return String(value)
  }
}

/** Recursively sort object keys so structurally-equal objects stringify identically. */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, sortKeysDeep(v)]),
    )
  }
  return value
}
