// Shared helpers for the Tines Team Members (RBAC) config type
// (validate + deploy + rollback + drift + health).
//
// A Tines team membership is keyed for reconciliation by (team_id, email).
// There is NO update-role endpoint, so a role change can only be detected
// (drift), never auto-corrected — see deploy.ts.
//
// Docs (fetched 2026-08-05): https://www.tines.com/api/teams
//   list:   GET  /api/v1/teams/{team_id}/members         -> { members: [...], meta }
//   invite: POST /api/v1/teams/{team_id}/invite_member   <- { email, role? } -> user object
//   remove: POST /api/v1/teams/{team_id}/remove_member   <- { user_id }      -> { deleted_id }

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** A team member as returned by the Tines Team Members API. */
export interface LiveMember {
  id?: number | string
  email?: string
  first_name?: string
  last_name?: string
  is_admin?: boolean
  invitation_accepted?: boolean
  role?: string
}

/** One canvas item, normalized to the fields this config type manages. */
export interface TeamMemberSpec {
  itemName: string
  teamId: string
  email: string
  role: string
}

export function extractTeamMemberSpecs(canvas: CanvasSnapshot): TeamMemberSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const fields = item.fields ?? {}
    return {
      itemName: item.name,
      teamId: typeof fields.team_id === 'string' ? fields.team_id.trim() : String(fields.team_id ?? '').trim(),
      email: typeof fields.email === 'string' ? fields.email.trim().toLowerCase() : '',
      role: typeof fields.role === 'string' ? fields.role.trim() : '',
    }
  })
}

export function isValidEmail(email: string): boolean {
  return EMAIL_RE.test(email)
}

/** Build the request body for POST /teams/{team_id}/invite_member. */
export function buildInviteBody(spec: TeamMemberSpec): { email: string; role?: string } {
  const body: { email: string; role?: string } = { email: spec.email }
  if (spec.role) body.role = spec.role
  return body
}

/** Find a live member by email (case-insensitive — half of the reconciliation identity; team scoping is the list call itself). */
export function findMember(members: LiveMember[], email: string): LiveMember | null {
  const e = email.trim().toLowerCase()
  if (!e) return null
  return members.find((m) => String(m.email ?? '').trim().toLowerCase() === e) ?? null
}
