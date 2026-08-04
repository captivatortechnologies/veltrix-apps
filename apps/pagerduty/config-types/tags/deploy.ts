import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildPagerDutyClient,
  pagerDutyErrorMessage,
  parseJson,
  type PagerDutyClient,
} from '../../lib/pagerdutyApi'
import {
  buildTagBody,
  extractTagSpecs,
  parseAssignments,
  resolveEntityId,
  type EntityLookups,
  type LiveEscalationPolicyRef,
  type LiveTag,
  type LiveTeamRef,
  type LiveUserRef,
} from './_shared'

/** One (entity_type, entityId) pair this deploy newly attached the tag to. */
export interface TagAssignmentRecord {
  entity_type: string
  entity_id: string
}

/** Per-tag rollback record captured during deploy. */
export interface TagRollbackEntry {
  label: string
  existed: boolean
  id?: string
  /** Assignments added THIS deploy — the only ones rollback should remove. */
  addedAssignments: TagAssignmentRecord[]
}

/**
 * Deploy PagerDuty tags over the REST API v2:
 *   read (rollback): GET  /tags                             → find each live tag by label
 *   resolve refs:     GET  /users, /teams, /escalation_policies → entity_name → id
 *   create:           POST /tags                             with { tag: {...} }
 *   assign:           POST /{entity_type}/{id}/change_tags    with { add: [...] }
 *
 * The label is the stable identity used to upsert; PagerDuty tags have no other
 * mutable fields, so a pre-existing tag is never PUT — only its assignments change.
 * For a pre-existing tag we check GET /{entity_type}/{id}/tags before assigning, so
 * rollbackData records ONLY the (entity_type, id) pairs this deploy newly attached
 * — pre-existing assignments are left untouched by rollback. A brand-new tag needs
 * no such check (nothing can already carry a tag that didn't exist yet); deleting
 * it on rollback cascades all of its assignments.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildPagerDutyClient(ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const specs = extractTagSpecs(ctx.canvas).filter((s) => s.label)
  const rollbackState: TagRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    const existing = await listTags(client)
    const byLabel = new Map(existing.filter((t) => t.label).map((t) => [String(t.label).toLowerCase(), t]))
    const lookups = await loadEntityLookups(client)

    for (const spec of specs) {
      const parsed = parseAssignments(spec.assignmentsJson)
      if (parsed.error || !parsed.assignments) {
        throw new Error(`Tag "${spec.label}" has invalid assignments: ${parsed.error ?? 'unknown'}`)
      }

      const live = byLabel.get(spec.label.toLowerCase())
      let tagId: string
      let existed: boolean

      if (live?.id) {
        tagId = live.id
        existed = true
      } else {
        const res = await client.request('POST', '/tags', { body: { tag: buildTagBody(spec) } })
        if (!res.ok) throw new Error(`Failed to create tag "${spec.label}": ${pagerDutyErrorMessage(res)}`)
        const created = parseJson<{ tag?: LiveTag }>(res.body)?.tag
        if (!created?.id) throw new Error(`Tag "${spec.label}" was created but the API returned no id`)
        tagId = created.id
        existed = false
        createdIds.push(tagId)
      }

      const addedAssignments: TagAssignmentRecord[] = []
      for (const assignment of parsed.assignments) {
        const entityId = resolveEntityId(assignment.entity_type, assignment.entity_name, lookups)
        if (!entityId) {
          throw new Error(
            `Tag "${spec.label}" assignment references ${assignment.entity_type} "${assignment.entity_name}" which was not found in the account`,
          )
        }

        const alreadyTagged =
          existed && (await listEntityTags(client, assignment.entity_type, entityId)).some((t) => t.id === tagId)
        if (alreadyTagged) continue

        const res = await client.request(
          'POST',
          `/${assignment.entity_type}/${encodeURIComponent(entityId)}/change_tags`,
          { body: { add: [{ type: 'tag_reference', id: tagId }] } },
        )
        if (!res.ok) {
          throw new Error(
            `Failed to assign tag "${spec.label}" to ${assignment.entity_type} "${assignment.entity_name}": ${pagerDutyErrorMessage(res)}`,
          )
        }
        addedAssignments.push({ entity_type: assignment.entity_type, entity_id: entityId })
      }

      rollbackState.push({ label: spec.label, existed, id: tagId, addedAssignments })
      deployed.push(spec.label)
    }

    return {
      success: true,
      message: `Applied ${deployed.length} tag(s): ${deployed.join(', ') || '(none)'}`,
      artifacts: { deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Tag deploy failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

/** List all tags in the account; throws on a non-OK response. */
export async function listTags(client: PagerDutyClient): Promise<LiveTag[]> {
  const res = await client.getAll<LiveTag>('/tags', 'tags')
  if (!res.ok) {
    throw new Error(`Failed to list tags: ${pagerDutyErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  }
  return res.items
}

/** List all tags currently assigned to one entity (idempotent-assign + drift check). */
export async function listEntityTags(
  client: PagerDutyClient,
  entityType: string,
  entityId: string,
): Promise<LiveTag[]> {
  const res = await client.getAll<LiveTag>(`/${entityType}/${encodeURIComponent(entityId)}/tags`, 'tags')
  if (!res.ok) {
    throw new Error(
      `Failed to list tags for ${entityType} "${entityId}": ${pagerDutyErrorMessage({ status: res.status, ok: false, body: res.body })}`,
    )
  }
  return res.items
}

/** List all users (email → id resolution for a "users" assignment). */
export async function listUsers(client: PagerDutyClient): Promise<LiveUserRef[]> {
  const res = await client.getAll<LiveUserRef>('/users', 'users')
  if (!res.ok) {
    throw new Error(`Failed to list users: ${pagerDutyErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  }
  return res.items
}

/** List all teams (name → id resolution for a "teams" assignment). */
export async function listTeams(client: PagerDutyClient): Promise<LiveTeamRef[]> {
  const res = await client.getAll<LiveTeamRef>('/teams', 'teams')
  if (!res.ok) {
    throw new Error(`Failed to list teams: ${pagerDutyErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  }
  return res.items
}

/** List all escalation policies (name → id resolution for an "escalation_policies" assignment). */
export async function listEscalationPolicies(client: PagerDutyClient): Promise<LiveEscalationPolicyRef[]> {
  const res = await client.getAll<LiveEscalationPolicyRef>('/escalation_policies', 'escalation_policies')
  if (!res.ok) {
    throw new Error(
      `Failed to list escalation policies: ${pagerDutyErrorMessage({ status: res.status, ok: false, body: res.body })}`,
    )
  }
  return res.items
}

/** Fetch the three entity lists an assignment's entity_name might resolve against. */
export async function loadEntityLookups(client: PagerDutyClient): Promise<EntityLookups> {
  const [users, teams, escalationPolicies] = await Promise.all([
    listUsers(client),
    listTeams(client),
    listEscalationPolicies(client),
  ])
  return { users, teams, escalation_policies: escalationPolicies }
}
