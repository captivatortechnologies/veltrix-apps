import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient } from '../../lib/falcon'
import {
  createEntity,
  findEntityByIdentity,
  updateEntity,
  type EntityEndpoints,
  type LiveEntity,
} from '../../lib/entityAdapter'
import {
  extractCloudIomRuleSpecs,
  parseControls,
  type CloudIomRuleSpec,
  type RuleControl,
} from './validate'

/** Paths for the Cloud Security IOM custom-rules API surface (identity: name). */
export const CLOUD_IOM_RULE_ENDPOINTS: EntityEndpoints = {
  entity: '/cloud-policies/entities/rules/v1',
  queries: '/cloud-policies/queries/rules/v1',
  identityField: 'name',
}

/** Rule fields this app manages and can restore on rollback. */
export interface CloudIomRuleRollbackEntry {
  name: string
  existed: boolean
  id?: string
  prior?: {
    description?: string
    cloud_provider?: string
    resource_type?: string
    severity?: string
    logic?: string
    controls: RuleControl[]
    parent_rule_id?: string
  }
}

/**
 * Deploy IOM custom rules to a Falcon tenant via the Cloud Security rules API.
 *
 * For each declared rule:
 *   - find it by its `name` identity
 *   - if it exists, PATCH the managed fields (carrying the id)
 *   - otherwise POST a new rule
 *
 * Prior state is captured so rollback can revert updates and delete anything
 * this deploy created. Rego `logic`, `controls`, and `parent_rule_id` are only
 * sent when present — a rule that inherits from a parent omits its own logic.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractCloudIomRuleSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: CloudIomRuleRollbackEntry[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const existing = await findEntityByIdentity(client, CLOUD_IOM_RULE_ENDPOINTS, spec.name)

      if (existing?.id) {
        rollbackState.push({
          name: spec.name,
          existed: true,
          id: existing.id,
          prior: capturePrior(existing),
        })
        await updateEntity(client, CLOUD_IOM_RULE_ENDPOINTS, {
          id: existing.id,
          ...buildManagedFields(spec),
        })
      } else {
        const id = await createEntity(client, CLOUD_IOM_RULE_ENDPOINTS, buildManagedFields(spec))
        rollbackState.push({ name: spec.name, existed: false, id })
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} IOM custom rule(s) to Falcon tenant at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedRules: deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `IOM custom rule deployment failed after ${deployed.length} of ${specs.length} rule(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedRules: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState },
    }
  }
}

// --- Helpers shared with rollback / driftDetect ------------------------------

/** The mutable fields this app manages, as the rules API expects them. */
export function buildManagedFields(spec: CloudIomRuleSpec): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    name: spec.name,
    description: spec.description,
    cloud_provider: spec.cloudProvider,
    resource_type: spec.resourceType,
    severity: spec.severity,
  }
  if (spec.logic) fields.logic = spec.logic
  if (spec.parentRuleId) fields.parent_rule_id = spec.parentRuleId
  const controls = parseControls(spec.controlsRaw).controls
  if (controls.length > 0) fields.controls = controls
  return fields
}

/** Read a live rule field Falcon returns as a string (or absent). */
export function liveString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

/** Read a live rule's controls array into normalized {authority, code} pairs. */
export function liveControls(value: unknown): RuleControl[] {
  if (!Array.isArray(value)) return []
  const controls: RuleControl[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const { authority, code } = entry as { authority?: unknown; code?: unknown }
    if (typeof authority === 'string' && authority && typeof code === 'string' && code) {
      controls.push({ authority, code })
    }
  }
  return controls
}

/** Order-insensitive equality of two compliance-control lists. */
export function controlsEqual(a: RuleControl[], b: RuleControl[]): boolean {
  if (a.length !== b.length) return false
  const key = (c: RuleControl): string => `${c.authority}::${c.code}`
  const bSet = new Set(b.map(key))
  return a.every((c) => bSet.has(key(c)))
}

/** Capture the managed fields of a live rule so rollback can restore them. */
function capturePrior(live: LiveEntity): CloudIomRuleRollbackEntry['prior'] {
  return {
    description: liveString(live.description),
    cloud_provider: liveString(live.cloud_provider),
    resource_type: liveString(live.resource_type),
    severity: liveString(live.severity),
    logic: liveString(live.logic),
    controls: liveControls(live.controls),
    parent_rule_id: liveString(live.parent_rule_id),
  }
}
