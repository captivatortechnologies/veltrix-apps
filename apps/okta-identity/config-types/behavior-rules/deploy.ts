import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient, oktaErrorMessage, parseJson, type OktaClient } from '../../lib/okta'
import {
  extractBehaviorSpecs,
  parseSettingsObject,
  type BehaviorSpec,
  type LiveBehavior,
} from './validate'

export interface BehaviorRollbackEntry {
  name: string
  existed: boolean
  /** The behavior id Okta assigns — the rollback key (never the name). */
  id?: string
  /** Prior lifecycle status (ACTIVE|INACTIVE), restored via lifecycle on rollback. */
  priorStatus?: string
  /** Prior behavior body with server-managed readOnly fields stripped, replayed via PUT on rollback. */
  prior?: Record<string, unknown>
}

/** Server-managed fields Okta returns on a behavior but that must never be sent back. */
export const READONLY_BEHAVIOR_FIELDS = [
  'id',
  'created',
  'lastUpdated',
  'system',
  '_links',
  '_embedded',
  // status is managed by the lifecycle endpoints, not the PUT body.
  'status',
] as const

/**
 * Deploy behavior-detection rules to an Okta org via the Behaviors API. NO UPSERT
 * exists, so for each declared behavior:
 *   - GET  /behaviors            — list (paginated) and match by name
 *   - PUT  /behaviors/{id}       — update an existing behavior (capture prior body)
 *   - POST /behaviors            — create a missing behavior (capture the new id)
 * then reconcile the behavior's lifecycle status (ACTIVE/INACTIVE) via the
 * lifecycle endpoints, since status is not settable through the PUT body.
 *
 * Behavior rules have no `system` protection flag, so nothing is skipped or
 * pruned — a matched behavior is always updated in place.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractBehaviorSpecs(ctx.canvas).filter((s) => s.name && s.type)
  const rollbackState: BehaviorRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      // Re-parse here to build the API body and to fail loudly rather than send a
      // malformed settings blob. An absent blob is treated as empty settings.
      const settings = spec.settingsJson ? parseSettingsObject(spec.settingsJson) : {}
      if (settings === null) {
        throw new Error(`Behavior "${spec.name}": settings (settingsJson) is not a valid JSON object`)
      }

      const existing = await findBehavior(client, spec.name)

      if (existing && existing.id) {
        // UPDATE IN PLACE. Capture the prior body + status for rollback (keyed on
        // the returned id, never the name).
        rollbackState.push({
          name: spec.name,
          existed: true,
          id: existing.id,
          priorStatus: existing.status,
          prior: stripReadOnlyBehaviorFields(existing),
        })

        const res = await client.request('PUT', `/behaviors/${existing.id}`, {
          body: buildBehaviorBody(spec, settings),
        })
        if (!res.ok) {
          throw new Error(`Failed to update behavior "${spec.name}": ${oktaErrorMessage(res)}`)
        }
        await reconcileBehaviorStatus(client, existing.id, existing.status, spec.status)
      } else {
        const res = await client.request('POST', '/behaviors', { body: buildBehaviorBody(spec, settings) })
        if (!res.ok) {
          throw new Error(`Failed to create behavior "${spec.name}": ${oktaErrorMessage(res)}`)
        }
        const created = parseJson<LiveBehavior>(res.body)
        if (!created?.id) {
          throw new Error(`Behavior "${spec.name}" was created but the API returned no id`)
        }
        rollbackState.push({ name: spec.name, existed: false, id: created.id })
        createdIds.push(created.id)
        // A newly created behavior is ACTIVE; deactivate it when INACTIVE is desired.
        await reconcileBehaviorStatus(client, created.id, created.status ?? 'ACTIVE', spec.status)
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} behavior rule(s) to Okta org at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedBehaviors: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Behavior rule deployment failed after ${deployed.length} of ${specs.length} behavior(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedBehaviors: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/** Find a behavior by exact name across the paginated behavior list; null when absent. */
export async function findBehavior(client: OktaClient, name: string): Promise<LiveBehavior | null> {
  const res = await client.getAll<LiveBehavior>('/behaviors')
  if (!res.ok) {
    throw new Error(
      `Failed to list behaviors while resolving "${name}": ${oktaErrorMessage({
        status: res.status,
        ok: res.ok,
        body: res.body,
        nextUrl: null,
      })}`,
    )
  }
  return res.items.find((b) => b.name === name) ?? null
}

/** Fetch a single behavior by id; null on 404. */
export async function getBehaviorById(client: OktaClient, id: string): Promise<LiveBehavior | null> {
  const res = await client.request('GET', `/behaviors/${id}`)
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`Failed to fetch behavior ${id}: ${oktaErrorMessage(res)}`)
  }
  return parseJson<LiveBehavior>(res.body)
}

/**
 * Build the create/update body: type and name come from the modeled fields and
 * are the behavior's identity. The parsed settings blob becomes the `settings`
 * object, included only when it carries at least one key so an empty blob leaves
 * Okta's per-type defaults intact (relevant for ANOMALOUS_IP / ANOMALOUS_DEVICE).
 * status is NOT sent in the body — it is reconciled via the lifecycle endpoints.
 */
export function buildBehaviorBody(spec: BehaviorSpec, settings: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = { type: spec.type, name: spec.name }
  if (settings && Object.keys(settings).length > 0) {
    body.settings = settings
  }
  return body
}

/**
 * Converge a behavior's lifecycle status. Okta does not change status through the
 * PUT body — you activate/deactivate via the lifecycle endpoints. No-op when the
 * desired status already matches the current one. A 404 (behavior gone) is tolerated.
 */
export async function reconcileBehaviorStatus(
  client: OktaClient,
  behaviorId: string,
  currentStatus: string | undefined,
  desiredStatus: string | undefined,
): Promise<void> {
  if (!desiredStatus) return
  const desired = desiredStatus.toUpperCase()
  const current = (currentStatus ?? '').toUpperCase()
  if (current === desired) return

  const action = desired === 'ACTIVE' ? 'activate' : 'deactivate'
  const res = await client.request('POST', `/behaviors/${behaviorId}/lifecycle/${action}`)
  if (!res.ok && res.status !== 404) {
    throw new Error(`Failed to ${action} behavior ${behaviorId}: ${oktaErrorMessage(res)}`)
  }
}

/** Copy a live behavior without the server-managed readOnly fields (safe to PUT back). */
export function stripReadOnlyBehaviorFields(behavior: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(behavior)) {
    if (!(READONLY_BEHAVIOR_FIELDS as readonly string[]).includes(key)) out[key] = value
  }
  return out
}
