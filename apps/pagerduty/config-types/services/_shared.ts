// Shared helpers for the PagerDuty Services config type
// (validate + deploy + rollback + drift + health).
//
// A PagerDuty service lives at /services and is keyed for reconciliation by its
// `name` (PagerDuty assigns the server id). A service must reference an
// escalation policy; the operator supplies the policy by NAME and the deploy
// resolves it to an escalation_policy_reference { id, type } by listing
// /escalation_policies. Alert/ack timeouts are in SECONDS.
//
// Request/response shapes follow the PagerDuty REST API v2 (verified against
// PagerDuty's API reference and the official go-pagerduty client, service.go):
//   list:   GET    /services            -> { services: [...] }
//   create: POST   /services            <- { service: {...} }
//   get:    GET    /services/{id}        -> { service: {...} }
//   update: PUT    /services/{id}        <- { service: {...} }
//   delete: DELETE /services/{id}
//
// Docs: https://developer.pagerduty.com/api-reference/e960cef77dc70-create-a-service
//       https://github.com/PagerDuty/go-pagerduty/blob/master/service.go
//
// NOTE: `alert_creation` is DEPRECATED by PagerDuty (all services are migrating
// to "create_alerts_and_incidents"). It is still accepted and is surfaced here
// for parity with existing services; new services should prefer the default.

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'

/** The two accepted values for a service's alert_creation mode. */
export const VALID_ALERT_CREATION = new Set(['create_incidents', 'create_alerts_and_incidents'])

/** APIReference to the escalation policy that backs a service. */
export interface EscalationPolicyReference {
  id?: string
  type?: string
  summary?: string
}

/** A service as returned by GET /services. */
export interface LiveService {
  id?: string
  type?: string
  name?: string
  description?: string
  escalation_policy?: EscalationPolicyReference
  auto_resolve_timeout?: number | null
  acknowledgement_timeout?: number | null
  alert_creation?: string
  status?: string
}

/** One canvas item, normalized to the fields this config type manages. */
export interface ServiceSpec {
  itemName: string
  name: string
  description: string
  /** The NAME of the escalation policy to attach; resolved to an id at deploy. */
  escalationPolicyName: string
  /** Seconds; null when blank (PagerDuty applies its own default). */
  autoResolveTimeout: number | null
  /** Seconds; null when blank (PagerDuty defaults to 1800). */
  acknowledgementTimeout: number | null
  /** '' | 'create_incidents' | 'create_alerts_and_incidents'. */
  alertCreation: string
}

/** Coerce an optional timeout (seconds) from the canvas — NaN flags an invalid value. */
export function parseOptionalTimeout(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null
  const n = typeof value === 'number' ? value : Number(String(value).trim())
  return Number.isFinite(n) ? n : NaN
}

/** Each canvas item describes one service. */
export function extractServiceSpecs(canvas: CanvasSnapshot): ServiceSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const fields = item.fields ?? {}
    return {
      itemName: item.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      description: typeof fields.description === 'string' ? fields.description.trim() : '',
      escalationPolicyName:
        typeof fields.escalation_policy === 'string' ? fields.escalation_policy.trim() : '',
      autoResolveTimeout: parseOptionalTimeout(fields.auto_resolve_timeout),
      acknowledgementTimeout: parseOptionalTimeout(fields.acknowledgement_timeout),
      alertCreation: typeof fields.alert_creation === 'string' ? fields.alert_creation.trim() : '',
    }
  })
}

/**
 * Build the request body for POST/PUT /services. Wrapped in a { service: {...} }
 * envelope by callers. `type` is set explicitly and the escalation policy is
 * attached as an escalation_policy_reference to the resolved id.
 */
export function buildServiceBody(spec: ServiceSpec, escalationPolicyId: string): LiveService {
  const body: LiveService = {
    type: 'service',
    name: spec.name,
    escalation_policy: { id: escalationPolicyId, type: 'escalation_policy_reference' },
  }
  if (spec.description) body.description = spec.description
  if (spec.autoResolveTimeout != null && Number.isFinite(spec.autoResolveTimeout)) {
    body.auto_resolve_timeout = spec.autoResolveTimeout
  }
  if (spec.acknowledgementTimeout != null && Number.isFinite(spec.acknowledgementTimeout)) {
    body.acknowledgement_timeout = spec.acknowledgementTimeout
  }
  if (spec.alertCreation) body.alert_creation = spec.alertCreation
  return body
}

/** Rebuild a service body from its prior live shape (used by rollback restore). */
export function serviceRestoreBody(prior: LiveService): LiveService {
  const body: LiveService = { type: 'service', name: String(prior.name ?? '') }
  if (prior.escalation_policy?.id) {
    body.escalation_policy = { id: prior.escalation_policy.id, type: 'escalation_policy_reference' }
  }
  if (prior.description) body.description = prior.description
  if (typeof prior.auto_resolve_timeout === 'number') body.auto_resolve_timeout = prior.auto_resolve_timeout
  if (typeof prior.acknowledgement_timeout === 'number') {
    body.acknowledgement_timeout = prior.acknowledgement_timeout
  }
  if (prior.alert_creation) body.alert_creation = prior.alert_creation
  return body
}

/** Find a live service by name (case-insensitive — the reconciliation identity). */
export function findService(services: LiveService[], name: string): LiveService | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  return services.find((s) => String(s.name ?? '').trim().toLowerCase() === n) ?? null
}

/** Resolve an escalation policy NAME to its id (case-insensitive). */
export function findPolicyId(
  policies: Array<{ id?: string; name?: string }>,
  name: string,
): string | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  const match = policies.find((p) => String(p.name ?? '').trim().toLowerCase() === n)
  return match?.id ?? null
}
