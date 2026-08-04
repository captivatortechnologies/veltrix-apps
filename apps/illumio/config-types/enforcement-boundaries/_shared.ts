// =============================================================================
// Shared types + pure helpers for the Illumio Enforcement Boundaries config
// type (validate + deploy + rollback + driftDetect).
//
// An enforcement boundary is a DENY-BY-DEFAULT rule: DRAFT-then-PROVISION at
// /orgs/{org}/sec_policy/draft/enforcement_boundaries, name-keyed like
// ip-lists/services. Confirmed against the Illumio Terraform provider:
// https://github.com/illumio/terraform-provider-illumio-core/blob/main/illumio-core/resource_illumio_enforcement_boundary.go
// https://github.com/illumio/terraform-provider-illumio-core/blob/main/models/enforcement_boundary.go
//
// Unlike a ruleset's rules, a boundary has no `resolve_labels_as` and no
// ruleset "scopes" wrapper — providers/consumers/ingress_services sit
// directly on the boundary object (models.EnforcementBoundary).
//
// SCOPE — same simplified actor/service DSL as config-types/rulesets
// (duplicated here, not imported, to keep this config type self-contained —
// matching this app's per-config-type ownership convention):
//   - A provider/consumer is exactly one of label (key+value), ipList (by
//     name), or "All Workloads" (actor "ams" — confirmed via
//     validENProducerConsumerActors, which allows ONLY "ams" here, stricter
//     than security rules' consumer side which also allows
//     "container_host"). Label groups as actors are NOT supported.
//   - ingress_services references existing Service names only — the PCE's
//     inline {proto,port,to_port} form (also valid on a live boundary) is
//     not supported, the same simplification this app already made for
//     rulesets.
// =============================================================================

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'

export const MAX_NAME_LENGTH = 255
/** The PCE's "All Workloads" provider/consumer actor value (the only allowed actor value on a boundary). */
export const ALL_WORKLOADS_ACTOR = 'ams'

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** The (key, value) identity string a label is matched on — mirrors config-types/labels/validate.ts labelIdentity. */
export function labelIdentity(key: string, value: string): string {
  return `${key} ${value}`
}

export interface LabelRef {
  key: string
  value: string
}

export interface ProviderConsumerSpec {
  label?: LabelRef
  ipList?: string
  allWorkloads?: boolean
}

export interface ServiceRefSpec {
  name: string
}

export interface EnforcementBoundarySpec {
  itemId?: string
  name: string
  enabled: boolean
  providers: ProviderConsumerSpec[]
  consumers: ProviderConsumerSpec[]
  services: ServiceRefSpec[]
  providersError?: string
  consumersError?: string
  servicesError?: string
}

/** Exactly one of label/ipList/allWorkloads — mirrors the PCE's own HasOneActor rule. */
export function providerConsumerShapeError(p: ProviderConsumerSpec, label: string): string | null {
  const setCount = (p.label ? 1 : 0) + (p.ipList ? 1 : 0) + (p.allWorkloads ? 1 : 0)
  if (setCount !== 1) return `${label} must set exactly one of label, ipList, or allWorkloads`
  if (p.label && (!p.label.key || !p.label.value)) return `${label}.label needs both key and value`
  return null
}

function parseProviderConsumerArray(raw: unknown): { value: ProviderConsumerSpec[]; error?: string } {
  const s = asString(raw)
  if (!s) return { value: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(s)
  } catch (e) {
    return { value: [], error: `is not valid JSON: ${e instanceof Error ? e.message : 'parse error'}` }
  }
  if (!Array.isArray(parsed)) return { value: [], error: 'must be a JSON array' }
  const value = parsed.map((entry) => {
    if (!entry || typeof entry !== 'object') return {}
    const r = entry as Record<string, unknown>
    const out: ProviderConsumerSpec = {}
    if (r.label && typeof r.label === 'object') {
      const l = r.label as Record<string, unknown>
      out.label = { key: asString(l.key), value: asString(l.value) }
    }
    if (typeof r.ipList === 'string' && r.ipList.trim()) out.ipList = r.ipList.trim()
    if (r.allWorkloads === true) out.allWorkloads = true
    return out
  })
  return { value }
}

function parseServiceRefArray(raw: unknown): { value: ServiceRefSpec[]; error?: string } {
  const s = asString(raw)
  if (!s) return { value: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(s)
  } catch (e) {
    return { value: [], error: `is not valid JSON: ${e instanceof Error ? e.message : 'parse error'}` }
  }
  if (!Array.isArray(parsed)) return { value: [], error: 'must be a JSON array' }
  return { value: parsed.filter((s2): s2 is Record<string, unknown> => !!s2 && typeof s2 === 'object').map((s2) => ({ name: asString(s2.name) })) }
}

export function extractEnforcementBoundarySpecs(canvas: CanvasSnapshot): EnforcementBoundarySpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    const providers = parseProviderConsumerArray(f.providersJson)
    const consumers = parseProviderConsumerArray(f.consumersJson)
    const services = parseServiceRefArray(f.servicesJson)
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      enabled: f.enabled !== false,
      providers: providers.value,
      consumers: consumers.value,
      services: services.value,
      providersError: providers.error,
      consumersError: consumers.error,
      servicesError: services.error,
    }
  })
}

// --- href resolution (FAIL CLOSED) ---------------------------------------------

export interface Resolvers {
  labelHrefByIdentity: Map<string, string>
  ipListHrefByName: Map<string, string>
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
    if (!href) throw new Error(`references service "${s.name}" which does not exist in the PCE`)
    return { href }
  })
}

/** Build the PCE-shaped boundary body. Throws — FAIL CLOSED — via the resolvers above on any unresolved reference. */
export function buildBoundaryBody(spec: EnforcementBoundarySpec, resolvers: Resolvers): Record<string, unknown> {
  return {
    name: spec.name,
    enabled: spec.enabled,
    providers: spec.providers.map((p) => resolveProviderConsumer(p, resolvers, 'a provider')),
    consumers: spec.consumers.map((c) => resolveProviderConsumer(c, resolvers, 'a consumer')),
    ingress_services: resolveIngressServices(spec.services, resolvers),
  }
}

export function snapshotLiveBoundary(live: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = { name: live.name }
  for (const k of ['enabled', 'providers', 'consumers', 'ingress_services']) {
    if (live[k] !== undefined) body[k] = live[k]
  }
  return body
}
