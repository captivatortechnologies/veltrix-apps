import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient, type FalconClient } from '../../lib/falcon'
import { findEntityByIdentity, type LiveEntity } from '../../lib/entityAdapter'
import {
  attachDriftActor,
  veltrixActorLogins,
  type ModifiedResource,
} from '../lib/crowdstrikeAudit'
import {
  RECON_RULE_ENDPOINTS,
  liveActionKey,
  listActionsForRule,
} from './deploy'
import { actionKey, extractReconRuleSpecs, parseActions, type ReconRuleSpec } from './validate'

/**
 * Detect drift between the deployed Recon monitoring rule configuration and the
 * live tenant state. Looks up each declared rule by name and diffs the mutable
 * fields (plus the immutable topic, whose mismatch signals the rule was
 * recreated) and the declared notification actions.
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

  const specs = extractReconRuleSpecs(ctx.deployedConfig).filter((s) => s.name)

  for (const spec of specs) {
    const label = spec.name
    const before = diffs.length
    try {
      const live = await findEntityByIdentity(client, RECON_RULE_ENDPOINTS, spec.name)

      if (!live) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      diffs.push(...diffRuleFields(spec, live))
      diffs.push(...(await diffActions(client, spec, live)))

      // Attribute every diff this rule produced to Falcon's recorded last
      // modifier (once) — no-op when nothing drifted or the change was ours.
      attachDriftActor(diffs.slice(before), toModifiedResource(live), { excludeActorLogins })
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

function diffRuleFields(spec: ReconRuleSpec, live: LiveEntity): DriftDiff[] {
  const diffs: DriftDiff[] = []
  const label = spec.name

  // topic is immutable via the API — a mismatch means the rule was recreated or
  // is a different rule that happens to share the name.
  const liveTopic = (str(live.topic) ?? '').toUpperCase()
  if (liveTopic !== spec.topic) {
    diffs.push({
      field: `${label}.topic`,
      expected: spec.topic,
      actual: liveTopic || 'not set',
      severity: 'warning',
    })
  }

  // filter decides what the rule matches — the most consequential field.
  const liveFilter = str(live.filter) ?? ''
  if (liveFilter !== spec.filter) {
    diffs.push({
      field: `${label}.filter`,
      expected: spec.filter,
      actual: liveFilter || 'not set',
      severity: 'critical',
    })
  }

  const livePriority = (str(live.priority) ?? '').toLowerCase()
  if (livePriority !== spec.priority) {
    diffs.push({
      field: `${label}.priority`,
      expected: spec.priority,
      actual: livePriority || 'not set',
      severity: 'info',
    })
  }

  const livePermissions = (str(live.permissions) ?? '').toLowerCase()
  if (livePermissions !== spec.permissions) {
    diffs.push({
      field: `${label}.permissions`,
      expected: spec.permissions,
      actual: livePermissions || 'not set',
      severity: 'warning',
    })
  }

  const liveBreach = live.breach_monitoring_enabled
  if (typeof liveBreach === 'boolean' && liveBreach !== spec.breachMonitoring) {
    diffs.push({
      field: `${label}.breachMonitoring`,
      expected: spec.breachMonitoring,
      actual: liveBreach,
      severity: 'info',
    })
  }

  const liveSubstring = live.substring_matching_enabled
  if (typeof liveSubstring === 'boolean' && liveSubstring !== spec.substringMatching) {
    diffs.push({
      field: `${label}.substringMatching`,
      expected: spec.substringMatching,
      actual: liveSubstring,
      severity: 'info',
    })
  }

  return diffs
}

async function diffActions(
  client: FalconClient,
  spec: ReconRuleSpec,
  live: LiveEntity,
): Promise<DriftDiff[]> {
  const { actions } = parseActions(spec.actionsRaw)
  if (!spec.actionsRaw) return []

  const label = spec.name
  const liveActions = live.id ? await listActionsForRule(client, live.id) : []
  const liveByKey = new Map(liveActions.map((a) => [liveActionKey(a), a]))
  const declaredKeys = new Set(actions.map((a) => actionKey(a)))
  const diffs: DriftDiff[] = []

  for (const action of actions) {
    const match = liveByKey.get(actionKey(action))
    if (!match) {
      diffs.push({
        field: `${label}.actions.${action.recipients.join(',')}`,
        expected: `${action.frequency} ${action.type} notification`,
        actual: 'not present on rule',
        severity: 'warning',
      })
      continue
    }
    if ((match.content_format ?? '') !== action.contentFormat) {
      diffs.push({
        field: `${label}.actions.${action.recipients.join(',')}.contentFormat`,
        expected: action.contentFormat,
        actual: str(match.content_format) ?? 'not set',
        severity: 'info',
      })
    }
  }

  // Actions on the live rule that the config no longer declares.
  for (const action of liveActions) {
    if (!declaredKeys.has(liveActionKey(action))) {
      diffs.push({
        field: `${label}.actions.${(action.recipients ?? []).join(',')}`,
        expected: 'not declared',
        actual: 'present on rule',
        severity: 'info',
      })
    }
  }

  return diffs
}

/**
 * Adapt a live Recon rule to the {modified_by, modified_timestamp} shape the
 * shared audit helper reads. Recon records its last writer as `user_name` /
 * `user_uuid` and the change time as `updated_timestamp` (rather than the
 * `modified_by` / `modified_timestamp` used by the policy APIs), so this maps
 * whichever fields are present — keeping attribution working without a shared
 * helper change.
 */
export function toModifiedResource(live: LiveEntity): ModifiedResource {
  return {
    modified_by:
      str(live.modified_by) ?? str(live.user_name) ?? str(live.user_uuid) ?? str(live.user_id),
    modified_timestamp: str(live.modified_timestamp) ?? str(live.updated_timestamp),
  }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}
