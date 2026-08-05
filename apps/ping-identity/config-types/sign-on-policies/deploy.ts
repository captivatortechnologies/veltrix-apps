import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildPingOneClient, parseJson, pingOneErrorMessage, type PingOneClient } from '../../lib/pingOne'
import {
  ACTION_READONLY_FIELDS,
  POLICY_READONLY_FIELDS,
  actionPriority,
  extractPolicySpecs,
  parseActionsArray,
  stripReadOnly,
  type LiveAction,
  type LivePolicy,
  type PolicySpec,
} from './validate'

/** Prior state of one reconciled action, captured so rollback can revert it. */
export interface ActionRollbackEntry {
  priority: number
  /** True when the action existed on the live policy before this deploy (updated), false when created. */
  existed: boolean
  id?: string
  /** Prior action body (read-only fields stripped), captured for an updated action. */
  prior?: Record<string, unknown>
}

/** Prior state of one policy (and its reconciled actions), captured for rollback. */
export interface PolicyRollbackEntry {
  name: string
  /** True when the policy existed before this deploy (updated), false when created. */
  existed: boolean
  id?: string
  /** Prior policy body (read-only fields stripped), captured for an updated policy. */
  prior?: Record<string, unknown>
  actionRollback: ActionRollbackEntry[]
}

/**
 * Deploy PingOne sign-on policies (and their ordered actions) via the
 * Management API.
 *
 * PingOne has NO upsert. For each declared policy:
 *   - GET  /signOnPolicies              - list, then match on name
 *   - PUT  /signOnPolicies/{id}         - replace an existing policy (capture prior body)
 *   - POST /signOnPolicies              - create a missing policy (capture new id)
 * then reconcile its actions BY PRIORITY (list once, map by priority; PUT a
 * matching priority / POST a new one; never delete an action the array does
 * not mention - mirrors Okta's non-destructive rule-by-name reconciliation,
 * substituting `priority` for `name` since actions carry no name field).
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildPingOneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, environmentId } = built

  const specs = extractPolicySpecs(ctx.canvas).filter((s) => s.name)
  const previousState: PolicyRollbackEntry[] = []
  const createdPolicyIds: string[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      // Re-parse actionsJson here (validated upstream) to build the API bodies
      // and to fail loudly rather than send malformed content.
      const actions = resolveActions(spec)

      const existing = await findPolicyByName(client, spec.name)
      const entry: PolicyRollbackEntry = { name: spec.name, existed: false, actionRollback: [] }
      let policyId: string

      if (existing && existing.id) {
        policyId = existing.id
        entry.existed = true
        entry.id = policyId
        entry.prior = stripReadOnly(existing as Record<string, unknown>, POLICY_READONLY_FIELDS)

        const res = await client.request('PUT', `/signOnPolicies/${policyId}`, { body: buildPolicyBody(spec) })
        if (!res.ok) {
          throw new Error(`Failed to update sign-on policy "${spec.name}": ${pingOneErrorMessage(res)}`)
        }
      } else {
        const res = await client.request('POST', '/signOnPolicies', { body: buildPolicyBody(spec) })
        if (!res.ok) {
          throw new Error(`Failed to create sign-on policy "${spec.name}": ${pingOneErrorMessage(res)}`)
        }
        const created = parseJson<LivePolicy>(res.body)
        if (!created?.id) {
          throw new Error(`Sign-on policy "${spec.name}" was created but the API returned no id`)
        }
        policyId = created.id
        entry.id = policyId
        createdPolicyIds.push(policyId)
      }

      previousState.push(entry)

      if (actions) {
        await reconcileActions(client, policyId, actions, entry, spec.name)
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} sign-on policy(ies) to PingOne environment ${environmentId}: ${deployed.join(', ')}`,
      artifacts: { environmentId, deployedPolicies: deployed },
      rollbackData: { previousState, createdPolicyIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Sign-on policy deployment failed after ${deployed.length} of ${specs.length} policy(ies): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { environmentId, deployedPolicies: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState, createdPolicyIds },
    }
  }
}

// --- Helpers ------------------------------------------------------------------

/** Find a policy by exact name across the paginated policy list; null when absent. */
export async function findPolicyByName(client: PingOneClient, name: string): Promise<LivePolicy | null> {
  const res = await client.getAll<LivePolicy>('/signOnPolicies', 'signOnPolicies')
  if (!res.ok) {
    throw new Error(`Failed to list sign-on policies while resolving "${name}": ${pingOneErrorMessage(res)}`)
  }
  return res.items.find((p) => p.name === name) ?? null
}

/** List every action under a policy (following pagination). */
export async function listActions(client: PingOneClient, policyId: string): Promise<LiveAction[]> {
  const res = await client.getAll<LiveAction>(`/signOnPolicies/${policyId}/actions`, 'actions')
  if (!res.ok) {
    throw new Error(`Failed to list actions for sign-on policy ${policyId}: ${pingOneErrorMessage(res)}`)
  }
  return res.items
}

/** Assemble the create/replace policy body (PUT is a full replace). */
export function buildPolicyBody(spec: PolicySpec): Record<string, unknown> {
  return {
    name: spec.name,
    // Always send description so clearing it on the canvas converges the
    // policy, and always send `default` so unchecking it converges too (see
    // canvas.yaml: PingOne enforces the "exactly one default" invariant
    // itself when this is set true).
    description: spec.description ?? '',
    default: spec.default,
  }
}

/** Parse the actions array for reconciliation; null when actionsJson is blank. */
function resolveActions(spec: PolicySpec): Record<string, unknown>[] | null {
  if (!spec.actionsJson) return null
  const actions = parseActionsArray(spec.actionsJson)
  if (!actions) {
    throw new Error(`Sign-on policy "${spec.name}": actions are not a valid JSON array`)
  }
  return actions.map((action, index) => {
    if (!action || typeof action !== 'object' || Array.isArray(action)) {
      throw new Error(`Sign-on policy "${spec.name}": action at index ${index} is not a JSON object`)
    }
    if (actionPriority(action) === null) {
      throw new Error(`Sign-on policy "${spec.name}": action at index ${index} has no numeric "priority"`)
    }
    return action as Record<string, unknown>
  })
}

/**
 * Reconcile the actions under a policy BY PRIORITY:
 *   - an action whose priority matches a live action is REPLACED (PUT) in place
 *   - an action with no live match at that priority is CREATED (POST)
 *   - actions the array does not mention are LEFT ALONE (never pruned)
 * Prior/created state is recorded on the rollback entry.
 */
async function reconcileActions(
  client: PingOneClient,
  policyId: string,
  actions: Record<string, unknown>[],
  entry: PolicyRollbackEntry,
  policyName: string,
): Promise<void> {
  const live = await listActions(client, policyId)
  const byPriority = new Map<number, LiveAction>()
  for (const liveAction of live) {
    if (typeof liveAction.priority === 'number') byPriority.set(liveAction.priority, liveAction)
  }

  for (const action of actions) {
    const priority = actionPriority(action) as number
    const match = byPriority.get(priority)
    const label = `${policyName} action (priority ${priority})`

    if (match && match.id) {
      entry.actionRollback.push({
        priority,
        existed: true,
        id: match.id,
        prior: stripReadOnly(match as Record<string, unknown>, ACTION_READONLY_FIELDS),
      })
      const res = await client.request('PUT', `/signOnPolicies/${policyId}/actions/${match.id}`, { body: action })
      if (!res.ok) {
        throw new Error(`Failed to update ${label}: ${pingOneErrorMessage(res)}`)
      }
    } else {
      const res = await client.request('POST', `/signOnPolicies/${policyId}/actions`, { body: action })
      if (!res.ok) {
        throw new Error(`Failed to create ${label}: ${pingOneErrorMessage(res)}`)
      }
      const created = parseJson<LiveAction>(res.body)
      if (created?.id) {
        entry.actionRollback.push({ priority, existed: false, id: created.id })
      }
    }
  }
}
