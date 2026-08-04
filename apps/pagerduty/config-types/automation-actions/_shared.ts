// Shared helpers for the PagerDuty Automation Actions config type
// (validate + deploy + rollback + drift + health).
//
// A PagerDuty Automation Actions action lives at /automation_actions/actions
// and is keyed for reconciliation by its `name` (PagerDuty assigns the server
// id). An action's `action_type` (script | process_automation) is IMMUTABLE
// once set by PagerDuty itself; deploy.ts errors clearly rather than attempt a
// delete+recreate when a redeploy tries to change it. The operator supplies an
// optional runner by NAME (resolved to an id at deploy — see the README
// Coverage section for why runners are not themselves managed by this app) and
// optional team/service associations by NAME, resolved and attached
// ADDITIVELY ONLY: a name removed from the canvas is never detached on
// redeploy, the same restraint this app's Tags config type documents for
// assignments dropped from a canvas.
//
// Request/response shapes follow the PagerDuty REST API v2, cross-checked
// against the official Terraform provider's Go client (the actual wire format
// it sends to production PagerDuty) and its resource docs:
//   list:    GET    /automation_actions/actions             -> { actions: [...], next_cursor }
//   create:  POST   /automation_actions/actions             <- { action: {...} }
//   get:     GET    /automation_actions/actions/{id}         -> { action: {...} }
//   update:  PUT    /automation_actions/actions/{id}         <- { action: {...} }
//   delete:  DELETE /automation_actions/actions/{id}
//   assign team:    POST   /automation_actions/actions/{id}/teams    <- { team: { id, type: "team_reference" } }
//   unassign team:  DELETE /automation_actions/actions/{id}/teams/{team_id}
//   assign service: POST   /automation_actions/actions/{id}/services <- { service: { id, type: "service_reference" } }
//   unassign service: DELETE /automation_actions/actions/{id}/services/{service_id}
//
// Docs: https://developer.pagerduty.com/api-reference/d64584a4371d3-create-an-automation-action
//       https://github.com/PagerDuty/terraform-provider-pagerduty/blob/master/website/docs/r/automation_actions_action.html.markdown
//       https://github.com/PagerDuty/terraform-provider-pagerduty/blob/master/vendor/github.com/heimweh/go-pagerduty/pagerduty/automation_actions_action.go
//
// NOTE on the wire shape of `runner`: unlike every other reference in this
// app's config types (team/service/escalation_policy, all `{ id, type }`
// objects), the Automation Actions API takes the runner as a BARE STRING id —
// `"runner": "<runner id>"` — confirmed directly from the Go client's
// `RunnerID *string \`json:"runner,omitempty"\`` field. This file's
// buildActionBody/actionRestoreBody send it that way deliberately; do not
// "fix" it into a reference object.

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'

/** The two action types PagerDuty accepts; immutable on an existing action once set. */
export const VALID_ACTION_TYPES = new Set(['script', 'process_automation'])

/** The action_classification values PagerDuty's UI recognizes. Optional — a blank value is valid. */
export const VALID_ACTION_CLASSIFICATIONS = new Set(['diagnostic', 'remediation'])

/** Reference to a team associated with an action, as embedded in a GET response. */
export interface TeamReference {
  id?: string
  type?: string
  summary?: string
}

/** Reference to a service associated with an action, as embedded in a GET response. */
export interface ServiceReference {
  id?: string
  type?: string
  summary?: string
}

/** The execution payload for an action; which fields apply depends on action_type. */
export interface ActionDataReference {
  process_automation_job_id?: string
  process_automation_job_arguments?: string
  process_automation_node_filter?: string
  script?: string
  invocation_command?: string
}

/** An automation action as returned by GET /automation_actions/actions[/{id}]. */
export interface LiveAutomationAction {
  id?: string
  type?: string
  name?: string
  description?: string
  action_type?: string
  /** Bare runner id string (see file header) — not a reference object. */
  runner?: string
  runner_type?: string
  action_data_reference?: ActionDataReference
  services?: ServiceReference[]
  teams?: TeamReference[]
  action_classification?: string
  creation_time?: string
  modify_time?: string
  only_invocable_on_unresolved_incidents?: boolean
  allow_invocation_manually?: boolean
  allow_invocation_from_event_orchestration?: boolean
  map_to_all_services?: boolean
}

/** One canvas item, normalized to the fields this config type manages. */
export interface AutomationActionSpec {
  itemName: string
  name: string
  description: string
  actionType: string
  /** The NAME of the runner to execute this action; resolved to an id at deploy. */
  runnerName: string
  /** Raw JSON text for the action_data object (shape depends on actionType). */
  actionDataJson: string
  actionClassification: string
  /** Raw JSON text for the array of team NAMES to (additively) associate. */
  teamsJson: string
  /** Raw JSON text for the array of service NAMES to (additively) associate. */
  servicesJson: string
  mapToAllServices: boolean
  onlyInvocableOnUnresolvedIncidents: boolean
  allowInvocationManually: boolean
  allowInvocationFromEventOrchestration: boolean
}

/** Each canvas item describes one automation action. */
export function extractAutomationActionSpecs(canvas: CanvasSnapshot): AutomationActionSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const fields = item.fields ?? {}
    return {
      itemName: item.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      description: typeof fields.description === 'string' ? fields.description.trim() : '',
      actionType: typeof fields.action_type === 'string' ? fields.action_type.trim() : '',
      runnerName: typeof fields.runner === 'string' ? fields.runner.trim() : '',
      actionDataJson: typeof fields.action_data === 'string' ? fields.action_data : '',
      actionClassification: typeof fields.action_classification === 'string' ? fields.action_classification.trim() : '',
      teamsJson: typeof fields.teams === 'string' ? fields.teams : '',
      servicesJson: typeof fields.services === 'string' ? fields.services : '',
      mapToAllServices: typeof fields.map_to_all_services === 'boolean' ? fields.map_to_all_services : false,
      onlyInvocableOnUnresolvedIncidents:
        typeof fields.only_invocable_on_unresolved_incidents === 'boolean'
          ? fields.only_invocable_on_unresolved_incidents
          : false,
      allowInvocationManually:
        typeof fields.allow_invocation_manually === 'boolean' ? fields.allow_invocation_manually : true,
      allowInvocationFromEventOrchestration:
        typeof fields.allow_invocation_from_event_orchestration === 'boolean'
          ? fields.allow_invocation_from_event_orchestration
          : false,
    }
  })
}

/**
 * Result of parsing the action_data JSON. NOT a discriminated union — the
 * platform's handler loader does not narrow `{ ok:true } | { ok:false }`, so
 * `data` and `error` are always-present nullable fields (same convention as
 * escalation-policies' RulesParseResult).
 */
export interface ActionDataParseResult {
  data: ActionDataReference | null
  error: string | null
}

/**
 * Parse + validate the action_data JSON object. Its required sub-field depends
 * on actionType: "script" needs a non-empty `script`; "process_automation"
 * needs a non-empty `process_automation_job_id`. Both accept their documented
 * optional sub-fields. actionType is trusted to already be one of
 * VALID_ACTION_TYPES — callers validate that separately.
 */
export function parseActionData(raw: string | undefined, actionType: string): ActionDataParseResult {
  const text = (raw ?? '').trim()
  if (!text) return { data: null, error: 'is required (a JSON object matching the chosen action type)' }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { data: null, error: `must be valid JSON (${err instanceof Error ? err.message : 'parse error'})` }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { data: null, error: 'must be a JSON object' }
  }

  const obj = parsed as Record<string, unknown>
  const str = (key: string): string => (typeof obj[key] === 'string' ? (obj[key] as string).trim() : '')

  if (actionType === 'script') {
    const script = str('script')
    if (!script) return { data: null, error: 'must include a non-empty "script" for a script action' }
    const data: ActionDataReference = { script }
    const invocationCommand = str('invocation_command')
    if (invocationCommand) data.invocation_command = invocationCommand
    return { data, error: null }
  }

  if (actionType === 'process_automation') {
    const jobId = str('process_automation_job_id')
    if (!jobId) {
      return { data: null, error: 'must include a non-empty "process_automation_job_id" for a process_automation action' }
    }
    const data: ActionDataReference = { process_automation_job_id: jobId }
    const jobArguments = str('process_automation_job_arguments')
    if (jobArguments) data.process_automation_job_arguments = jobArguments
    const nodeFilter = str('process_automation_node_filter')
    if (nodeFilter) data.process_automation_node_filter = nodeFilter
    return { data, error: null }
  }

  return { data: null, error: 'cannot be validated without a recognized action_type' }
}

/** Same nullable-pair convention as ActionDataParseResult, for a JSON array of entity names. */
export interface NameListParseResult {
  names: string[] | null
  error: string | null
}

/**
 * Parse + shallow-validate a JSON array of names (teams or services). A blank
 * input is valid and means "no associations declared". `itemLabel` (e.g.
 * "team", "service") only shapes the error message.
 */
export function parseNameList(raw: string | undefined, itemLabel: string): NameListParseResult {
  const text = (raw ?? '').trim()
  if (!text) return { names: [], error: null }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { names: null, error: `must be valid JSON (${err instanceof Error ? err.message : 'parse error'})` }
  }
  if (!Array.isArray(parsed)) return { names: null, error: `must be a JSON array of ${itemLabel} names` }

  const names: string[] = []
  for (let i = 0; i < parsed.length; i++) {
    const value = parsed[i]
    if (typeof value !== 'string' || !value.trim()) {
      return { names: null, error: `entry ${i + 1} must be a non-empty ${itemLabel} name string` }
    }
    names.push(value.trim())
  }
  return { names, error: null }
}

/**
 * Build the request body for POST/PUT /automation_actions/actions. Wrapped in
 * an { action: {...} } envelope by callers. `type` is never sent (PagerDuty
 * computes it, matching this app's other config types which omit read-only
 * `type`); `runner` is a bare id string (see file header), omitted when unset.
 */
export function buildActionBody(
  spec: AutomationActionSpec,
  actionData: ActionDataReference,
  runnerId: string | null,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: spec.name,
    description: spec.description,
    action_type: spec.actionType,
    action_data_reference: actionData,
    only_invocable_on_unresolved_incidents: spec.onlyInvocableOnUnresolvedIncidents,
    allow_invocation_manually: spec.allowInvocationManually,
    allow_invocation_from_event_orchestration: spec.allowInvocationFromEventOrchestration,
    map_to_all_services: spec.mapToAllServices,
  }
  if (runnerId) body.runner = runnerId
  if (spec.actionClassification) body.action_classification = spec.actionClassification
  return body
}

/** Rebuild an action body from its prior live shape (used by rollback restore). Never touches associations. */
export function actionRestoreBody(prior: LiveAutomationAction): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: String(prior.name ?? ''),
    description: String(prior.description ?? ''),
    action_type: String(prior.action_type ?? ''),
    action_data_reference: prior.action_data_reference ?? {},
    only_invocable_on_unresolved_incidents: prior.only_invocable_on_unresolved_incidents ?? false,
    allow_invocation_manually: prior.allow_invocation_manually ?? true,
    allow_invocation_from_event_orchestration: prior.allow_invocation_from_event_orchestration ?? false,
    map_to_all_services: prior.map_to_all_services ?? false,
  }
  if (prior.runner) body.runner = prior.runner
  if (prior.action_classification) body.action_classification = prior.action_classification
  return body
}

/** Find a live action by name (case-insensitive — the reconciliation identity). */
export function findAutomationAction(actions: LiveAutomationAction[], name: string): LiveAutomationAction | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  return actions.find((a) => String(a.name ?? '').trim().toLowerCase() === n) ?? null
}

/** Resolve a runner NAME to its id (case-insensitive). Runners are read-only lookups here — see README Coverage. */
export function findRunnerId(runners: Array<{ id?: string; name?: string }>, name: string): string | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  return runners.find((r) => String(r.name ?? '').trim().toLowerCase() === n)?.id ?? null
}

/** Resolve a team NAME to its id (case-insensitive). */
export function findTeamId(teams: Array<{ id?: string; name?: string }>, name: string): string | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  return teams.find((t) => String(t.name ?? '').trim().toLowerCase() === n)?.id ?? null
}

/** Resolve a service NAME to its id (case-insensitive). */
export function findServiceId(services: Array<{ id?: string; name?: string }>, name: string): string | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  return services.find((s) => String(s.name ?? '').trim().toLowerCase() === n)?.id ?? null
}

/** The set of team ids currently associated with a live action, per its embedded `teams` array. */
export function liveTeamIds(live: LiveAutomationAction): Set<string> {
  return new Set((live.teams ?? []).map((t) => t.id).filter((id): id is string => Boolean(id)))
}

/** The set of service ids currently associated with a live action, per its embedded `services` array. */
export function liveServiceIds(live: LiveAutomationAction): Set<string> {
  return new Set((live.services ?? []).map((s) => s.id).filter((id): id is string => Boolean(id)))
}
