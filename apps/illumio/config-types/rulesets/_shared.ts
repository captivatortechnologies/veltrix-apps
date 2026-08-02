// =============================================================================
// Shared types + pure helpers for the Illumio Rulesets config type
// (validate + deploy + rollback + driftDetect).
//
// A ruleset is DRAFT-then-PROVISION, same as ip-lists/services
// (/orgs/{org}/sec_policy/draft/rule_sets, name-keyed), PLUS a nested rules
// sub-collection: rules are created/deleted at {rule_set_href}/sec_rules —
// confirmed against the Illumio Terraform provider's
// resource_illumio_security_rule.go:
//   illumioClient.Create(fmt.Sprintf("%s/sec_rules", hrefRuleSet), secRule)
// https://github.com/illumio/terraform-provider-illumio-core/blob/main/illumio-core/resource_illumio_security_rule.go
//
// Provisioning: SecurityPolicyChangeSubset has NO separate field for
// individual rules — only `rule_sets` (and ip_lists / services / ...). A
// ruleset's own href covers everything nested under it, confirmed against:
// https://github.com/illumio/terraform-provider-illumio-core/blob/main/models/security_policy.go
//
// SCOPE — this app's rule DSL is a deliberately simplified subset of the full
// PCE rule model (models.SecurityRule / models.RuleSetScope), verified but
// NOT built in this release (flagged rather than faked):
//   - A provider/consumer may reference a LABEL (key+value), an IP LIST (by
//     name), or "All Workloads" (the PCE actor value "ams" — confirmed via
//     resource_illumio_security_rule.go's validSRProducerActors /
//     validSRConsumerActors, both allow "ams"; consumer also allows
//     "container_host", not supported here). Workloads, virtual services,
//     virtual servers and label groups as actors are NOT supported.
//   - resolve_labels_as is hardcoded to
//     {providers:["workloads"], consumers:["workloads"]} — the PCE default
//     for label-based rules; virtual-service resolution is not supported.
//   - A ruleset has exactly ONE scope (one AND-group of labels, no
//     label_groups, no exclusion). The PCE's real `scopes` shape is
//     `[][]*RuleSetScope` (OR of AND-groups) — confirmed against
//     resource_illumio_rule_set.go's expandIllumioRuleSetScopes, which turns
//     each Terraform HCL scope BLOCK into one outer array element. Multiple
//     OR'd scope groups are not supported here.
//   - ip_tables_rules, sec_connect, stateless, machine_auth,
//     unscoped_consumers and use_workload_subnets are not supported.
// A follow-up release can extend the DSL once these are needed.
// =============================================================================

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'

export const MAX_NAME_LENGTH = 255
/** The PCE's "All Workloads" provider/consumer actor value. */
export const ALL_WORKLOADS_ACTOR = 'ams'

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** The (key, value) identity string a label is matched on — mirrors config-types/labels/validate.ts labelIdentity, duplicated here to keep this config type self-contained. */
export function labelIdentity(key: string, value: string): string {
  return `${key} ${value}`
}

// --- Scope labels --------------------------------------------------------------

export interface LabelRef {
  key: string
  value: string
}

export function parseLabelRefArray(raw: unknown): { value: LabelRef[]; error?: string } {
  const s = asString(raw)
  if (!s) return { value: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(s)
  } catch (e) {
    return { value: [], error: `is not valid JSON: ${e instanceof Error ? e.message : 'parse error'}` }
  }
  if (!Array.isArray(parsed)) return { value: [], error: 'must be a JSON array' }
  const value: LabelRef[] = []
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    value.push({ key: asString(e.key), value: asString(e.value) })
  }
  return { value }
}

// --- Rule providers / consumers / services --------------------------------------

export interface ProviderConsumerSpec {
  label?: LabelRef
  ipList?: string
  allWorkloads?: boolean
}

export interface ServiceRefSpec {
  name: string
}

export interface RuleSpec {
  description?: string
  enabled: boolean
  providers: ProviderConsumerSpec[]
  consumers: ProviderConsumerSpec[]
  services: ServiceRefSpec[]
}

export interface RuleSetSpec {
  itemId?: string
  name: string
  description: string
  enabled: boolean
  scopeLabels: LabelRef[]
  rules: RuleSpec[]
  externalDataSet: string
  externalDataReference: string
  scopeLabelsError?: string
  rulesError?: string
}

/** Exactly one of label/ipList/allWorkloads — mirrors the PCE's own HasOneActor rule (models/security_rule.go). */
export function providerConsumerShapeError(p: ProviderConsumerSpec, label: string): string | null {
  const setCount = (p.label ? 1 : 0) + (p.ipList ? 1 : 0) + (p.allWorkloads ? 1 : 0)
  if (setCount !== 1) return `${label} must set exactly one of label, ipList, or allWorkloads`
  if (p.label && (!p.label.key || !p.label.value)) return `${label}.label needs both key and value`
  return null
}

function parseProviderConsumer(raw: unknown): ProviderConsumerSpec {
  if (!raw || typeof raw !== 'object') return {}
  const r = raw as Record<string, unknown>
  const out: ProviderConsumerSpec = {}
  if (r.label && typeof r.label === 'object') {
    const l = r.label as Record<string, unknown>
    out.label = { key: asString(l.key), value: asString(l.value) }
  }
  if (typeof r.ipList === 'string' && r.ipList.trim()) out.ipList = r.ipList.trim()
  if (r.allWorkloads === true) out.allWorkloads = true
  return out
}

function parseRule(raw: unknown): RuleSpec {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const providers = Array.isArray(r.providers) ? r.providers.map(parseProviderConsumer) : []
  const consumers = Array.isArray(r.consumers) ? r.consumers.map(parseProviderConsumer) : []
  const services = Array.isArray(r.services)
    ? r.services.filter((s): s is Record<string, unknown> => !!s && typeof s === 'object').map((s) => ({ name: asString(s.name) }))
    : []
  return {
    description: asString(r.description) || undefined,
    enabled: r.enabled !== false,
    providers,
    consumers,
    services,
  }
}

export function parseRulesJson(raw: unknown): { value: RuleSpec[]; error?: string } {
  const s = asString(raw)
  if (!s) return { value: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(s)
  } catch (e) {
    return { value: [], error: `is not valid JSON: ${e instanceof Error ? e.message : 'parse error'}` }
  }
  if (!Array.isArray(parsed)) return { value: [], error: 'must be a JSON array' }
  return { value: parsed.map(parseRule) }
}

export function extractRuleSetSpecs(canvas: CanvasSnapshot): RuleSetSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    const scopeParsed = parseLabelRefArray(f.scopeLabelsJson)
    const rulesParsed = parseRulesJson(f.rulesJson)
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      description: asString(f.description),
      enabled: f.enabled !== false,
      scopeLabels: scopeParsed.value,
      rules: rulesParsed.value,
      externalDataSet: asString(f.externalDataSet),
      externalDataReference: asString(f.externalDataReference),
      scopeLabelsError: scopeParsed.error,
      rulesError: rulesParsed.error,
    }
  })
}

// --- href resolution (FAIL CLOSED) ----------------------------------------------
// Every lookup below throws when a named reference doesn't resolve. Callers
// must treat that as "apply nothing for this ruleset" rather than a partial
// apply — an under-scoped or under-restricted rule is a security regression,
// not a safe degradation.

export interface Resolvers {
  /** key: labelIdentity(key, value) -> href */
  labelHrefByIdentity: Map<string, string>
  /** key: lowercased IP list name -> href */
  ipListHrefByName: Map<string, string>
  /** key: lowercased service name -> href */
  serviceHrefByName: Map<string, string>
}

export function resolveProviderConsumer(p: ProviderConsumerSpec, resolvers: Resolvers, side: string): Record<string, unknown> {
  if (p.allWorkloads) return { actors: ALL_WORKLOADS_ACTOR }
  if (p.label) {
    const href = resolvers.labelHrefByIdentity.get(labelIdentity(p.label.key, p.label.value))
    if (!href) throw new Error(`${side} references label "${p.label.key}=${p.label.value}" which does not exist in the PCE`)
    return { label: { href } }
  }
  if (p.ipList) {
    const href = resolvers.ipListHrefByName.get(p.ipList.toLowerCase())
    if (!href) throw new Error(`${side} references IP list "${p.ipList}" which does not exist in the PCE`)
    return { ip_list: { href } }
  }
  throw new Error(`${side} has no label, ipList, or allWorkloads set`)
}

export function resolveIngressServices(services: ServiceRefSpec[], resolvers: Resolvers): Array<{ href: string }> {
  return services.map((s) => {
    const href = resolvers.serviceHrefByName.get(s.name.toLowerCase())
    if (!href) throw new Error(`rule references service "${s.name}" which does not exist in the PCE`)
    return { href }
  })
}

/** Resolve a ruleset's scope labels to the PCE's `[][]{label:{href}}` shape (one AND-group). */
export function resolveScopes(scopeLabels: LabelRef[], resolvers: Resolvers): Array<Array<{ label: { href: string } }>> {
  const group = scopeLabels.map((l) => {
    const href = resolvers.labelHrefByIdentity.get(labelIdentity(l.key, l.value))
    if (!href) throw new Error(`scope references label "${l.key}=${l.value}" which does not exist in the PCE`)
    return { label: { href } }
  })
  return [group]
}

export function buildRuleSetBody(spec: RuleSetSpec, scopes: Array<Array<{ label: { href: string } }>>): Record<string, unknown> {
  const body: Record<string, unknown> = { name: spec.name, enabled: spec.enabled, scopes }
  if (spec.description) body.description = spec.description
  if (spec.externalDataSet) body.external_data_set = spec.externalDataSet
  if (spec.externalDataReference) body.external_data_reference = spec.externalDataReference
  return body
}

export function snapshotLiveRuleSet(live: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = { name: live.name }
  for (const k of ['description', 'enabled', 'scopes', 'external_data_set', 'external_data_reference']) {
    if (live[k] !== undefined) body[k] = live[k]
  }
  return body
}

/** Build the PCE-shaped rule body from a resolved rule spec (throws — fail closed — via the resolvers above). */
export function buildRuleBody(rule: RuleSpec, resolvers: Resolvers): Record<string, unknown> {
  return {
    enabled: rule.enabled,
    ...(rule.description ? { description: rule.description } : {}),
    providers: rule.providers.map((p) => resolveProviderConsumer(p, resolvers, 'a provider')),
    consumers: rule.consumers.map((c) => resolveProviderConsumer(c, resolvers, 'a consumer')),
    ingress_services: resolveIngressServices(rule.services, resolvers),
    resolve_labels_as: { providers: ['workloads'], consumers: ['workloads'] },
  }
}

export interface ResolvedRuleSet {
  scopes: Array<Array<{ label: { href: string } }>>
  rules: Array<{ body: Record<string, unknown>; signature: string }>
}

/**
 * Resolve a ruleset's scope + every one of its rules. Throws on the FIRST
 * unresolved reference (fail closed) — the caller must skip the whole
 * ruleset on failure rather than apply a partial result.
 */
export function resolveRuleSet(spec: RuleSetSpec, resolvers: Resolvers): ResolvedRuleSet {
  const scopes = resolveScopes(spec.scopeLabels, resolvers)
  const rules = spec.rules.map((rule) => {
    const body = buildRuleBody(rule, resolvers)
    return { body, signature: ruleSignature(body) }
  })
  return { scopes, rules }
}

// --- Rule identity: content signature -------------------------------------------
// Rules have no natural identity in the PCE (unlike labels' key+value or
// ip-lists'/services' name) — reconcile matches on a canonical signature of
// the resolved shape instead. Two rules (declared or live) that resolve to the
// same signature are treated as the same rule.

function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`
  if (v && typeof v === 'object') {
    const obj = v as Record<string, unknown>
    const keys = Object.keys(obj).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
  }
  return JSON.stringify(v) ?? 'null'
}

function sortRefs(v: unknown): unknown {
  return Array.isArray(v) ? [...v].sort((a, b) => stableStringify(a).localeCompare(stableStringify(b))) : v
}

export function ruleSignature(body: Record<string, unknown>): string {
  return stableStringify({
    enabled: body.enabled,
    description: body.description ?? '',
    providers: sortRefs(body.providers),
    consumers: sortRefs(body.consumers),
    ingress_services: sortRefs(body.ingress_services),
    resolve_labels_as: body.resolve_labels_as,
  })
}

/** Drop server-added fields (e.g. an embedded label's key/value) from provider/consumer refs so only the href is compared. */
function normalizeLiveRefs(raw: unknown): unknown {
  if (!Array.isArray(raw)) return []
  return raw.map((entry) => {
    if (!entry || typeof entry !== 'object') return entry
    const e = entry as Record<string, unknown>
    if (e.actors) return { actors: e.actors }
    if (e.label && typeof e.label === 'object') return { label: { href: (e.label as Record<string, unknown>).href } }
    if (e.ip_list && typeof e.ip_list === 'object') return { ip_list: { href: (e.ip_list as Record<string, unknown>).href } }
    return e
  })
}

function normalizeLiveIngressServices(raw: unknown): unknown {
  if (!Array.isArray(raw)) return []
  return raw.map((entry) => {
    if (!entry || typeof entry !== 'object') return entry
    const e = entry as Record<string, unknown>
    return e.href ? { href: e.href } : e
  })
}

/** Compute the same signature from a LIVE sec_rule as returned by the PCE, for reconcile matching. */
export function liveRuleSignature(live: Record<string, unknown>): string {
  return ruleSignature({
    enabled: live.enabled,
    description: live.description ?? '',
    providers: normalizeLiveRefs(live.providers),
    consumers: normalizeLiveRefs(live.consumers),
    ingress_services: normalizeLiveIngressServices(live.ingress_services),
    resolve_labels_as: live.resolve_labels_as,
  })
}

// --- Rollback bookkeeping --------------------------------------------------------

export interface RuleEntry {
  href: string
  signature: string
}

export interface RuleSetRollbackEntry {
  itemId?: string
  name: string
  /** Whether the RULE_SET object existed before this deploy touched it. */
  existed: boolean
  href: string
  /** Prior ruleset body, captured before an update so rollback can restore it. Unset when created. */
  prior?: Record<string, unknown>
  /** Rules THIS APP currently manages under this ruleset (created by it, or claimed from a prior deploy). */
  rules: RuleEntry[]
}
