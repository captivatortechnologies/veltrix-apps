import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient, falconFailure, type FalconClient } from '../../lib/falcon'
import {
  createEntity,
  findEntityByIdentity,
  updateEntity,
  type EntityEndpoints,
  type LiveEntity,
} from '../../lib/entityAdapter'
import {
  extractCorrelationRuleSpecs,
  SEVERITY_TO_NUMBER,
  type CorrelationRuleSpec,
  type CorrelationSeverity,
} from './validate'

/** Paths for the Next-Gen SIEM Correlation Rules API surface (identity: name). */
export const CORRELATION_RULE_ENDPOINTS: EntityEndpoints = {
  entity: '/correlation-rules/entities/rules/v1',
  queries: '/correlation-rules/queries/rules/v1',
  identityField: 'name',
}

/** Publishes a saved rule version so it goes live. */
export const CORRELATION_RULE_PUBLISH_PATH = '/correlation-rules/entities/rule-versions/publish/v1'

/** Rule fields this app manages and can restore on rollback (API-shaped). */
export interface CorrelationRuleRollbackEntry {
  name: string
  existed: boolean
  id?: string
  prior?: {
    description?: string
    severity?: number
    status?: string
    search?: Record<string, unknown>
    operation?: Record<string, unknown>
    mitre_attack?: unknown[]
  }
}

/**
 * Deploy correlation rules to a Falcon tenant via the Correlation Rules API.
 *
 * For each declared rule:
 *   - find it by its `name` identity
 *   - if it exists, PATCH the managed fields (carrying the id)
 *   - otherwise POST a new rule
 *   - if "Publish" is set, PATCH the publish endpoint with the HEAD version id
 *
 * VERSIONING: a rule is versioned — every create/update saves a new version that
 * stays an unpublished draft until published, and the `id` a write returns is a
 * VERSION id that changes on the next edit. So publish re-resolves the rule by
 * name to get the current head version id rather than trusting a stale id. Prior
 * state is captured so rollback can revert updates and delete created rules.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractCorrelationRuleSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: CorrelationRuleRollbackEntry[] = []
  const deployed: string[] = []
  const published: string[] = []

  try {
    for (const spec of specs) {
      const existing = await findEntityByIdentity(client, CORRELATION_RULE_ENDPOINTS, spec.name)

      if (existing?.id) {
        rollbackState.push({
          name: spec.name,
          existed: true,
          id: existing.id,
          prior: capturePrior(existing),
        })
        await updateEntity(client, CORRELATION_RULE_ENDPOINTS, {
          id: existing.id,
          ...buildManagedFields(spec),
        })
      } else {
        const id = await createEntity(client, CORRELATION_RULE_ENDPOINTS, buildManagedFields(spec))
        rollbackState.push({ name: spec.name, existed: false, id })
      }

      if (spec.publish) {
        // Re-resolve the head version id — a PATCH/POST just created a new one.
        const head = await findEntityByIdentity(client, CORRELATION_RULE_ENDPOINTS, spec.name)
        if (head?.id) {
          await publishRuleVersion(client, head.id)
          published.push(spec.name)
        }
      }

      deployed.push(spec.name)
    }

    const publishNote = published.length > 0 ? ` (published: ${published.join(', ')})` : ''
    return {
      success: true,
      message: `Deployed ${deployed.length} correlation rule(s) to Falcon tenant at ${baseUrl}: ${deployed.join(', ')}${publishNote}`,
      artifacts: { baseUrl, deployedRules: deployed, publishedRules: published },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Correlation rule deployment failed after ${deployed.length} of ${specs.length} rule(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedRules: deployed, publishedRules: published },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState },
    }
  }
}

// --- Helpers shared with rollback / driftDetect ------------------------------

/**
 * The mutable fields this app manages, as the Correlation Rules API expects them.
 * `create_case` is expressed as search.outcome ("case" adds a case to the always-
 * created detection); the schedule cadence is operation.schedule.definition on the
 * "@every <duration>" form; severity is the int32 the API stores (10/30/50/70/90).
 */
export function buildManagedFields(spec: CorrelationRuleSpec): Record<string, unknown> {
  const search: Record<string, unknown> = {
    filter: spec.search,
    trigger_mode: spec.triggerMode,
    outcome: spec.createCase ? 'case' : 'detection',
    execution_mode: 'scheduled',
  }
  if (spec.frequency) search.lookback = spec.frequency

  const fields: Record<string, unknown> = {
    name: spec.name,
    description: spec.description,
    severity: SEVERITY_TO_NUMBER[spec.severity as CorrelationSeverity] ?? SEVERITY_TO_NUMBER.medium,
    status: spec.status,
    search,
  }
  if (spec.frequency) {
    fields.operation = { schedule: { definition: `@every ${spec.frequency}` } }
  }
  const mitre = buildMitreAttack(spec)
  if (mitre) fields.mitre_attack = mitre
  return fields
}

/** One MITRE ATT&CK mapping from the tactic/technique fields, or none. */
export function buildMitreAttack(spec: CorrelationRuleSpec): Array<Record<string, string>> | undefined {
  if (!spec.mitreTactic && !spec.mitreTechnique) return undefined
  const entry: Record<string, string> = {}
  if (spec.mitreTactic) entry.tactic_id = spec.mitreTactic
  if (spec.mitreTechnique) entry.technique_id = spec.mitreTechnique
  return [entry]
}

/** PATCH the publish endpoint for a specific rule version id. */
export async function publishRuleVersion(client: FalconClient, versionId: string): Promise<void> {
  const res = await client.request('PATCH', CORRELATION_RULE_PUBLISH_PATH, { body: { id: versionId } })
  const failure = falconFailure(res)
  if (failure) throw new Error(`Failed to publish rule version "${versionId}": ${failure}`)
}

/** Read a live rule field Falcon returns as a string (or absent). */
export function liveString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

/** Read a live rule field Falcon returns as an object (or empty). */
export function liveObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/** Live search.filter (the CQL query), or empty. */
export function liveFilter(live: LiveEntity): string {
  return liveString(liveObject(live.search).filter) ?? ''
}

/** Live search.trigger_mode, or empty. */
export function liveTriggerMode(live: LiveEntity): string {
  return (liveString(liveObject(live.search).trigger_mode) ?? '').toLowerCase()
}

/** True when the live rule opens a case on match (search.outcome === "case"). */
export function liveCreateCase(live: LiveEntity): boolean {
  return liveString(liveObject(live.search).outcome) === 'case'
}

/** Live schedule cadence without the "@every " prefix, or empty. */
export function liveFrequency(live: LiveEntity): string {
  const schedule = liveObject(liveObject(live.operation).schedule)
  const definition = liveString(schedule.definition) ?? ''
  return definition.replace(/^@every\s+/i, '').trim().toLowerCase()
}

/** Capture the managed fields of a live rule so rollback can restore them. */
function capturePrior(live: LiveEntity): CorrelationRuleRollbackEntry['prior'] {
  return {
    description: liveString(live.description),
    severity: typeof live.severity === 'number' ? live.severity : undefined,
    status: liveString(live.status),
    search: liveObject(live.search),
    operation: liveObject(live.operation),
    mitre_attack: Array.isArray(live.mitre_attack) ? live.mitre_attack : undefined,
  }
}
