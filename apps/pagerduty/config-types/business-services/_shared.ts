// Shared helpers for the PagerDuty Business Services config type
// (validate + deploy + rollback + drift + health).
//
// A PagerDuty business service lives at /business_services and is keyed for
// reconciliation by its `name` (PagerDuty assigns the server id). A business
// service models a capability that spans multiple technical services and may
// optionally be owned by a team; the operator supplies the team by NAME and the
// deploy resolves it to a team reference { id } by listing /teams — the same
// pattern the services config type uses to resolve an escalation policy.
//
// Request/response shapes follow the PagerDuty REST API v2 (verified against
// PagerDuty's official OpenAPI spec):
//   list:   GET    /business_services          -> { business_services: [...] }
//   create: POST   /business_services          <- { business_service: {...} }
//   get:    GET    /business_services/{id}      -> { business_service: {...} }
//   update: PUT    /business_services/{id}      <- { business_service: {...} }
//   delete: DELETE /business_services/{id}
//
// Docs: https://developer.pagerduty.com/api-reference/9d0b8225f8503-list-business-services
//
// NOTE: unlike escalation_policy / service / schedule / team, `type` is a
// READ-ONLY property on this resource's create/update body per the OpenAPI
// schema — it is never sent here.

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'

/** Reference to the team that owns a business service, as returned by the API. */
export interface TeamReference {
  id?: string
  type?: string
  self?: string
}

/** A business service as returned by GET /business_services. */
export interface LiveBusinessService {
  id?: string
  type?: string
  name?: string
  description?: string
  point_of_contact?: string
  team?: TeamReference | null
}

/** One canvas item, normalized to the fields this config type manages. */
export interface BusinessServiceSpec {
  itemName: string
  name: string
  description: string
  pointOfContact: string
  /** The NAME of the team to attach; resolved to an id at deploy. Blank = no team (admins only). */
  teamName: string
}

/** Each canvas item describes one business service. */
export function extractBusinessServiceSpecs(canvas: CanvasSnapshot): BusinessServiceSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const fields = item.fields ?? {}
    return {
      itemName: item.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      description: typeof fields.description === 'string' ? fields.description.trim() : '',
      pointOfContact: typeof fields.point_of_contact === 'string' ? fields.point_of_contact.trim() : '',
      teamName: typeof fields.team === 'string' ? fields.team.trim() : '',
    }
  })
}

/**
 * Build the request body for POST/PUT /business_services. Wrapped in a
 * { business_service: {...} } envelope by callers. No `type` is sent — the
 * OpenAPI schema marks it read-only for this resource. `team` is omitted
 * entirely when blank; PagerDuty then means "only admins have access".
 */
export function buildBusinessServiceBody(spec: BusinessServiceSpec, teamId: string | null): LiveBusinessService {
  const body: LiveBusinessService = { name: spec.name }
  if (spec.description) body.description = spec.description
  if (spec.pointOfContact) body.point_of_contact = spec.pointOfContact
  if (teamId) body.team = { id: teamId }
  return body
}

/** Rebuild a business service body from its prior live shape (used by rollback restore). */
export function businessServiceRestoreBody(prior: LiveBusinessService): LiveBusinessService {
  const body: LiveBusinessService = { name: String(prior.name ?? '') }
  if (prior.description) body.description = prior.description
  if (prior.point_of_contact) body.point_of_contact = prior.point_of_contact
  if (prior.team?.id) body.team = { id: prior.team.id }
  return body
}

/** Find a live business service by name (case-insensitive — the reconciliation identity). */
export function findBusinessService(services: LiveBusinessService[], name: string): LiveBusinessService | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  return services.find((s) => String(s.name ?? '').trim().toLowerCase() === n) ?? null
}

/** Resolve a team NAME to its id (case-insensitive). */
export function findTeamId(teams: Array<{ id?: string; name?: string }>, name: string): string | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  const match = teams.find((t) => String(t.name ?? '').trim().toLowerCase() === n)
  return match?.id ?? null
}
