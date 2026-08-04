import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildCheckpointClient,
  checkpointErrorMessage,
  isNotFoundError,
  MAX_PAGE_SIZE,
  type CheckpointClient,
} from '../../lib/checkpointApi'
import { buildPositionPayload } from '../lib/checkpointShared'
import {
  extractAccessRuleSpecs,
  liveActionName,
  liveTrackType,
  memberNames,
  ruleGroupKey,
  ruleKey,
  type AccessRuleSpec,
  type LiveAccessRule,
} from './validate'

// Re-exported for API stability — this config type's position logic now lives
// in the shared module (nat-rules uses the identical top/bottom/above/below shape).
export { buildPositionPayload }

export interface RollbackEntry {
  itemId?: string
  name: string
  layer: string
  package: string
  uid?: string
  /** Whether the rule existed before THIS deploy — set-access-rule (true) vs add-access-rule (false). */
  existed: boolean
  /** Prior managed FIELD values (not position — see README's ordering-rollback limitation). */
  prior?: Record<string, unknown>
}

/** Fields common to add-access-rule and set-access-rule — everything except identity/layer/position. */
export function buildRuleFieldsBody(spec: AccessRuleSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: spec.name,
    action: spec.action,
    track: { type: spec.track },
    enabled: spec.enabled,
    // Sent explicitly (not omitted) even when empty so a declared "Any" is
    // re-asserted on every deploy — set-access-rule only touches provided
    // fields, so omitting would never heal a manually-narrowed rule back open.
    source: spec.source.length > 0 ? spec.source : ['Any'],
    'source-negate': spec.sourceNegate,
    destination: spec.destination.length > 0 ? spec.destination : ['Any'],
    'destination-negate': spec.destinationNegate,
    service: spec.service.length > 0 ? spec.service : ['Any'],
    'service-negate': spec.serviceNegate,
  }
  if (spec.comments) body.comments = spec.comments
  // install-on is only sent when declared: the exact default token Check
  // Point substitutes for an unset install-on ("Policy Targets" in
  // SmartConsole) was not independently verified against a live server this
  // session, so an undeclared install-on is left as whatever the rule
  // already has rather than guessing a literal value to force it back to.
  if (spec.installOn.length > 0) body['install-on'] = spec.installOn
  return body
}

/** Snapshot a live rule's managed FIELD values (not position) into a set-access-rule body, for rollback. */
export function snapshotLive(live: LiveAccessRule): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: live.name,
    action: liveActionName(live.action) || 'Drop',
    track: { type: liveTrackType(live.track) || 'None' },
    enabled: live.enabled ?? true,
    source: memberNames(live.source).length > 0 ? memberNames(live.source) : ['Any'],
    'source-negate': live['source-negate'] ?? false,
    destination: memberNames(live.destination).length > 0 ? memberNames(live.destination) : ['Any'],
    'destination-negate': live['destination-negate'] ?? false,
    service: memberNames(live.service).length > 0 ? memberNames(live.service) : ['Any'],
    'service-negate': live['service-negate'] ?? false,
  }
  if (live.comments) body.comments = live.comments
  const installOn = memberNames(live['install-on'])
  if (installOn.length > 0) body['install-on'] = installOn
  return body
}

/**
 * Page through show-access-rulebase for ONE (layer, package) target and
 * return only its FLAT, top-level access-rule entries — access-section
 * headers (and any rules nested inside one) are skipped. See README:
 * managing rules inside a named Section is out of scope for this version.
 */
export async function listAllRules(client: CheckpointClient, layer: string, pkg: string): Promise<LiveAccessRule[]> {
  const rules: LiveAccessRule[] = []
  let offset = 0
  for (;;) {
    const params: Record<string, unknown> = { name: layer, limit: MAX_PAGE_SIZE, offset, 'details-level': 'standard' }
    if (pkg) params.package = pkg
    const res = await client.call<{ rulebase?: LiveAccessRule[]; total?: number }>('show-access-rulebase', params)
    if (!res.ok) throw new Error(`show-access-rulebase "${layer}" failed: ${checkpointErrorMessage(res)}`)
    const entries = res.data?.rulebase ?? []
    rules.push(...entries.filter((e) => e.type === 'access-rule'))
    const total = res.data?.total ?? entries.length
    offset += entries.length
    if (entries.length === 0 || offset >= total) break
  }
  return rules
}

async function loadPriorEntries(ctx: DeployContext): Promise<RollbackEntry[]> {
  try {
    const prev = await ctx.platform.getLatestDeployment(ctx.canvas.canvasId, { status: 'SUCCEEDED' })
    const data = prev?.rollbackData as { entries?: RollbackEntry[] } | undefined
    return Array.isArray(data?.entries) ? (data!.entries as RollbackEntry[]) : []
  } catch {
    return []
  }
}

function identifyRule(layer: string, pkg: string, uid: string | undefined, name: string): Record<string, unknown> {
  const params: Record<string, unknown> = { layer }
  if (pkg) params.package = pkg
  if (uid) params.uid = uid
  else params.name = name
  return params
}

/**
 * Deploy Check Point access-control rules via the Management API.
 *
 * Identity is the rule `name`, matched WITHIN its declared (layer, package)
 * rulebase — one canvas can span several layers/packages. Rules are
 * processed in CANVAS DECLARATION ORDER (top to bottom) because an
 * above/below position references another rule/section BY NAME that must
 * already exist. Missing rules are created (add-access-rule); existing ones
 * are updated to the declared field values AND re-asserted to their declared
 * position (set-access-rule + new-position) — so manual reordering also
 * self-heals on every deploy. Rules THIS app created previously but no
 * longer declares are removed. The whole reconciliation runs inside ONE
 * session: publish on success, discard the whole session on any error.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildCheckpointClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client, host } = built

  const login = await client.login()
  if (login.error) return { success: false, message: login.error }

  const specs = extractAccessRuleSpecs(ctx.canvas).filter((s) => s.name && s.layer)
  const entries: RollbackEntry[] = []
  let created = 0
  let updated = 0
  let deleted = 0

  try {
    const liveByGroup = new Map<string, Map<string, LiveAccessRule>>()
    for (const spec of specs) {
      const groupKey = ruleGroupKey(spec.layer, spec.package)
      if (liveByGroup.has(groupKey)) continue
      const live = await listAllRules(client, spec.layer, spec.package)
      liveByGroup.set(groupKey, new Map(live.filter((r) => r.name).map((r) => [ruleKey(r.name as string), r])))
    }
    const prior = await loadPriorEntries(ctx)

    for (const spec of specs) {
      const groupKey = ruleGroupKey(spec.layer, spec.package)
      const match = liveByGroup.get(groupKey)?.get(ruleKey(spec.name)) ?? null
      const fields = buildRuleFieldsBody(spec)
      const position = buildPositionPayload(spec)

      if (match) {
        const body = { ...identifyRule(spec.layer, spec.package, match.uid, spec.name), ...fields, 'new-position': position }
        const res = await client.call('set-access-rule', body)
        if (!res.ok) throw new Error(`set-access-rule "${spec.name}" failed: ${checkpointErrorMessage(res)}`)
        entries.push({
          itemId: spec.itemId,
          name: spec.name,
          layer: spec.layer,
          package: spec.package,
          uid: match.uid,
          existed: true,
          prior: snapshotLive(match),
        })
        updated++
      } else {
        const body = { layer: spec.layer, ...(spec.package ? { package: spec.package } : {}), ...fields, position }
        const res = await client.call<{ uid?: string }>('add-access-rule', body)
        if (!res.ok) throw new Error(`add-access-rule "${spec.name}" failed: ${checkpointErrorMessage(res)}`)
        entries.push({
          itemId: spec.itemId,
          name: spec.name,
          layer: spec.layer,
          package: spec.package,
          uid: res.data?.uid,
          existed: false,
        })
        created++
      }
    }

    const declaredKeys = new Set(specs.map((s) => `${ruleGroupKey(s.layer, s.package)}::${ruleKey(s.name)}`))
    for (const p of prior) {
      if (p.existed || declaredKeys.has(`${ruleGroupKey(p.layer, p.package)}::${ruleKey(p.name)}`)) continue
      const res = await client.call('delete-access-rule', identifyRule(p.layer, p.package, p.uid, p.name))
      if (!res.ok && !isNotFoundError(res)) {
        throw new Error(`delete-access-rule "${p.name}" failed: ${checkpointErrorMessage(res)}`)
      }
      deleted++
    }

    const publish = await client.publish()
    if (!publish.ok) throw new Error(`publish failed: ${checkpointErrorMessage(publish)}`)

    await client.logout()
    return {
      success: true,
      message:
        `Reconciled ${specs.length} Check Point access rule(s) on ${host}: ` +
        `${created} created, ${updated} updated, ${deleted} removed.`,
      artifacts: { host, created, updated, deleted },
      rollbackData: { entries },
    }
  } catch (error) {
    await client.discard()
    await client.logout()
    return {
      success: false,
      message: `Deploy failed — session changes were discarded: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
