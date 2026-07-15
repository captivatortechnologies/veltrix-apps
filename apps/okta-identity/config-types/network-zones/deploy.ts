import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient, oktaErrorMessage, parseJson, type OktaClient } from '../../lib/okta'
import {
  extractZoneSpecs,
  isProtectedZoneName,
  parseConfigObject,
  type LiveZone,
  type ZoneSpec,
} from './validate'

export interface ZoneRollbackEntry {
  name: string
  existed: boolean
  /** The zone id Okta assigns — the rollback key (never the name). */
  id?: string
  /** Prior lifecycle status (ACTIVE|INACTIVE), restored via lifecycle on rollback. */
  priorStatus?: string
  /** Prior zone definition with server-managed readOnly fields stripped, replayed via PUT on rollback. */
  prior?: Record<string, unknown>
}

/** Server-managed fields Okta returns on a zone but that must never be sent back. */
export const READONLY_ZONE_FIELDS = [
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
 * Deploy network zones to an Okta org via the Zones API. NO UPSERT exists, so
 * for each declared zone:
 *   - GET  /zones               — list (paginated) and match by name
 *   - PUT  /zones/{id}          — update an existing zone (capture prior body)
 *   - POST /zones               — create a missing zone (capture the new id)
 * then reconcile the zone's lifecycle status (ACTIVE/INACTIVE) via the lifecycle
 * endpoints, since status is not settable through the PUT body.
 *
 * A matched (existing) zone is only ever UPDATED in place — deploy never deletes,
 * so a `system: true` protected zone that already exists is safe to converge.
 * A protected system zone that does NOT exist is never created (validate blocks
 * the name; this also guards it defensively).
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractZoneSpecs(ctx.canvas).filter((s) => s.name && s.type)
  const rollbackState: ZoneRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      // Re-parse here to build the API body and to fail loudly rather than send a
      // malformed definition. An absent blob is treated as an empty definition.
      const config = spec.configJson ? parseConfigObject(spec.configJson) : {}
      if (config === null) {
        throw new Error(`Zone "${spec.name}": definition (configJson) is not a valid JSON object`)
      }

      const existing = await findZone(client, spec.name)

      if (existing && existing.id) {
        // UPDATE IN PLACE — the only operation allowed against a matched zone,
        // including a protected system zone. Capture the prior definition + status
        // for rollback (keyed on the returned id, never the name).
        rollbackState.push({
          name: spec.name,
          existed: true,
          id: existing.id,
          priorStatus: existing.status,
          prior: stripReadOnlyZoneFields(existing),
        })

        const res = await client.request('PUT', `/zones/${existing.id}`, {
          body: buildZoneBody(spec, config),
        })
        if (!res.ok) {
          throw new Error(`Failed to update zone "${spec.name}": ${oktaErrorMessage(res)}`)
        }
        await reconcileZoneStatus(client, existing.id, existing.status, spec.status)
      } else {
        // A protected system zone must never be created. validate already rejects
        // these names; this is a defensive backstop.
        if (isProtectedZoneName(spec.name)) {
          throw new Error(
            `Zone "${spec.name}" is a protected Okta system zone and cannot be created — it may only be updated in place where it already exists`,
          )
        }
        const res = await client.request('POST', '/zones', { body: buildZoneBody(spec, config) })
        if (!res.ok) {
          throw new Error(`Failed to create zone "${spec.name}": ${oktaErrorMessage(res)}`)
        }
        const created = parseJson<LiveZone>(res.body)
        if (!created?.id) {
          throw new Error(`Zone "${spec.name}" was created but the API returned no id`)
        }
        rollbackState.push({ name: spec.name, existed: false, id: created.id })
        createdIds.push(created.id)
        // A newly created zone is ACTIVE; deactivate it when INACTIVE is desired.
        await reconcileZoneStatus(client, created.id, created.status ?? 'ACTIVE', spec.status)
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} network zone(s) to Okta org at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedZones: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Network zone deployment failed after ${deployed.length} of ${specs.length} zone(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedZones: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/** Find a zone by exact name across the paginated zone list; null when absent. */
export async function findZone(client: OktaClient, name: string): Promise<LiveZone | null> {
  const res = await client.getAll<LiveZone>('/zones')
  if (!res.ok) {
    throw new Error(
      `Failed to list zones while resolving "${name}": ${oktaErrorMessage({
        status: res.status,
        ok: res.ok,
        body: res.body,
        nextUrl: null,
      })}`,
    )
  }
  return res.items.find((z) => z.name === name) ?? null
}

/** Fetch a single zone by id; null on 404. */
export async function getZoneById(client: OktaClient, id: string): Promise<LiveZone | null> {
  const res = await client.request('GET', `/zones/${id}`)
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`Failed to fetch zone ${id}: ${oktaErrorMessage(res)}`)
  }
  return parseJson<LiveZone>(res.body)
}

/**
 * Build the create/update body: the type-specific definition arrays come from
 * the parsed config blob, while type/name/status come from the modeled fields and
 * always win — the free-form JSON can never override the zone's identity.
 */
export function buildZoneBody(spec: ZoneSpec, config: Record<string, unknown>): Record<string, unknown> {
  return { ...config, type: spec.type, name: spec.name, status: spec.status }
}

/**
 * Converge a zone's lifecycle status. Okta does not change status through the PUT
 * body — you activate/deactivate via the lifecycle endpoints. No-op when the
 * desired status already matches the current one. A 404 (zone gone) is tolerated.
 */
export async function reconcileZoneStatus(
  client: OktaClient,
  zoneId: string,
  currentStatus: string | undefined,
  desiredStatus: string | undefined,
): Promise<void> {
  if (!desiredStatus) return
  const desired = desiredStatus.toUpperCase()
  const current = (currentStatus ?? '').toUpperCase()
  if (current === desired) return

  const action = desired === 'ACTIVE' ? 'activate' : 'deactivate'
  const res = await client.request('POST', `/zones/${zoneId}/lifecycle/${action}`)
  if (!res.ok && res.status !== 404) {
    throw new Error(`Failed to ${action} zone ${zoneId}: ${oktaErrorMessage(res)}`)
  }
}

/** Copy a live zone without the server-managed readOnly fields (safe to PUT back). */
export function stripReadOnlyZoneFields(zone: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(zone)) {
    if (!(READONLY_ZONE_FIELDS as readonly string[]).includes(key)) out[key] = value
  }
  return out
}
