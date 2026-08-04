// Shared helpers for the PagerDuty Users config type
// (validate + deploy + rollback + drift + health).
//
// A PagerDuty user lives at /users and is keyed for reconciliation by its
// `email` (PagerDuty assigns the server id, and `name` is not guaranteed to be
// unique). This config type manages a user's identity + a handful of profile
// fields; contact methods, notification rules, oncall handoff notification
// rules, sessions and license are separate endpoints holding PII or personal
// runtime preferences and are OUT OF SCOPE.
//
// Request/response shapes follow the PagerDuty REST API v2 (verified against
// PagerDuty's OpenAPI spec and the official go-pagerduty client, user.go):
//   list:   GET    /users          -> { users: [...] }
//   create: POST   /users          <- { user: {...} }
//   get:    GET    /users/{id}      -> { user: {...} }
//   update: PUT    /users/{id}      <- { user: {...} }
//   delete: DELETE /users/{id}
//
// Docs: https://developer.pagerduty.com/api-reference/b3A6Mjc0ODIzNA-create-a-user
//       https://github.com/PagerDuty/go-pagerduty/blob/master/user.go
//
// NOTE: creating a user via POST /users sends that person an account invitation
// email — this is surfaced to operators in canvas.yaml's helpText for `email`.

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'

/** Valid values for a user's account role. */
export const VALID_ROLES = new Set([
  'admin',
  'limited_user',
  'observer',
  'owner',
  'read_only_user',
  'read_only_limited_user',
  'restricted_access',
  'user',
])

/** Valid values for a user's schedule color. */
export const VALID_COLORS = new Set([
  'purple', 'red', 'green', 'blue', 'teal', 'orange', 'brown', 'turquoise',
  'dark-slate-blue', 'cayenne', 'orange-red', 'dark-orchid', 'dark-slate-grey',
  'lime', 'dark-magenta', 'lime-green', 'midnight-blue', 'deep-pink', 'dark-green',
  'dark-orange', 'dark-cyan', 'darkolive-green', 'dark-slate-gray', 'grey20',
  'firebrick', 'maroon', 'crimson', 'dark-red', 'dark-goldenrod', 'chocolate',
  'medium-violet-red', 'sea-green', 'olivedrab', 'forest-green', 'dark-olive-green',
  'blue-violet', 'royal-blue', 'indigo', 'slate-blue', 'saddle-brown', 'steel-blue',
])

/** A user as returned by GET /users. */
export interface LiveUser {
  id?: string
  type?: string
  name?: string
  email?: string
  role?: string
  job_title?: string
  time_zone?: string
  description?: string
  color?: string
}

/** One canvas item, normalized to the fields this config type manages. */
export interface UserSpec {
  itemName: string
  name: string
  email: string
  role: string
  jobTitle: string
  timeZone: string
  description: string
  color: string
}

/** Simple, deliberately loose shape check — PagerDuty rejects malformed emails anyway. */
export function isPlausibleEmail(email: string): boolean {
  const at = email.indexOf('@')
  if (at <= 0) return false
  const dot = email.indexOf('.', at + 1)
  return dot > at + 1 && dot < email.length - 1
}

/** Each canvas item describes one user. */
export function extractUserSpecs(canvas: CanvasSnapshot): UserSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const fields = item.fields ?? {}
    return {
      itemName: item.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      email: typeof fields.email === 'string' ? fields.email.trim() : '',
      role: typeof fields.role === 'string' ? fields.role.trim() : '',
      jobTitle: typeof fields.job_title === 'string' ? fields.job_title.trim() : '',
      timeZone: typeof fields.time_zone === 'string' ? fields.time_zone.trim() : '',
      description: typeof fields.description === 'string' ? fields.description.trim() : '',
      color: typeof fields.color === 'string' ? fields.color.trim() : '',
    }
  })
}

/**
 * Build the request body for POST/PUT /users. Wrapped in a { user: {...} }
 * envelope by callers. `type` is set explicitly so the API resolves the
 * resource unambiguously. `role` is left unset when not chosen — PagerDuty
 * applies its own default rather than this app defaulting to "user".
 */
export function buildUserBody(spec: UserSpec): LiveUser {
  const body: LiveUser = { type: 'user', name: spec.name, email: spec.email }
  if (spec.role) body.role = spec.role
  if (spec.jobTitle) body.job_title = spec.jobTitle
  if (spec.timeZone) body.time_zone = spec.timeZone
  if (spec.description) body.description = spec.description
  if (spec.color) body.color = spec.color
  return body
}

/** Rebuild a user body from its prior live shape (used by rollback restore). */
export function userRestoreBody(prior: LiveUser): LiveUser {
  const body: LiveUser = { type: 'user', name: String(prior.name ?? ''), email: String(prior.email ?? '') }
  if (prior.role) body.role = prior.role
  if (prior.job_title) body.job_title = prior.job_title
  if (prior.time_zone) body.time_zone = prior.time_zone
  if (prior.description) body.description = prior.description
  if (prior.color) body.color = prior.color
  return body
}

/** Find a live user by email (case-insensitive — the reconciliation identity). */
export function findUser(users: LiveUser[], email: string): LiveUser | null {
  const e = email.trim().toLowerCase()
  if (!e) return null
  return users.find((u) => String(u.email ?? '').trim().toLowerCase() === e) ?? null
}
