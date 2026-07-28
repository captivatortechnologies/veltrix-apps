import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildFalconClient,
  falconFailure,
  fqlEscape,
  parseEnvelope,
  type FalconClient,
  type FalconResponse,
} from '../../lib/falcon'
import {
  findEntityByIdentity,
  updateEntity,
  type EntityEndpoints,
  type LiveEntity,
} from '../../lib/entityAdapter'
import {
  actionKey,
  extractReconRuleSpecs,
  parseActions,
  type ActionSpec,
  type LiveAction,
  type ReconRuleSpec,
} from './validate'

/** Paths for the Recon monitoring-rules API surface (identity: name). */
export const RECON_RULE_ENDPOINTS: EntityEndpoints = {
  entity: '/recon/entities/rules/v1',
  queries: '/recon/queries/rules/v1',
  identityField: 'name',
}

/** Paths for the Recon notification-actions API surface (the rule's child). */
export const RECON_ACTION_ENTITY = '/recon/entities/actions/v1'
export const RECON_ACTION_QUERIES = '/recon/queries/actions/v1'

/** Prior values of a live action this deploy updated, so rollback can restore it. */
export interface ActionRestore {
  id: string
  frequency: string
  recipients: string[]
  content_format: string
}

/** Rule fields this app manages and can restore on rollback (topic is immutable). */
export interface ReconRuleRollbackEntry {
  name: string
  existed: boolean
  id?: string
  prior?: {
    name?: string
    filter?: string
    priority?: string
    permissions?: string
    breach_monitoring_enabled?: boolean
    substring_matching_enabled?: boolean
  }
  /** Action ids THIS deploy created (removed on rollback). */
  createdActionIds: string[]
  /** Live actions THIS deploy updated, with their prior values (restored on rollback). */
  updatedActions: ActionRestore[]
  /** Pre-existing actions THIS deploy deleted (recreated on rollback). */
  deletedActions: ActionSpec[]
}

/**
 * Deploy Recon monitoring rules to a Falcon tenant via the Recon API.
 *
 * For each declared rule:
 *   - find it by its `name` identity
 *   - if it exists, PATCH the mutable fields (topic is immutable, so it is never
 *     sent on update); otherwise POST a new rule (the create body is a JSON
 *     array of rule objects and carries the topic)
 *   - converge the declared notification actions against the rule's live actions:
 *     create missing, update a content-format change, delete undeclared ones
 *
 * Prior rule state and the action ids/updates this deploy made are captured so
 * rollback can revert updates and delete anything this deploy created. Deleting
 * a rule cascades its actions.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractReconRuleSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: ReconRuleRollbackEntry[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const { actions, errors: actionErrors } = parseActions(spec.actionsRaw)
      if (actionErrors.length > 0) {
        throw new Error(`Rule "${spec.name}": invalid actions — ${actionErrors[0]}`)
      }

      const existing = await findEntityByIdentity(client, RECON_RULE_ENDPOINTS, spec.name)

      let entry: ReconRuleRollbackEntry
      let ruleId: string

      if (existing?.id) {
        entry = {
          name: spec.name,
          existed: true,
          id: existing.id,
          prior: capturePrior(existing),
          createdActionIds: [],
          updatedActions: [],
          deletedActions: [],
        }
        rollbackState.push(entry)
        ruleId = existing.id

        // topic is immutable — never sent on update
        await updateEntity(client, RECON_RULE_ENDPOINTS, {
          id: existing.id,
          ...buildRuleMutableFields(spec),
        })
      } else {
        ruleId = await createRule(client, spec)
        entry = {
          name: spec.name,
          existed: false,
          id: ruleId,
          createdActionIds: [],
          updatedActions: [],
          deletedActions: [],
        }
        rollbackState.push(entry)
      }

      // Only manage actions when the canvas declares an actions value — a blank
      // field leaves pre-existing actions untouched (consistent with driftDetect,
      // which also treats a blank actions field as unmanaged).
      if (spec.actionsRaw) {
        await convergeActions(client, ruleId, actions, entry)
      }
      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} Recon monitoring rule(s) to Falcon tenant at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedRules: deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Recon monitoring rule deployment failed after ${deployed.length} of ${specs.length} rule(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedRules: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState },
    }
  }
}

// --- Rule helpers shared with rollback / driftDetect / healthCheck -----------

/** The mutable rule fields this app manages (excludes the immutable topic). */
export function buildRuleMutableFields(spec: ReconRuleSpec): Record<string, unknown> {
  return {
    name: spec.name,
    filter: spec.filter,
    priority: spec.priority,
    permissions: spec.permissions,
    breach_monitoring_enabled: spec.breachMonitoring,
    substring_matching_enabled: spec.substringMatching,
  }
}

/**
 * Create a rule. The Recon CreateRulesV1 body is a JSON ARRAY of rule objects
 * (unlike the object body the shared entityAdapter posts), so this issues the
 * create directly. topic is only accepted here — it is immutable afterwards.
 * Returns the new rule id (the response resources carry the full rule object).
 */
export async function createRule(client: FalconClient, spec: ReconRuleSpec): Promise<string> {
  const res = await client.request('POST', RECON_RULE_ENDPOINTS.entity, {
    body: [{ ...buildRuleMutableFields(spec), topic: spec.topic }],
  })
  const failure = falconFailure(res)
  if (failure) throw new Error(`Failed to create rule "${spec.name}": ${failure}`)

  const created = parseEnvelope<LiveEntity | string>(res.body)?.resources?.[0]
  const id = typeof created === 'string' ? created : created?.id
  if (!id) throw new Error(`Rule "${spec.name}" was created but the API returned no id`)
  return id
}

/** Capture the mutable fields of a live rule so rollback can restore them. */
function capturePrior(live: LiveEntity): ReconRuleRollbackEntry['prior'] {
  return {
    name: liveStr(live.name),
    filter: liveStr(live.filter),
    priority: liveStr(live.priority),
    permissions: liveStr(live.permissions),
    breach_monitoring_enabled:
      typeof live.breach_monitoring_enabled === 'boolean' ? live.breach_monitoring_enabled : undefined,
    substring_matching_enabled:
      typeof live.substring_matching_enabled === 'boolean' ? live.substring_matching_enabled : undefined,
  }
}

function liveStr(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

// --- Action (child) helpers — direct API calls -------------------------------

/**
 * Converge a rule's notification actions to exactly the declared set. Declared
 * actions are matched to live ones by type + frequency + recipients (see
 * actionKey): a match whose content format differs is updated; a declared action
 * with no match is created; a live action matched by nothing is deleted. Every
 * create/update is recorded on `entry` so rollback reverses exactly this deploy.
 */
export async function convergeActions(
  client: FalconClient,
  ruleId: string,
  declared: ActionSpec[],
  entry: ReconRuleRollbackEntry,
): Promise<void> {
  const live = await listActionsForRule(client, ruleId)
  const liveByKey = new Map<string, LiveAction>()
  for (const action of live) {
    if (action.id) liveByKey.set(liveActionKey(action), action)
  }

  const matchedIds = new Set<string>()

  for (const decl of declared) {
    const match = liveByKey.get(actionKey(decl))
    if (match?.id) {
      matchedIds.add(match.id)
      if ((match.content_format ?? '') !== decl.contentFormat) {
        entry.updatedActions.push({
          id: match.id,
          frequency: liveStr(match.frequency) ?? decl.frequency,
          recipients: Array.isArray(match.recipients) ? match.recipients : decl.recipients,
          content_format: liveStr(match.content_format) ?? 'standard',
        })
        await updateAction(client, {
          id: match.id,
          frequency: decl.frequency,
          recipients: decl.recipients,
          content_format: decl.contentFormat,
        })
      }
    } else {
      const id = await createAction(client, ruleId, decl)
      if (id) entry.createdActionIds.push(id)
    }
  }

  // Actions on the rule that are no longer declared are removed — but capture
  // each one's full prior state first so rollback can recreate it.
  for (const action of live) {
    if (action.id && !matchedIds.has(action.id)) {
      entry.deletedActions.push({
        type: liveStr(action.type) ?? 'email',
        frequency: liveStr(action.frequency) ?? '',
        recipients: Array.isArray(action.recipients) ? action.recipients.map((r) => String(r)) : [],
        contentFormat: liveStr(action.content_format) ?? 'standard',
      })
      const res = await deleteAction(client, action.id)
      const failure = res.status === 404 ? null : falconFailure(res)
      if (failure) throw new Error(`Failed to delete action ${action.id}: ${failure}`)
    }
  }
}

/** Build the recipients+frequency+type key of a LIVE action for matching. */
export function liveActionKey(action: LiveAction): string {
  return actionKey({
    type: liveStr(action.type) ?? 'email',
    frequency: liveStr(action.frequency) ?? '',
    recipients: Array.isArray(action.recipients) ? action.recipients.map((r) => String(r)) : [],
  })
}

/** List a rule's live notification actions (query by rule_id, then fetch by id). */
export async function listActionsForRule(
  client: FalconClient,
  ruleId: string,
): Promise<LiveAction[]> {
  const ids: string[] = []
  const limit = 500
  for (let offset = 0; ; offset += limit) {
    const res = await client.request('GET', RECON_ACTION_QUERIES, {
      query: { filter: `rule_id:'${fqlEscape(ruleId)}'`, limit, offset },
    })
    if (!res.ok) throw new Error(`Failed to list actions for rule ${ruleId}: ${falconFailure(res)}`)
    const page = (parseEnvelope<string>(res.body)?.resources ?? []).filter(
      (id): id is string => typeof id === 'string',
    )
    ids.push(...page)
    if (page.length < limit) break
  }
  if (ids.length === 0) return []

  const parts = ids.map((id) => `ids=${encodeURIComponent(id)}`)
  const res = await client.request('GET', `${RECON_ACTION_ENTITY}?${parts.join('&')}`)
  if (!res.ok) throw new Error(`Failed to read actions for rule ${ruleId}: ${falconFailure(res)}`)
  return parseEnvelope<LiveAction>(res.body)?.resources ?? []
}

/** Create one notification action under a rule; returns its new id. */
export async function createAction(
  client: FalconClient,
  ruleId: string,
  action: ActionSpec,
): Promise<string | undefined> {
  const res = await client.request('POST', RECON_ACTION_ENTITY, {
    body: {
      rule_id: ruleId,
      actions: [
        {
          type: action.type,
          frequency: action.frequency,
          recipients: action.recipients,
          content_format: action.contentFormat,
        },
      ],
    },
  })
  const failure = falconFailure(res)
  if (failure) throw new Error(`Failed to create action for rule ${ruleId}: ${failure}`)
  const created = parseEnvelope<LiveAction>(res.body)?.resources?.[0]
  return created?.id
}

/** Update one notification action (single object body; type is not updatable). */
export async function updateAction(
  client: FalconClient,
  body: { id: string; frequency: string; recipients: string[]; content_format: string },
): Promise<void> {
  const res = await client.request('PATCH', RECON_ACTION_ENTITY, { body })
  const failure = falconFailure(res)
  if (failure) throw new Error(`Failed to update action ${body.id}: ${failure}`)
}

/** Delete one notification action by id. Returns the raw response so callers handle 404. */
export async function deleteAction(client: FalconClient, id: string): Promise<FalconResponse> {
  return client.request('DELETE', `${RECON_ACTION_ENTITY}?ids=${encodeURIComponent(id)}`)
}
