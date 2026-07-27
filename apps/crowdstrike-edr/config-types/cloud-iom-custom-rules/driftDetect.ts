import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient } from '../../lib/falcon'
import { findEntityByIdentity, type LiveEntity } from '../../lib/entityAdapter'
import { attachDriftActor, veltrixActorLogins } from '../lib/crowdstrikeAudit'
import { CLOUD_IOM_RULE_ENDPOINTS, controlsEqual, liveControls, liveString } from './deploy'
import { extractCloudIomRuleSpecs, parseControls, type CloudIomRuleSpec } from './validate'

/**
 * Detect drift between the deployed IOM custom-rule configuration and the live
 * tenant state. Looks up each declared rule by name and diffs the managed
 * fields, including the Rego logic.
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

  const specs = extractCloudIomRuleSpecs(ctx.deployedConfig).filter((s) => s.name)

  for (const spec of specs) {
    const label = spec.name
    const before = diffs.length
    try {
      const live = await findEntityByIdentity(client, CLOUD_IOM_RULE_ENDPOINTS, spec.name)

      if (!live) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      diffs.push(...diffRule(spec, live))

      // Attribute every diff this rule produced to Falcon's recorded last
      // modifier (once) — no-op when nothing drifted or the change was ours.
      attachDriftActor(diffs.slice(before), live, { excludeActorLogins })
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

function diffRule(spec: CloudIomRuleSpec, live: LiveEntity): DriftDiff[] {
  const diffs: DriftDiff[] = []
  const label = spec.name

  const liveDescription = liveString(live.description) ?? ''
  if (liveDescription !== spec.description) {
    diffs.push({
      field: `${label}.description`,
      expected: spec.description,
      actual: liveDescription || 'not set',
      severity: 'warning',
    })
  }

  // cloud provider / resource type decide what the rule evaluates — most consequential
  const liveProvider = (liveString(live.cloud_provider) ?? '').toLowerCase()
  if (liveProvider !== spec.cloudProvider) {
    diffs.push({
      field: `${label}.cloudProvider`,
      expected: spec.cloudProvider,
      actual: liveProvider || 'not set',
      severity: 'critical',
    })
  }

  const liveResource = liveString(live.resource_type) ?? ''
  if (liveResource !== spec.resourceType) {
    diffs.push({
      field: `${label}.resourceType`,
      expected: spec.resourceType,
      actual: liveResource || 'not set',
      severity: 'critical',
    })
  }

  const liveSeverity = (liveString(live.severity) ?? '').toLowerCase()
  if (liveSeverity !== spec.severity) {
    diffs.push({
      field: `${label}.severity`,
      expected: spec.severity,
      actual: liveSeverity || 'not set',
      severity: 'warning',
    })
  }

  // Only compare logic for a fully-custom rule — an inherited rule's live logic
  // comes from its parent and was never authored here.
  if (spec.logic) {
    const liveLogic = (liveString(live.logic) ?? '').trim()
    if (liveLogic !== spec.logic) {
      diffs.push({
        field: `${label}.logic`,
        expected: 'declared Rego policy',
        actual: liveLogic ? 'modified Rego policy' : 'not set',
        severity: 'critical',
      })
    }
  }

  if (spec.controlsRaw) {
    const specControls = parseControls(spec.controlsRaw).controls
    const live_controls = liveControls(live.controls)
    if (!controlsEqual(specControls, live_controls)) {
      diffs.push({
        field: `${label}.controls`,
        expected: specControls.map((c) => `${c.authority}:${c.code}`).join(', ') || 'none',
        actual: live_controls.map((c) => `${c.authority}:${c.code}`).join(', ') || 'none',
        severity: 'warning',
      })
    }
  }

  if (spec.parentRuleId) {
    const liveParent = liveString(live.parent_rule_id) ?? ''
    if (liveParent !== spec.parentRuleId) {
      diffs.push({
        field: `${label}.parentRuleId`,
        expected: spec.parentRuleId,
        actual: liveParent || 'not set',
        severity: 'warning',
      })
    }
  }

  return diffs
}
