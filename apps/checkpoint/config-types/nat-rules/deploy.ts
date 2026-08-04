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
  extractNatRuleSpecs,
  liveInstallOnNames,
  liveNatMemberName,
  natPackageKey,
  natRuleKey,
  type LiveNatRule,
  type NatRuleSpec,
} from './validate'

export interface RollbackEntry {
  itemId?: string
  name: string
  package: string
  uid?: string
  /** Whether the rule existed before THIS deploy — set-nat-rule (true) vs add-nat-rule (false). */
  existed: boolean
  /** Prior managed FIELD values (not position — same limitation as access-rules, see README). */
  prior?: Record<string, unknown>
}

/** Fields common to add-nat-rule and set-nat-rule — everything except identity/package/position. */
export function buildNatRuleFieldsBody(spec: NatRuleSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: spec.name,
    enabled: spec.enabled,
    method: spec.method,
    // Sent explicitly (not omitted) even when blank so a declared "Any"/
    // "Original" is re-asserted on every deploy — set-nat-rule only touches
    // provided fields, so omitting would never heal a manually-narrowed rule.
    'original-source': spec.originalSource || 'Any',
    'original-destination': spec.originalDestination || 'Any',
    'original-service': spec.originalService || 'Any',
    'translated-source': spec.translatedSource || 'Original',
    'translated-destination': spec.translatedDestination || 'Original',
    'translated-service': spec.translatedService || 'Original',
  }
  if (spec.comments) body.comments = spec.comments
  if (spec.installOn.length > 0) body['install-on'] = spec.installOn
  return body
}

/** Snapshot a live NAT rule's managed FIELD values (not position) into a set-nat-rule body, for rollback. */
export function snapshotLive(live: LiveNatRule): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: live.name,
    enabled: live.enabled ?? true,
    method: live.method || 'hide',
    'original-source': liveNatMemberName(live['original-source']) || 'Any',
    'original-destination': liveNatMemberName(live['original-destination']) || 'Any',
    'original-service': liveNatMemberName(live['original-service']) || 'Any',
    'translated-source': liveNatMemberName(live['translated-source']) || 'Original',
    'translated-destination': liveNatMemberName(live['translated-destination']) || 'Original',
    'translated-service': liveNatMemberName(live['translated-service']) || 'Original',
  }
  if (live.comments) body.comments = live.comments
  const installOn = liveInstallOnNames(live['install-on'])
  if (installOn.length > 0) body['install-on'] = installOn
  return body
}

/**
 * Page through show-nat-rulebase for ONE package and return only its FLAT
 * `type: "nat-rule"` entries that are NOT `auto-generated` — automatic NAT
 * rules (derived from a host/network/address-range's own nat-settings) are
 * never matched, updated or deleted by this config type; they are a
 * DIFFERENT object-level surface (see README).
 */
export async function listAllNatRules(client: CheckpointClient, pkg: string): Promise<LiveNatRule[]> {
  const rules: LiveNatRule[] = []
  let offset = 0
  for (;;) {
    const res = await client.call<{ rulebase?: LiveNatRule[]; total?: number }>('show-nat-rulebase', {
      package: pkg,
      limit: MAX_PAGE_SIZE,
      offset,
      'details-level': 'standard',
    })
    if (!res.ok) throw new Error(`show-nat-rulebase "${pkg}" failed: ${checkpointErrorMessage(res)}`)
    const entries = res.data?.rulebase ?? []
    rules.push(...entries.filter((e) => e.type === 'nat-rule' && e['auto-generated'] !== true))
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

function identifyRule(pkg: string, uid: string | undefined, name: string): Record<string, unknown> {
  const params: Record<string, unknown> = { package: pkg }
  if (uid) params.uid = uid
  else params.name = name
  return params
}

/**
 * Deploy Check Point manual NAT rules via the Management API.
 *
 * Identity is the rule `name`, matched WITHIN its declared policy `package`
 * (NAT rulebases are per-package, not per-layer like access rules). Rules
 * are processed in CANVAS DECLARATION ORDER for the same reason as
 * access-rules: an above/below position references another rule/section BY
 * NAME that must already exist. Missing rules are created (add-nat-rule);
 * existing ones are updated to the declared field values AND re-asserted to
 * their declared position (set-nat-rule + new-position). Automatic NAT rules
 * (object-derived) are never matched, updated, or deleted. Rules THIS app
 * created previously but no longer declares are removed. The whole
 * reconciliation runs inside ONE session: publish on success, discard the
 * whole session on any error.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildCheckpointClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client, host } = built

  const login = await client.login()
  if (login.error) return { success: false, message: login.error }

  const specs = extractNatRuleSpecs(ctx.canvas).filter((s) => s.name && s.package)
  const entries: RollbackEntry[] = []
  let created = 0
  let updated = 0
  let deleted = 0

  try {
    const liveByPackage = new Map<string, Map<string, LiveNatRule>>()
    for (const spec of specs) {
      const pkgKey = natPackageKey(spec.package)
      if (liveByPackage.has(pkgKey)) continue
      const live = await listAllNatRules(client, spec.package)
      liveByPackage.set(pkgKey, new Map(live.filter((r) => r.name).map((r) => [natRuleKey(r.name as string), r])))
    }
    const prior = await loadPriorEntries(ctx)

    for (const spec of specs) {
      const pkgKey = natPackageKey(spec.package)
      const match = liveByPackage.get(pkgKey)?.get(natRuleKey(spec.name)) ?? null
      const fields = buildNatRuleFieldsBody(spec)
      const position = buildPositionPayload(spec)

      if (match) {
        const body = { ...identifyRule(spec.package, match.uid, spec.name), ...fields, 'new-position': position }
        const res = await client.call('set-nat-rule', body)
        if (!res.ok) throw new Error(`set-nat-rule "${spec.name}" failed: ${checkpointErrorMessage(res)}`)
        entries.push({
          itemId: spec.itemId,
          name: spec.name,
          package: spec.package,
          uid: match.uid,
          existed: true,
          prior: snapshotLive(match),
        })
        updated++
      } else {
        const body = { package: spec.package, ...fields, position }
        const res = await client.call<{ uid?: string }>('add-nat-rule', body)
        if (!res.ok) throw new Error(`add-nat-rule "${spec.name}" failed: ${checkpointErrorMessage(res)}`)
        entries.push({ itemId: spec.itemId, name: spec.name, package: spec.package, uid: res.data?.uid, existed: false })
        created++
      }
    }

    const declaredKeys = new Set(specs.map((s) => `${natPackageKey(s.package)}::${natRuleKey(s.name)}`))
    for (const p of prior) {
      if (p.existed || declaredKeys.has(`${natPackageKey(p.package)}::${natRuleKey(p.name)}`)) continue
      const res = await client.call('delete-nat-rule', identifyRule(p.package, p.uid, p.name))
      if (!res.ok && !isNotFoundError(res)) {
        throw new Error(`delete-nat-rule "${p.name}" failed: ${checkpointErrorMessage(res)}`)
      }
      deleted++
    }

    const publish = await client.publish()
    if (!publish.ok) throw new Error(`publish failed: ${checkpointErrorMessage(publish)}`)

    await client.logout()
    return {
      success: true,
      message:
        `Reconciled ${specs.length} Check Point NAT rule(s) on ${host}: ` +
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
