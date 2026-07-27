// =============================================================================
// Transport for Falcon Cloud Security custom compliance controls + their rule
// assignments.
//
// Like the frameworks collection, controls differ from lib/entityAdapter's
// defaults (query filter field is `compliance_control_name` not `name`; the
// identifier is `uuid`; update/delete/assign take the id via the `ids` query
// param), so find/create/update are implemented against the FalconClient here.
// getEntities / deleteEntity from the adapter are reused unchanged.
//
// A control's assigned rule IDs are NOT carried on the control entity. Both the
// Falcon console and the Terraform provider resolve them by querying the Cloud
// Security rules collection filtered by the control's framework name, section
// and requirement — mirrored here in readAssignedRuleIds so drift and rollback
// can see the current assignments. Assignment WRITES key off the control uuid.
// =============================================================================

import {
  falconErrorMessage,
  falconFailure,
  fqlEscape,
  parseEnvelope,
  type FalconClient,
} from '../../lib/falcon'
import { deleteEntity, getEntities, type EntityEndpoints } from '../../lib/entityAdapter'
import type { LiveControl, LiveControlFramework } from './validate'

export const CONTROL_ENDPOINTS: EntityEndpoints = {
  entity: '/cloud-policies/entities/compliance/controls/v1',
  queries: '/cloud-policies/queries/compliance/controls/v1',
  identityField: 'name',
}

/** Frameworks entity path — used only to resolve a framework's name from its uuid. */
const FRAMEWORK_ENTITY: EntityEndpoints = {
  entity: '/cloud-policies/entities/compliance/frameworks/v1',
  queries: '/cloud-policies/queries/compliance/frameworks/v1',
}

/** Rule-assignment (converge declared rule IDs onto a control) endpoint. */
const CONTROL_RULE_ASSIGNMENTS_PATH = '/cloud-policies/entities/compliance/control-rule-assignments/v1'
/** Cloud Security rules query — used to read a control's assigned rule IDs. */
const RULES_QUERY_PATH = '/cloud-policies/queries/rules/v1'

const CONTROL_NAME_FILTER = 'compliance_control_name'
const CONTROL_SECTION_FILTER = 'compliance_control_section'

/** Read a control's identifier — Cloud Security uses `uuid`, not `id`. */
export function controlId(control: LiveControl | null | undefined): string | undefined {
  const uuid = control?.uuid
  if (typeof uuid === 'string' && uuid) return uuid
  const id = control?.id
  return typeof id === 'string' && id ? id : undefined
}

/** The parent framework recorded on a live control (first entry, if any). */
export function controlFramework(control: LiveControl): LiveControlFramework | undefined {
  return Array.isArray(control.security_framework) ? control.security_framework[0] : undefined
}

/** True when a live control belongs to the given framework uuid. */
function belongsToFramework(control: LiveControl, frameworkUuid: string): boolean {
  return (control.security_framework ?? []).some((f) => f?.uuid === frameworkUuid)
}

export interface ControlIdentity {
  name: string
  frameworkId: string
  section: string
}

/**
 * Find a control by its identity (name within a framework + section): query ids
 * by name+section, fetch the entities, then pin the one whose name and section
 * match and which belongs to the declared framework uuid. Returns null when
 * none matches.
 */
export async function findControl(
  client: FalconClient,
  identity: ControlIdentity,
): Promise<LiveControl | null> {
  const limit = 500
  const filter = `${CONTROL_NAME_FILTER}:'${fqlEscape(identity.name)}'+${CONTROL_SECTION_FILTER}:'${fqlEscape(identity.section)}'`
  for (let offset = 0; ; offset += limit) {
    const res = await client.request('GET', CONTROL_ENDPOINTS.queries, {
      query: { filter, limit, offset },
    })
    if (!res.ok) {
      throw new Error(`Failed to search control "${identity.name}": ${falconErrorMessage(res)}`)
    }
    const ids = (parseEnvelope<string>(res.body)?.resources ?? []).filter(
      (id): id is string => typeof id === 'string',
    )
    if (ids.length > 0) {
      const entities = (await getEntities(client, CONTROL_ENDPOINTS, ids)) as LiveControl[]
      const match = entities.find(
        (e) =>
          e.name === identity.name &&
          e.section_name === identity.section &&
          belongsToFramework(e, identity.frameworkId),
      )
      if (match) return match
    }
    if (ids.length < limit) break
  }
  return null
}

/** Resolve a framework's name from its uuid, or null when it does not exist. */
export async function resolveFrameworkName(
  client: FalconClient,
  frameworkUuid: string,
): Promise<string | null> {
  const entities = await getEntities(client, FRAMEWORK_ENTITY, [frameworkUuid])
  const name = entities[0]?.name
  return typeof name === 'string' && name ? name : null
}

export interface ControlCreateFields {
  frameworkId: string
  name: string
  section: string
  description?: string
}

/** Create a control; returns its new uuid (or throws). */
export async function createControl(
  client: FalconClient,
  fields: ControlCreateFields,
): Promise<string> {
  const body: Record<string, unknown> = {
    framework_id: fields.frameworkId,
    name: fields.name,
    section_name: fields.section,
  }
  if (fields.description !== undefined) body.description = fields.description

  const res = await client.request('POST', CONTROL_ENDPOINTS.entity, { body })
  const failure = falconFailure(res)
  if (failure) throw new Error(`Failed to create control "${fields.name}": ${failure}`)
  const created = parseEnvelope<LiveControl>(res.body)?.resources?.[0]
  const uuid = controlId(created)
  if (!uuid) throw new Error(`Control "${fields.name}" was created but the API returned no uuid`)
  return uuid
}

/** Update a control's mutable fields by uuid (name + description only). */
export async function updateControl(
  client: FalconClient,
  uuid: string,
  fields: { name: string; description?: string },
): Promise<void> {
  const body: Record<string, unknown> = { name: fields.name }
  if (fields.description !== undefined) body.description = fields.description
  const res = await client.request('PATCH', CONTROL_ENDPOINTS.entity, {
    query: { ids: uuid },
    body,
  })
  const failure = falconFailure(res)
  if (failure) throw new Error(`Failed to update control "${fields.name}": ${failure}`)
}

/** Delete a control by uuid. */
export async function deleteControl(client: FalconClient, uuid: string): Promise<void> {
  await deleteEntity(client, CONTROL_ENDPOINTS, uuid)
}

/** Converge a control's rule assignments to exactly `ruleIds` (id in `ids` query). */
export async function replaceControlRules(
  client: FalconClient,
  uuid: string,
  ruleIds: string[],
): Promise<void> {
  const res = await client.request('PUT', CONTROL_RULE_ASSIGNMENTS_PATH, {
    query: { ids: uuid },
    body: { rule_ids: ruleIds },
  })
  const failure = falconFailure(res)
  if (failure) throw new Error(`Failed to assign rules to control: ${failure}`)
}

/**
 * Read the rule IDs currently assigned to a control. The control entity does
 * not carry them, so query the Cloud Security rules collection by the control's
 * framework name, section and requirement (the same filter the console/TF
 * provider use). Returns [] when the coordinates are incomplete.
 */
export async function readAssignedRuleIds(
  client: FalconClient,
  coords: { frameworkName?: string; section?: string; requirement?: string },
): Promise<string[]> {
  const { frameworkName, section, requirement } = coords
  if (!frameworkName || !section || !requirement) return []

  const filter =
    `rule_compliance_benchmark:'${fqlEscape(frameworkName)}'` +
    `+rule_control_section:'${fqlEscape(section)}'` +
    `+rule_control_requirement:'${fqlEscape(requirement)}'` +
    `+rule_domain:'CSPM'+rule_subdomain:'IOM'`

  const limit = 500
  const all: string[] = []
  for (let offset = 0; ; offset += limit) {
    const res = await client.request('GET', RULES_QUERY_PATH, {
      query: { filter, sort: 'rule_updated_at|asc', limit, offset },
    })
    if (!res.ok) {
      throw new Error(`Failed to read control rule assignments: ${falconErrorMessage(res)}`)
    }
    const ids = (parseEnvelope<string>(res.body)?.resources ?? []).filter(
      (id): id is string => typeof id === 'string',
    )
    all.push(...ids)
    if (ids.length < limit) break
  }
  return all
}

/** The coordinates readAssignedRuleIds needs, pulled off a live control. */
export function ruleReadCoords(control: LiveControl): {
  frameworkName?: string
  section?: string
  requirement?: string
} {
  return {
    frameworkName: controlFramework(control)?.name,
    section: typeof control.section_name === 'string' ? control.section_name : undefined,
    requirement: typeof control.requirement === 'string' ? control.requirement : undefined,
  }
}
