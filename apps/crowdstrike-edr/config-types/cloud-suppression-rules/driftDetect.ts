import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient, sameSet } from '../../lib/falcon'
import { attachDriftActor, veltrixActorLogins, type ModifiedResource } from '../lib/crowdstrikeAudit'
import { findSuppressionRule } from './deploy'
import { extractSuppressionSpecs, type LiveSuppressionRule, type SuppressionSpec } from './validate'

/**
 * Detect drift between the deployed suppression rule configuration and the live
 * tenant state. Looks up each declared rule by name and diffs the managed
 * fields (rule selection, asset scope, reason, expiration, enablement).
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
  const specs = extractSuppressionSpecs(ctx.deployedConfig).filter((s) => s.name)

  for (const spec of specs) {
    const label = spec.name
    const before = diffs.length
    try {
      const live = await findSuppressionRule(client, spec.name)

      if (!live) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      diffs.push(...diffSuppressionRule(spec, live))
      attachDriftActor(diffs.slice(before), suppressionActorResource(live), { excludeActorLogins })
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

function diffSuppressionRule(spec: SuppressionSpec, live: LiveSuppressionRule): DriftDiff[] {
  const diffs: DriftDiff[] = []
  const label = spec.name
  const selection = live.rule_selection_filter ?? {}
  const scope = live.scope_asset_filter ?? {}

  if ((live.rule_selection_type ?? '') !== spec.ruleSelectionType) {
    diffs.push({
      field: `${label}.ruleSelectionType`,
      expected: spec.ruleSelectionType,
      actual: live.rule_selection_type ?? 'not set',
      severity: 'warning',
    })
  }

  diffSet(diffs, `${label}.ruleSeverities`, spec.ruleSeverities, selection.rule_severities)
  diffSet(diffs, `${label}.ruleProviders`, spec.ruleProviders, selection.rule_providers)
  diffSet(diffs, `${label}.ruleServices`, spec.ruleServices, selection.rule_services)
  diffSet(diffs, `${label}.ruleIds`, spec.ruleIds, selection.rule_ids)

  if ((live.scope_type ?? '') !== spec.scopeType) {
    diffs.push({
      field: `${label}.scopeType`,
      expected: spec.scopeType,
      actual: live.scope_type ?? 'not set',
      severity: 'warning',
    })
  }

  diffSet(diffs, `${label}.accountIds`, spec.accountIds, scope.account_ids)
  diffSet(diffs, `${label}.cloudProviders`, spec.cloudProviders, scope.cloud_providers)
  diffSet(diffs, `${label}.regions`, spec.regions, scope.regions)
  diffSet(diffs, `${label}.resourceTypes`, spec.resourceTypes, scope.resource_types)

  if ((spec.suppressionReason ?? '') !== (live.suppression_reason ?? '')) {
    diffs.push({
      field: `${label}.suppressionReason`,
      expected: spec.suppressionReason ?? 'not set',
      actual: live.suppression_reason ?? 'not set',
      severity: 'warning',
    })
  }

  if (spec.expiration && !sameInstant(live.suppression_expiration_date, spec.expiration)) {
    diffs.push({
      field: `${label}.expiration`,
      expected: spec.expiration,
      actual: live.suppression_expiration_date ?? 'not set',
      severity: 'warning',
    })
  }

  // Enablement — compared only when the live rule exposes `disabled`.
  if (typeof live.disabled === 'boolean' && live.disabled !== !spec.enabled) {
    diffs.push({
      field: `${label}.enabled`,
      expected: spec.enabled,
      actual: !live.disabled,
      severity: 'warning',
    })
  }

  return diffs
}

function diffSet(
  diffs: DriftDiff[],
  field: string,
  expected: string[],
  actual: string[] | undefined,
): void {
  const live = actual ?? []
  if (!sameSet(live, expected)) {
    diffs.push({
      field,
      expected: expected.join(', ') || 'none',
      actual: live.join(', ') || 'none',
      severity: 'warning',
    })
  }
}

/** Bridge a live rule's modifier fields onto the shape crowdstrikeAudit reads. */
function suppressionActorResource(live: LiveSuppressionRule): ModifiedResource {
  return {
    modified_by:
      typeof live.modified_by === 'string' ? live.modified_by : live.created_by,
    modified_on: live.last_modified_at ?? live.modified_timestamp,
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
