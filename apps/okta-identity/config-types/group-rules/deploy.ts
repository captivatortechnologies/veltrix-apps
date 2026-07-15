import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient, oktaErrorMessage, parseJson, type OktaClient } from '../../lib/okta'
import {
  extractGroupRuleSpecs,
  liveExpression,
  liveGroupIds,
  sameGroupIds,
  OKTA_EXPRESSION_TYPE,
  type GroupRuleSpec,
  type LiveGroupRule,
} from './validate'

export interface GroupRuleRollbackEntry {
  name: string
  /** How deploy changed this rule — drives how rollback reverts it. */
  action: 'created' | 'updated' | 'rebuilt'
  /**
   * Id of the rule deploy left live afterwards: for `created` and `rebuilt`
   * this is the NEW id (rollback deletes it); for `updated` it is the same id
   * the rule already had (rollback restores it in place).
   */
  liveId?: string
  /**
   * Prior live rule (full body incl. status) for `updated` and `rebuilt`, so
   * rollback can restore it in place (updated) or recreate it (rebuilt). Absent
   * for `created` — the rule did not exist before.
   */
  prior?: LiveGroupRule
}

/**
 * Deploy dynamic group rules to an Okta org via the Group Rules API.
 *
 * A group rule assigns every user matching an Okta EL expression to one or more
 * groups. Its logical identity is the NAME; the id Okta assigns is the stable
 * key used for rollback. NO UPSERT endpoint exists — deploy LISTs the rules,
 * matches on `name`, then applies the Okta lifecycle rules exactly:
 *
 *   1. absent → POST (rules are born INACTIVE) → activate if desired ACTIVE.
 *   2. present, target groups UNCHANGED → deactivate (a rule must be INACTIVE to
 *      accept a PUT) → PUT name/expression → activate iff desired ACTIVE.
 *   3. present, target groups CHANGED → the `actions` block is IMMUTABLE on PUT,
 *      so the change cannot be applied in place: DELETE the old rule and POST a
 *      fresh one (noted in the message as a rebuild).
 *
 * Prior bodies / created ids are captured so rollback can revert each branch.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractGroupRuleSpecs(ctx.canvas).filter(
    (s) => s.name && s.expression && s.groupIds.length > 0,
  )
  const rollbackState: GroupRuleRollbackEntry[] = []
  const createdRuleIds: string[] = []
  const deployed: string[] = []

  try {
    // One list call resolves every declared rule by name.
    const liveRules = await listGroupRules(client)

    for (const spec of specs) {
      const label = spec.name
      const existing = liveRules.find((r) => r.name === spec.name) ?? null

      if (!existing || !existing.id) {
        // BRANCH 1 — absent. POST creates the rule INACTIVE; activate if desired.
        const created = await createRule(client, spec)
        rollbackState.push({ name: spec.name, action: 'created', liveId: created.id })
        createdRuleIds.push(created.id)
        if (spec.status === 'ACTIVE') {
          await lifecycleTransition(client, created.id, 'activate', label)
        }
        deployed.push(label)
        continue
      }

      // A system-managed rule must never be modified or deleted.
      if (existing.system) {
        throw new Error(`Group rule "${label}" is system-managed and cannot be modified`)
      }

      if (sameGroupIds(spec.groupIds, liveGroupIds(existing))) {
        // BRANCH 2 — present, target groups unchanged. A rule must be INACTIVE to
        // accept a PUT, so deactivate first (only if currently active), replace
        // the mutable fields, then restore the desired status.
        rollbackState.push({ name: spec.name, action: 'updated', liveId: existing.id, prior: existing })

        if ((existing.status ?? '').toUpperCase() === 'ACTIVE') {
          await lifecycleTransition(client, existing.id, 'deactivate', label)
        }
        // Re-send the LIVE group ids in the actions block: the set is identical,
        // and echoing the live ordering guarantees Okta accepts the immutable
        // block without complaint.
        const res = await client.request('PUT', `/groups/rules/${existing.id}`, {
          body: buildRuleBody({
            name: spec.name,
            expression: spec.expression,
            groupIds: liveGroupIds(existing),
          }),
        })
        if (!res.ok) {
          throw new Error(`Failed to update group rule "${label}": ${oktaErrorMessage(res)}`)
        }
        if (spec.status === 'ACTIVE') {
          await lifecycleTransition(client, existing.id, 'activate', label)
        }
        deployed.push(label)
        continue
      }

      // BRANCH 3 — present, target groups CHANGED. The `actions` block is
      // immutable, so a PUT cannot apply the change — delete the old rule and
      // recreate it. Capture the prior body first so rollback can rebuild it.
      const entry: GroupRuleRollbackEntry = { name: spec.name, action: 'rebuilt', prior: existing }
      rollbackState.push(entry)
      await deleteGroupRule(client, existing.id, label)
      const rebuilt = await createRule(client, spec)
      entry.liveId = rebuilt.id
      createdRuleIds.push(rebuilt.id)
      if (spec.status === 'ACTIVE') {
        await lifecycleTransition(client, rebuilt.id, 'activate', label)
      }
      deployed.push(`${label} (rebuilt — target groups are immutable, so the rule was deleted and recreated)`)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} group rule(s) to Okta org at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedRules: deployed },
      rollbackData: { previousState: rollbackState, createdRuleIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Group rule deployment failed after ${deployed.length} of ${specs.length} rule(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedRules: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState, createdRuleIds },
    }
  }
}

// --- Helpers ---

/** List every group rule (follows pagination). Throws on a non-OK response. */
export async function listGroupRules(client: OktaClient): Promise<LiveGroupRule[]> {
  const res = await client.getAll<LiveGroupRule>('/groups/rules')
  if (!res.ok) {
    throw new Error(
      `Failed to list group rules: ${oktaErrorMessage({ status: res.status, ok: res.ok, body: res.body, nextUrl: null })}`,
    )
  }
  return res.items
}

/** Find a group rule by its `name`; null when absent (exact, case-sensitive). */
export async function findGroupRuleByName(client: OktaClient, name: string): Promise<LiveGroupRule | null> {
  const rules = await listGroupRules(client)
  return rules.find((r) => r.name === name) ?? null
}

/** POST a new rule (born INACTIVE); returns the live rule with a guaranteed id. */
export async function createRule(
  client: OktaClient,
  spec: GroupRuleSpec,
): Promise<LiveGroupRule & { id: string }> {
  const res = await client.request('POST', '/groups/rules', {
    body: buildRuleBody({ name: spec.name, expression: spec.expression, groupIds: spec.groupIds }),
  })
  if (!res.ok) {
    throw new Error(`Failed to create group rule "${spec.name}": ${oktaErrorMessage(res)}`)
  }
  const created = parseJson<LiveGroupRule>(res.body)
  if (!created?.id) {
    throw new Error(`Group rule "${spec.name}" was created but the API returned no id`)
  }
  return { ...created, id: created.id }
}

/** POST a lifecycle transition; throws with context on failure. */
export async function lifecycleTransition(
  client: OktaClient,
  id: string,
  action: 'activate' | 'deactivate',
  label: string,
): Promise<void> {
  const res = await client.request('POST', `/groups/rules/${id}/lifecycle/${action}`)
  if (!res.ok) {
    throw new Error(`Failed to ${action} group rule "${label}": ${oktaErrorMessage(res)}`)
  }
}

/**
 * Deactivate a rule tolerantly (a rule already INACTIVE, or a 404, is fine) then
 * DELETE it — a group rule must be INACTIVE before it can be deleted. A 404 on
 * the delete means the rule is already gone, which is the desired end state.
 */
export async function deleteGroupRule(client: OktaClient, id: string, label: string): Promise<void> {
  const deactivate = await client.request('POST', `/groups/rules/${id}/lifecycle/deactivate`)
  // Tolerate a non-OK deactivate: the rule may already be INACTIVE (or gone).
  // The DELETE below fails loudly if it is somehow still active.
  if (!deactivate.ok && deactivate.status !== 404 && deactivate.status !== 400) {
    throw new Error(`Failed to deactivate group rule "${label}" before delete: ${oktaErrorMessage(deactivate)}`)
  }
  const res = await client.request('DELETE', `/groups/rules/${id}`)
  if (res.status !== 404 && !res.ok) {
    throw new Error(`Failed to delete group rule "${label}": ${oktaErrorMessage(res)}`)
  }
}

/** Build a group-rule request body (used for both POST and PUT). */
export function buildRuleBody(opts: {
  name: string
  expression: string
  groupIds: string[]
}): Record<string, unknown> {
  return {
    type: 'group_rule',
    name: opts.name,
    conditions: {
      expression: { value: opts.expression, type: OKTA_EXPRESSION_TYPE },
    },
    actions: {
      // ACTION KEY IS `assignUserToGroups` (NOT assignUsers).
      assignUserToGroups: { groupIds: opts.groupIds },
    },
  }
}

/** Build a request body that recreates a captured live rule verbatim. */
export function bodyFromLive(live: LiveGroupRule): Record<string, unknown> {
  return buildRuleBody({
    name: live.name ?? '',
    expression: liveExpression(live),
    groupIds: liveGroupIds(live),
  })
}
