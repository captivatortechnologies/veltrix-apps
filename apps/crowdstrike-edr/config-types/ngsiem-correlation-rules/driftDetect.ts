import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient } from '../../lib/falcon'
import { findEntityByIdentity, type LiveEntity } from '../../lib/entityAdapter'
import { attachDriftActor, veltrixActorLogins, type ModifiedResource } from '../lib/crowdstrikeAudit'
import {
  CORRELATION_RULE_ENDPOINTS,
  liveCreateCase,
  liveFilter,
  liveFrequency,
  liveTriggerMode,
} from './deploy'
import {
  extractCorrelationRuleSpecs,
  SEVERITY_NUMBER_TO_NAME,
  SEVERITY_TO_NUMBER,
  type CorrelationRuleSpec,
  type CorrelationSeverity,
} from './validate'

/**
 * Detect drift between the deployed correlation-rule configuration and the live
 * tenant state. Looks up each declared rule by name and diffs the managed fields,
 * including the CQL search, severity, status, trigger mode, case creation, and
 * schedule.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  // Connection identity our own deploys are recorded under — excluded so
  // attribution reflects the MANUAL change, not a Veltrix deploy.
  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  const specs = extractCorrelationRuleSpecs(ctx.deployedConfig).filter((s) => s.name)

  for (const spec of specs) {
    const label = spec.name
    const before = diffs.length
    try {
      const live = await findEntityByIdentity(client, CORRELATION_RULE_ENDPOINTS, spec.name)

      if (!live) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      diffs.push(...diffRule(spec, live))

      // Attribute every diff this rule produced to Falcon's recorded last
      // modifier (once) — no-op when nothing drifted or the change was ours.
      attachDriftActor(diffs.slice(before), ruleActorResource(live), { excludeActorLogins })
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

function diffRule(spec: CorrelationRuleSpec, live: LiveEntity): DriftDiff[] {
  const diffs: DriftDiff[] = []
  const label = spec.name

  // search (CQL) decides what the rule detects — the most consequential field
  const liveSearch = liveFilter(live)
  if (liveSearch !== spec.search) {
    diffs.push({
      field: `${label}.search`,
      expected: spec.search,
      actual: liveSearch || 'not set',
      severity: 'critical',
    })
  }

  // status — an active rule silently turned inactive stops all detections
  const liveStatus = (typeof live.status === 'string' ? live.status : '').toLowerCase()
  if (liveStatus !== spec.status) {
    diffs.push({
      field: `${label}.status`,
      expected: spec.status,
      actual: liveStatus || 'not set',
      severity: 'critical',
    })
  }

  const expectedSeverity = SEVERITY_TO_NUMBER[spec.severity as CorrelationSeverity]
  const liveSeverity = typeof live.severity === 'number' ? live.severity : undefined
  if (liveSeverity !== expectedSeverity) {
    diffs.push({
      field: `${label}.severity`,
      expected: spec.severity,
      actual: liveSeverity !== undefined ? SEVERITY_NUMBER_TO_NAME[liveSeverity] ?? String(liveSeverity) : 'not set',
      severity: 'warning',
    })
  }

  const liveTrigger = liveTriggerMode(live)
  if (liveTrigger !== spec.triggerMode) {
    diffs.push({
      field: `${label}.triggerMode`,
      expected: spec.triggerMode,
      actual: liveTrigger || 'not set',
      severity: 'warning',
    })
  }

  const liveCase = liveCreateCase(live)
  if (liveCase !== spec.createCase) {
    diffs.push({
      field: `${label}.createCase`,
      expected: spec.createCase,
      actual: liveCase,
      severity: 'warning',
    })
  }

  if (spec.frequency) {
    const liveFreq = liveFrequency(live)
    if (liveFreq !== spec.frequency) {
      diffs.push({
        field: `${label}.frequency`,
        expected: spec.frequency,
        actual: liveFreq || 'not set',
        severity: 'warning',
      })
    }
  }

  return diffs
}

/**
 * Map a live rule's modifier fields onto the shape crowdstrikeAudit reads. The
 * exact modifier field names on a correlation rule are unverified, so several
 * candidates are bridged; attribution degrades gracefully (to "—") when none is
 * present, per the best-effort audit contract.
 */
function ruleActorResource(live: LiveEntity): ModifiedResource {
  const str = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() ? value : undefined
  return {
    modified_by: str(live.modified_by) ?? str(live.updated_by) ?? str(live.last_updated_by),
    modified_timestamp: str(live.modified_timestamp) ?? str(live.updated_timestamp),
    modified_on: str(live.modified_on) ?? str(live.last_updated) ?? str(live.updated_on),
  }
}
