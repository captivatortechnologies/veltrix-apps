import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient, oktaErrorMessage, parseJson, type OktaClient } from '../../lib/okta'
import {
  extractAppGroupAssignmentSpecs,
  parseJsonObject,
  type AppGroupAssignmentSpec,
  type LiveAppGroupAssignment,
} from './validate'

export interface AppGroupAssignmentRollbackEntry {
  /** Parent application id — needed to build the assignment's REST path. */
  appId: string
  /** Group id — the other half of the path and the assignment's id. */
  groupId: string
  /** True when the assignment already existed before this deploy PUT it. */
  existed: boolean
  /**
   * Prior assignment body (priority/profile) with server-managed readOnly fields
   * stripped, replayed via PUT on rollback. Only set when `existed` is true.
   */
  prior?: Record<string, unknown>
}

/** Server-managed fields Okta returns on an assignment but that must never be sent back. */
export const READONLY_ASSIGNMENT_FIELDS = [
  'id',
  'created',
  'lastUpdated',
  '_links',
  '_embedded',
] as const

/**
 * Deploy app-group assignments to an Okta org. An assignment binds a GROUP to an
 * APPLICATION, so every route is nested under `/apps/{appId}/groups` and keyed by
 * the group id. Okta's assign is a PUT — an idempotent create-or-update — so
 * there is no separate list/match/POST dance; but each assignment is still GET
 * first to record whether it pre-existed:
 *   - GET /apps/{appId}/groups/{groupId}   — capture pre-existence + prior body
 *   - PUT /apps/{appId}/groups/{groupId}   — assign (create or update)
 *
 * On rollback a CREATED assignment is DELETEd; a PRE-EXISTING one is restored to
 * its captured prior priority/profile. Unmanaged assignments on the app are NEVER
 * pruned — only the declared (appId, groupId) pairs are touched.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractAppGroupAssignmentSpecs(ctx.canvas).filter((s) => s.appId && s.groupId)
  const rollbackState: AppGroupAssignmentRollbackEntry[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const label = `${spec.appId}:${spec.groupId}`

      // GET first so rollback knows whether we CREATED this assignment (delete on
      // rollback) or UPDATED an existing one (restore its prior priority/profile).
      const existing = await getAssignment(client, spec.appId, spec.groupId)

      if (existing) {
        rollbackState.push({
          appId: spec.appId,
          groupId: spec.groupId,
          existed: true,
          prior: stripReadOnlyAssignmentFields(existing),
        })
      } else {
        rollbackState.push({ appId: spec.appId, groupId: spec.groupId, existed: false })
      }

      // Assign is an idempotent PUT; the path carries appId + groupId, the body
      // carries only priority/profile.
      const res = await client.request('PUT', `/apps/${spec.appId}/groups/${spec.groupId}`, {
        body: buildAssignmentBody(spec),
      })
      if (!res.ok) {
        throw new Error(`Failed to assign group to app "${label}": ${oktaErrorMessage(res)}`)
      }

      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} app-group assignment(s) to Okta org at ${baseUrl}: ${
        deployed.join(', ') || 'none'
      }.`,
      artifacts: { baseUrl, deployedAssignments: deployed },
      rollbackData: { previousState: rollbackState, createdIds: [] },
    }
  } catch (error) {
    return {
      success: false,
      message: `App-group assignment deployment failed after ${deployed.length} of ${specs.length} assignment(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedAssignments: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState, createdIds: [] },
    }
  }
}

// --- Helpers ------------------------------------------------------------------

/**
 * Fetch a single app-group assignment by (appId, groupId); null on 404 (not
 * assigned). The assignment id equals the groupId, so the path fully identifies
 * it — no list/match needed.
 */
export async function getAssignment(
  client: OktaClient,
  appId: string,
  groupId: string,
): Promise<LiveAppGroupAssignment | null> {
  const res = await client.request('GET', `/apps/${appId}/groups/${groupId}`)
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(
      `Failed to fetch assignment of group "${groupId}" to app "${appId}": ${oktaErrorMessage(res)}`,
    )
  }
  return parseJson<LiveAppGroupAssignment>(res.body)
}

/**
 * Build the assign (PUT) body from the modeled fields. Both fields are optional:
 * priority is sent only when authored (blank leaves Okta's own priority), and
 * profile is sent only when profileJson parses to an object. An empty body is a
 * valid assign (bind the group with no overrides). The path — never the body —
 * carries the identity, so free-form profile can never override it.
 */
export function buildAssignmentBody(spec: AppGroupAssignmentSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  if (spec.priority !== undefined) body.priority = spec.priority
  const profile = spec.profileJson ? parseJsonObject(spec.profileJson) : null
  if (profile) body.profile = profile
  return body
}

/** Copy a live assignment without the server-managed readOnly fields (safe to PUT back). */
export function stripReadOnlyAssignmentFields(assignment: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(assignment)) {
    if (!(READONLY_ASSIGNMENT_FIELDS as readonly string[]).includes(key)) out[key] = value
  }
  return out
}
