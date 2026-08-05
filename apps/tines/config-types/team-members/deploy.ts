import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildTinesClient, tinesErrorMessage, parseJson, type TinesClient } from '../../lib/tinesApi'
import { buildInviteBody, extractTeamMemberSpecs, findMember, type LiveMember } from './_shared'

/** Per-membership rollback record captured during deploy. */
export interface TeamMemberRollbackEntry {
  itemName: string
  teamId: string
  email: string
  /** true when this deploy invited the member (rollback removes them); false when they already existed (rollback leaves them alone). */
  invited: boolean
  userId?: string
}

/**
 * Deploy Tines Team Members over the REST API — ADDITIVE ONLY:
 *   read:   GET  /api/v1/teams/{team_id}/members
 *   invite: POST /api/v1/teams/{team_id}/invite_member  <- { email, role? }
 *
 * A declared (team, email) not yet on the team is invited. A member already
 * on the team is left untouched — including when their live `role` differs
 * from the declared one, since Tines has no update-role endpoint; a mismatch
 * surfaces as drift instead (see driftDetect.ts). A member present on the
 * team but ABSENT from the canvas is never removed (avoids accidentally
 * deprovisioning access from a stale canvas).
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildTinesClient(ctx.component?.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const specs = extractTeamMemberSpecs(ctx.canvas).filter((s) => s.teamId && s.email)
  const rollbackState: TeamMemberRollbackEntry[] = []
  const invited: string[] = []
  const alreadyPresent: string[] = []
  const roleMismatches: string[] = []
  const membersByTeam = new Map<string, LiveMember[]>()

  try {
    for (const spec of specs) {
      let members = membersByTeam.get(spec.teamId)
      if (!members) {
        members = await listMembers(client, spec.teamId)
        membersByTeam.set(spec.teamId, members)
      }

      const match = findMember(members, spec.email)
      if (match) {
        alreadyPresent.push(spec.email)
        if (spec.role && match.role && match.role !== spec.role) {
          roleMismatches.push(`${spec.email} (live: ${match.role}, declared: ${spec.role})`)
        }
        rollbackState.push({ itemName: spec.itemName, teamId: spec.teamId, email: spec.email, invited: false })
        continue
      }

      const res = await client.request('POST', `/teams/${spec.teamId}/invite_member`, { body: buildInviteBody(spec) })
      if (!res.ok) throw new Error(`Failed to invite "${spec.email}" to team ${spec.teamId}: ${tinesErrorMessage(res)}`)
      const created = parseJson<{ id?: number | string }>(res.body)
      rollbackState.push({
        itemName: spec.itemName,
        teamId: spec.teamId,
        email: spec.email,
        invited: true,
        userId: created?.id !== undefined ? String(created.id) : undefined,
      })
      members.push({ id: created?.id, email: spec.email, role: spec.role || undefined })
      invited.push(spec.email)
    }

    const notes: string[] = []
    if (roleMismatches.length > 0) {
      notes.push(
        `NOTE: role mismatch for ${roleMismatches.length} existing member(s) (${roleMismatches.join('; ')}) — Tines has no update-role API, so this could not be corrected in place; see drift detection.`,
      )
    }

    return {
      success: true,
      message: [
        `Invited ${invited.length} member(s): ${invited.join(', ') || '(none)'}.`,
        `${alreadyPresent.length} already present.`,
        ...notes,
      ].join(' '),
      artifacts: { invited, alreadyPresent },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Team Members deploy failed after inviting ${invited.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { invited, alreadyPresent },
      rollbackData: { previousState: rollbackState },
    }
  }
}

/** List all members of a team; throws on a non-OK response. */
export async function listMembers(client: TinesClient, teamId: string): Promise<LiveMember[]> {
  const res = await client.getAll<LiveMember>(`/teams/${teamId}/members`, 'members')
  if (!res.ok) {
    throw new Error(`Failed to list members of team ${teamId}: ${tinesErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  }
  return res.items
}
