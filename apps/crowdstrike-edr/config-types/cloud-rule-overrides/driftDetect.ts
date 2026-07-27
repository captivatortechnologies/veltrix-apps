import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient } from '../../lib/falcon'
import { attachDriftActor, veltrixActorLogins, type ModifiedResource } from '../lib/crowdstrikeAudit'
import { findOverride } from './deploy'
import { extractOverrideSpecs, type LiveRuleOverride, type OverrideSpec } from './validate'

/**
 * Detect drift between the deployed rule override configuration and the live
 * tenant state. Reads each declared override by rule id and diffs the managed
 * fields (override type/details, scope, expiration).
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const excludeActorLogins = veltrixActorLogins(ctx.credential)
  const specs = extractOverrideSpecs(ctx.deployedConfig).filter((s) => s.ruleId)

  for (const spec of specs) {
    const label = spec.crn ? `${spec.ruleId} (${spec.crn})` : spec.ruleId
    const before = diffs.length
    try {
      const live = await findOverride(client, spec.ruleId, spec.crn)

      if (!live) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      diffs.push(...diffOverride(spec, live))
      attachDriftActor(diffs.slice(before), overrideActorResource(live), { excludeActorLogins })
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

function diffOverride(spec: OverrideSpec, live: LiveRuleOverride): DriftDiff[] {
  const diffs: DriftDiff[] = []
  const label = spec.ruleId

  if ((live.override_type ?? '') !== spec.overrideType) {
    diffs.push({
      field: `${label}.overrideType`,
      expected: spec.overrideType,
      actual: live.override_type ?? 'not set',
      severity: 'critical',
    })
  }

  if ((spec.overrideDetails ?? '') !== (live.overrides_details ?? '')) {
    diffs.push({
      field: `${label}.overrideDetails`,
      expected: spec.overrideDetails ?? 'not set',
      actual: live.overrides_details ?? 'not set',
      severity: 'warning',
    })
  }

  if ((spec.targetRegion ?? '') !== (live.target_region ?? '')) {
    diffs.push({
      field: `${label}.targetRegion`,
      expected: spec.targetRegion ?? 'not set',
      actual: live.target_region ?? 'not set',
      severity: 'warning',
    })
  }

  if (spec.expiresAt && !sameInstant(live.expires_at, spec.expiresAt)) {
    diffs.push({
      field: `${label}.expiresAt`,
      expected: spec.expiresAt,
      actual: live.expires_at ?? 'not set',
      severity: 'warning',
    })
  }

  return diffs
}

/** Bridge a live override's modifier fields onto the shape crowdstrikeAudit reads. */
function overrideActorResource(live: LiveRuleOverride): ModifiedResource {
  return {
    modified_by: live.modified_by,
    modified_on: live.modified_at ?? live.updated_at ?? live.modified_timestamp,
  }
}

/** Compare timestamps by instant, tolerating formatting differences. */
function sameInstant(a: string | undefined, b: string): boolean {
  if (!a) return false
  const parsedA = Date.parse(a)
  const parsedB = Date.parse(b)
  if (Number.isNaN(parsedA) || Number.isNaN(parsedB)) return a === b
  return parsedA === parsedB
}
