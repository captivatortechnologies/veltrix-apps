// Shared helpers for the PagerDuty Tags config type
// (validate + deploy + rollback + drift + health).
//
// A PagerDuty tag lives at /tags and is keyed for reconciliation by its `label`
// (PagerDuty assigns the server id). A tag can be attached to Users, Teams or
// Escalation Policies via POST /{entity_type}/{id}/change_tags — Services do NOT
// support tags. This config type manages a tag's identity (label) plus the set of
// entities it should be assigned to.
//
// Request/response shapes follow the PagerDuty REST API v2 (verified against the
// official OpenAPI v2 spec):
//   list:      GET    /tags                              -> { tags: [...] }
//   create:    POST   /tags                               <- { tag: {...} }
//   delete:    DELETE /tags/{id}                          (cascades all assignments)
//   assign:    POST   /{entity_type}/{id}/change_tags      <- { add?: [...], remove?: [...] }
//   entity tags: GET  /{entity_type}/{id}/tags             -> { tags: [...] }
//   users:     GET    /users                               -> { users: [...] }
//   teams:     GET    /teams                               -> { teams: [...] }
//   policies:  GET    /escalation_policies                 -> { escalation_policies: [...] }
//
// Docs: https://developer.pagerduty.com/api-reference/b3A6Mjc0ODIxOA-create-a-tag
//       https://developer.pagerduty.com/api-reference/b3A6Mjc0ODEwMA-assign-tags

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'

/** Entity types PagerDuty accepts as a tag-assignment target. */
export const VALID_ASSIGNMENT_ENTITY_TYPES = new Set(['users', 'teams', 'escalation_policies'])

/** A tag as returned by GET /tags. */
export interface LiveTag {
  id?: string
  type?: string
  label?: string
  summary?: string
  self?: string
  html_url?: string | null
}

/** One declared assignment: attach the tag to a named user/team/escalation policy. */
export interface TagAssignmentSpec {
  entity_type: string
  entity_name: string
}

/** One canvas item, normalized to the fields this config type manages. */
export interface TagSpec {
  itemName: string
  label: string
  /** Raw JSON text for the assignments array (optional; blank means "no assignments"). */
  assignmentsJson: string
}

/**
 * Result of parsing the assignments JSON. NOT a discriminated union — the
 * platform's handler loader does not narrow `{ ok:true } | { ok:false }`, so
 * `assignments` and `error` are always-present nullable fields.
 */
export interface AssignmentsParseResult {
  assignments: TagAssignmentSpec[] | null
  error: string | null
}

/** Minimal shape needed to resolve a user by email. */
export interface LiveUserRef {
  id?: string
  email?: string
  name?: string
}

/** Minimal shape needed to resolve a team by name. */
export interface LiveTeamRef {
  id?: string
  name?: string
}

/** Minimal shape needed to resolve an escalation policy by name. */
export interface LiveEscalationPolicyRef {
  id?: string
  name?: string
}

/** Already-fetched lookup lists used to resolve an assignment's entity_name to an id. */
export interface EntityLookups {
  users: LiveUserRef[]
  teams: LiveTeamRef[]
  escalation_policies: LiveEscalationPolicyRef[]
}

/**
 * Parse + shallow-validate the assignments JSON. A blank input is valid and means
 * "no assignments" (attaching the tag to anything is optional). Returns the typed
 * assignments on success, or a human-readable `error` describing the first problem.
 */
export function parseAssignments(raw: string | undefined): AssignmentsParseResult {
  const text = (raw ?? '').trim()
  if (!text) return { assignments: [], error: null }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { assignments: null, error: `must be valid JSON (${err instanceof Error ? err.message : 'parse error'})` }
  }
  if (!Array.isArray(parsed)) return { assignments: null, error: 'must be a JSON array of assignments' }

  const assignments: TagAssignmentSpec[] = []
  for (let i = 0; i < parsed.length; i++) {
    const entry = parsed[i] as Record<string, unknown>
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { assignments: null, error: `assignment ${i + 1} must be an object` }
    }
    const entityType = typeof entry.entity_type === 'string' ? entry.entity_type.trim() : ''
    if (!VALID_ASSIGNMENT_ENTITY_TYPES.has(entityType)) {
      return {
        assignments: null,
        error: `assignment ${i + 1} "entity_type" must be one of ${[...VALID_ASSIGNMENT_ENTITY_TYPES].join(' / ')}`,
      }
    }
    const entityName = typeof entry.entity_name === 'string' ? entry.entity_name.trim() : ''
    if (!entityName) return { assignments: null, error: `assignment ${i + 1} needs a non-empty "entity_name"` }
    assignments.push({ entity_type: entityType, entity_name: entityName })
  }
  return { assignments, error: null }
}

/** Each canvas item describes one tag. */
export function extractTagSpecs(canvas: CanvasSnapshot): TagSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const fields = item.fields ?? {}
    return {
      itemName: item.name,
      label: typeof fields.label === 'string' ? fields.label.trim() : '',
      assignmentsJson: typeof fields.assignments === 'string' ? fields.assignments : '',
    }
  })
}

/**
 * Build the request body for POST /tags. Wrapped in a { tag: {...} } envelope by
 * callers. `type` is set explicitly (PagerDuty's Tag schema declares it required
 * with a default of "tag"), matching this app's other config types which set
 * `type` explicitly so the API resolves the resource unambiguously. Tags cannot be
 * updated in place — `label` is the only writable field.
 */
export function buildTagBody(spec: TagSpec): LiveTag {
  return { type: 'tag', label: spec.label }
}

/** Find a live tag by label (case-insensitive — the reconciliation identity). */
export function findTag(tags: LiveTag[], label: string): LiveTag | null {
  const n = label.trim().toLowerCase()
  if (!n) return null
  return tags.find((t) => String(t.label ?? '').trim().toLowerCase() === n) ?? null
}

/**
 * Resolve an assignment's entity_name to a live id. Users are matched by EMAIL
 * (PagerDuty's stable user identifier); teams and escalation policies are matched
 * by NAME. All matches are case-insensitive.
 */
export function resolveEntityId(entityType: string, entityName: string, lookups: EntityLookups): string | null {
  const name = entityName.trim().toLowerCase()
  if (!name) return null
  if (entityType === 'users') {
    return lookups.users.find((u) => String(u.email ?? '').trim().toLowerCase() === name)?.id ?? null
  }
  if (entityType === 'teams') {
    return lookups.teams.find((t) => String(t.name ?? '').trim().toLowerCase() === name)?.id ?? null
  }
  if (entityType === 'escalation_policies') {
    return lookups.escalation_policies.find((e) => String(e.name ?? '').trim().toLowerCase() === name)?.id ?? null
  }
  return null
}
