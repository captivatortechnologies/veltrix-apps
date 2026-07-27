import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildFalconClient,
  falconErrorMessage,
  falconFailure,
  fqlEscape,
  parseEnvelope,
  type FalconClient,
} from '../../lib/falcon'
import {
  extractRuleGroupSpecs,
  parseFirewallRules,
  type FirewallAddress,
  type FirewallPortRange,
  type FirewallRuleGroupSpec,
  type FirewallRuleSpec,
  type LiveFirewallRule,
  type LiveFirewallRuleGroup,
} from './validate'

/**
 * Deploy firewall rule groups to a Falcon tenant via the fwmgr rule-group API.
 *
 * Rule groups are on the /fwmgr/ service, NOT the /policy/entities/* family, so
 * this uses direct FalconClient calls (no policy adapter). Rules are embedded in
 * and managed through the group. For each declared rule group:
 *   - GET   /fwmgr/queries/rule-groups/v1?filter=name:~'…'   — find candidate ids
 *   - GET   /fwmgr/entities/rule-groups/v1?ids=…             — hydrate + capture prior state
 *   - POST  /fwmgr/entities/rule-groups/v1                   — create missing (name/platform/enabled/rules in one call)
 *   - PATCH /fwmgr/entities/rule-groups/v1                   — converge existing via a JSON-patch diff
 *
 * The declared rules are the COMPLETE ordered rule set for the group: on an
 * update, live rules not declared here are removed, so the group converges to
 * exactly what the canvas declares (rule order is precedence).
 *
 * Update contract (verified against CrowdStrike's own Terraform provider): the
 * fwmgr rule-group PATCH is not a plain body merge — it takes RFC-6902 JSON-patch
 * `diff_operations` (diff_type "application/json-patch+json"), the group's
 * `tracking` token echoed back, and parallel `rule_ids`/`rule_versions` arrays
 * describing the FINAL ordered rules (an existing id for an unchanged rule, a
 * `temp_id:N` for a new/changed rule; versions are all 0). Changed rules are
 * expressed as remove(old index, descending)+add(/rules/-, temp_id).
 */
export interface FirewallRuleGroupRollbackEntry {
  name: string
  platform: string
  existed: boolean
  id?: string
  prior?: {
    name?: string
    description?: string
    enabled?: boolean
    /** Full prior rule set (canonical) so rollback can converge the group back. */
    rules: CanonicalRule[]
  }
}

/** Managed rule fields in the shape used for equality, diffing, and rollback capture. */
export interface CanonicalRule {
  name: string
  description: string
  enabled: boolean
  monitor: boolean
  action: string
  direction: string
  protocolWire: string
  addressFamily: string
  localPorts: FirewallPortRange[]
  remotePorts: FirewallPortRange[]
  localAddresses: FirewallAddress[]
  remoteAddresses: FirewallAddress[]
  icmpType: string
  icmpCode: string
  networkLocation: string
}

interface JsonPatchOp {
  op: 'replace' | 'add' | 'remove'
  path: string
  value?: unknown
}

const DIFF_TYPE = 'application/json-patch+json'

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractRuleGroupSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: FirewallRuleGroupRollbackEntry[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const { rules, errors: ruleErrors } = parseFirewallRules(spec.rulesRaw)
      if (ruleErrors.length > 0) {
        throw new Error(`Rule group "${spec.name}": invalid rules — ${ruleErrors[0]}`)
      }
      const desired = rules.map(canonicalFromSpec)

      const existing = await findRuleGroup(client, spec.name, spec.platform)

      if (existing?.id) {
        rollbackState.push({
          name: spec.name,
          platform: spec.platform,
          existed: true,
          id: existing.id,
          prior: {
            name: existing.name,
            description: existing.description ?? '',
            enabled: existing.enabled,
            rules: (existing.rules ?? []).map(canonicalFromLive),
          },
        })

        await convergeRuleGroup(
          client,
          existing,
          { name: spec.name, description: spec.description ?? '', enabled: spec.enabled },
          desired,
        )
      } else {
        const id = await createRuleGroup(client, spec, desired)
        rollbackState.push({ name: spec.name, platform: spec.platform, existed: false, id })
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} firewall rule group(s) to Falcon tenant at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedRuleGroups: deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Firewall rule group deployment failed after ${deployed.length} of ${specs.length} group(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedRuleGroups: deployed },
      rollbackData: { previousState: rollbackState },
    }
  }
}

// --- Transport helpers -------------------------------------------------------

/**
 * Look up a rule group by exact name and platform. The fwmgr query endpoint
 * returns ids only, so this pages the name-contains query, hydrates each
 * candidate, and pins the exact name+platform client-side (a lone
 * case-insensitive match is tolerated).
 */
export async function findRuleGroup(
  client: FalconClient,
  name: string,
  platform: string,
): Promise<LiveFirewallRuleGroup | null> {
  const limit = 500
  const caseInsensitive: LiveFirewallRuleGroup[] = []

  for (let offset = 0; ; offset += limit) {
    const res = await client.request('GET', '/fwmgr/queries/rule-groups/v1', {
      query: { filter: `name:~'${fqlEscape(name)}'`, limit, offset },
    })
    if (!res.ok) {
      throw new Error(`Failed to search rule group "${name}": ${falconErrorMessage(res)}`)
    }
    const ids = (parseEnvelope<string>(res.body)?.resources ?? []).filter(
      (id): id is string => typeof id === 'string',
    )

    for (const id of ids) {
      const group = await getRuleGroupById(client, id)
      if (!group) continue
      if (group.name === name && group.platform?.toLowerCase() === platform) return group
      if (group.name?.toLowerCase() === name.toLowerCase() && group.platform?.toLowerCase() === platform) {
        caseInsensitive.push(group)
      }
    }

    if (ids.length < limit) break
  }

  return caseInsensitive.length === 1 ? caseInsensitive[0] : null
}

/** Read a single rule group (with its rules, version, and tracking) by id. */
export async function getRuleGroupById(
  client: FalconClient,
  id: string,
): Promise<LiveFirewallRuleGroup | null> {
  const res = await client.request('GET', '/fwmgr/entities/rule-groups/v1', { query: { ids: id } })
  if (!res.ok) {
    throw new Error(`Failed to read rule group ${id}: ${falconErrorMessage(res)}`)
  }
  return parseEnvelope<LiveFirewallRuleGroup>(res.body)?.resources?.[0] ?? null
}

/** Create a rule group with its full rule set in one call. Returns the new id. */
async function createRuleGroup(
  client: FalconClient,
  spec: FirewallRuleGroupSpec,
  desired: CanonicalRule[],
): Promise<string> {
  const body: Record<string, unknown> = {
    name: spec.name,
    platform: spec.platform,
    enabled: spec.enabled,
    description: spec.description ?? '',
    rules: desired.map((rule, index) => buildRulePayload(rule, `temp_id:${index}`)),
  }

  const res = await client.request('POST', '/fwmgr/entities/rule-groups/v1', { body })
  const failure = falconFailure(res)
  if (failure) {
    throw new Error(`Failed to create rule group "${spec.name}": ${failure}`)
  }

  const resource = parseEnvelope<unknown>(res.body)?.resources?.[0]
  const id =
    typeof resource === 'string'
      ? resource
      : typeof (resource as { id?: string })?.id === 'string'
        ? (resource as { id: string }).id
        : undefined
  if (!id) {
    throw new Error(`Rule group "${spec.name}" was created but the API returned no group id`)
  }
  return id
}

/**
 * Converge an existing rule group's top-level fields and rule set to `desired`
 * via a single JSON-patch PATCH. No-op when nothing differs.
 */
export async function convergeRuleGroup(
  client: FalconClient,
  current: LiveFirewallRuleGroup,
  meta: { name: string; description: string; enabled: boolean },
  desired: CanonicalRule[],
): Promise<void> {
  const { diffOps, ruleIds, ruleVersions } = buildDiffOperations(current, meta, desired)
  if (diffOps.length === 0) return

  const res = await client.request('PATCH', '/fwmgr/entities/rule-groups/v1', {
    body: {
      id: current.id,
      diff_type: DIFF_TYPE,
      diff_operations: diffOps,
      rule_ids: ruleIds,
      rule_versions: ruleVersions,
      tracking: current.tracking ?? '',
    },
  })
  const failure = falconFailure(res)
  if (failure) {
    throw new Error(`Failed to update rule group "${meta.name}": ${failure}`)
  }
}

/** Delete a whole rule group by id. Returns the raw response so the caller handles 404. */
export function deleteRuleGroup(client: FalconClient, id: string) {
  return client.request('DELETE', '/fwmgr/entities/rule-groups/v1', { query: { ids: id } })
}

// --- Diff + payload building -------------------------------------------------

/**
 * Build the JSON-patch operations and parallel rule_ids/rule_versions that
 * converge `current` to `meta`+`desired`. Unchanged rules (matched by name)
 * keep their id; changed/new rules become a remove(old)+add(temp_id) pair;
 * live rules absent from `desired` are removed. Mirrors the transformation
 * CrowdStrike's Terraform provider emits.
 */
export function buildDiffOperations(
  current: LiveFirewallRuleGroup,
  meta: { name: string; description: string; enabled: boolean },
  desired: CanonicalRule[],
): { diffOps: JsonPatchOp[]; ruleIds: string[]; ruleVersions: number[] } {
  const diffOps: JsonPatchOp[] = []

  if ((current.name ?? '') !== meta.name) {
    diffOps.push({ op: 'replace', path: '/name', value: meta.name })
  }
  if ((current.description ?? '') !== meta.description) {
    diffOps.push({ op: 'replace', path: '/description', value: meta.description })
  }
  if ((current.enabled ?? false) !== meta.enabled) {
    diffOps.push({ op: 'replace', path: '/enabled', value: meta.enabled })
  }

  const currentRules = current.rules ?? []
  const byName = new Map<string, { id: string; canon: CanonicalRule }>()
  currentRules.forEach((live) => {
    if (typeof live.id === 'string') byName.set(live.name ?? '', { id: live.id, canon: canonicalFromLive(live) })
  })

  const ruleIds: string[] = []
  const ruleVersions: number[] = []
  const usedIds = new Set<string>()
  const toAdd: Array<{ tempId: string; rule: CanonicalRule }> = []
  let counter = 1

  for (const rule of desired) {
    const match = byName.get(rule.name)
    if (match && rulesEqual(rule, match.canon)) {
      ruleIds.push(match.id)
      ruleVersions.push(0)
      usedIds.add(match.id)
    } else {
      const tempId = `temp_id:${counter++}`
      toAdd.push({ tempId, rule })
      ruleIds.push(tempId)
      ruleVersions.push(0)
    }
  }

  // Remove live rules not kept — descending index so earlier indices stay valid.
  for (let i = currentRules.length - 1; i >= 0; i--) {
    const id = currentRules[i]?.id
    if (typeof id === 'string' && !usedIds.has(id)) {
      diffOps.push({ op: 'remove', path: `/rules/${i}` })
    }
  }

  for (const add of toAdd) {
    diffOps.push({ op: 'add', path: '/rules/-', value: buildRulePayload(add.rule, add.tempId) })
  }

  return { diffOps, ruleIds, ruleVersions }
}

/** Build the wire rule object for a create body or a JSON-patch add value. */
export function buildRulePayload(rule: CanonicalRule, tempId: string): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    temp_id: tempId,
    name: rule.name,
    description: rule.description,
    enabled: rule.enabled,
    action: rule.action,
    direction: rule.direction,
    protocol: rule.protocolWire,
    address_family: rule.addressFamily,
    // The API requires "log" but never returns it and the console exposes no
    // control for it, so a constant false satisfies the required field.
    log: false,
    local_port: rule.localPorts,
    remote_port: rule.remotePorts,
    local_address: rule.localAddresses,
    remote_address: rule.remoteAddresses,
    fields: [{ name: 'network_location', type: 'set', values: [rule.networkLocation] }],
  }
  if (rule.protocolWire === '1' || rule.protocolWire === '58') {
    payload.icmp = { icmp_type: rule.icmpType || '*', icmp_code: rule.icmpCode || '*' }
  }
  if (rule.monitor) {
    payload.monitor = { count: '1', period_ms: '3600000' }
  }
  return payload
}

/** Whether a wire protocol is ICMP (v4 or v6) — these carry icmp type/code. */
function isIcmp(protocolWire: string): boolean {
  return protocolWire === '1' || protocolWire === '58'
}

/** Canonical rule fields derived from a validated spec. */
export function canonicalFromSpec(rule: FirewallRuleSpec): CanonicalRule {
  const icmp = isIcmp(rule.protocolWire)
  return {
    name: rule.name,
    description: rule.description ?? '',
    enabled: rule.enabled,
    monitor: rule.monitor,
    action: rule.action,
    direction: rule.direction,
    protocolWire: rule.protocolWire,
    addressFamily: rule.addressFamily,
    localPorts: rule.localPorts,
    remotePorts: rule.remotePorts,
    localAddresses: rule.localAddresses,
    remoteAddresses: rule.remoteAddresses,
    // Match what buildRulePayload sends (icmp only for ICMP; "*" default) so a
    // plain ICMP rule does not read as drift after deploy.
    icmpType: icmp ? rule.icmpType || '*' : '',
    icmpCode: icmp ? rule.icmpCode || '*' : '',
    networkLocation: rule.networkLocation,
  }
}

/** Canonical rule fields derived from a live fwmgr rule. */
export function canonicalFromLive(live: LiveFirewallRule): CanonicalRule {
  const networkLocation =
    (live.fields ?? []).find((f) => f.name === 'network_location')?.values?.[0] ?? 'ANY'
  const protocolWire = live.protocol ?? ''
  const icmp = isIcmp(protocolWire)
  return {
    name: live.name ?? '',
    description: live.description ?? '',
    enabled: live.enabled ?? false,
    monitor: live.monitor != null,
    action: (live.action ?? '').toUpperCase(),
    direction: (live.direction ?? '').toUpperCase(),
    protocolWire,
    addressFamily: live.address_family ?? 'NONE',
    localPorts: normalizePorts(live.local_port),
    remotePorts: normalizePorts(live.remote_port),
    localAddresses: normalizeAddresses(live.local_address),
    remoteAddresses: normalizeAddresses(live.remote_address),
    icmpType: icmp ? live.icmp?.icmp_type || '*' : '',
    icmpCode: icmp ? live.icmp?.icmp_code || '*' : '',
    networkLocation,
  }
}

function normalizePorts(ports: FirewallPortRange[] | undefined): FirewallPortRange[] {
  return (ports ?? []).map((p) => ({ start: Number(p.start), end: Number(p.end ?? 0) }))
}

function normalizeAddresses(addrs: FirewallAddress[] | undefined): FirewallAddress[] {
  return (addrs ?? []).map((a) => ({ address: String(a.address), netmask: Number(a.netmask ?? 0) }))
}

/** Whether two canonical rules match on every managed field. */
export function rulesEqual(a: CanonicalRule, b: CanonicalRule): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
