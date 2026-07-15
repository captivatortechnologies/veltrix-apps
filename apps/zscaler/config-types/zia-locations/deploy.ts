import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildZscalerClient,
  parseJson,
  zscalerErrorMessage,
  type ZscalerClient,
} from '../../lib/zscaler'
import {
  extractLocationSpecs,
  parseLocationObject,
  type LiveLocation,
  type LocationSpec,
} from './validate'

export interface LocationRollbackEntry {
  name: string
  existed: boolean
  id?: number
  /** The full prior live object, restored verbatim on rollback of an update. */
  prior?: Record<string, unknown>
}

/**
 * Deploy ZIA locations via the Zscaler OneAPI.
 *
 * Identity is the NAME (ZIA has no upsert): list /locations, match by name,
 * then PUT an existing location or POST a new one. ZIA STAGES every write —
 * nothing takes effect until activation — so this writes all locations, then
 * calls activate() ONCE at the end. If activation fails the writes remain
 * staged and rollbackData is returned so the platform can revert them.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildZscalerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, vanity } = built

  const specs = extractLocationSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: LocationRollbackEntry[] = []
  const createdIds: number[] = []
  const deployed: string[] = []

  try {
    const existing = await listLocations(client)
    const byName = new Map(existing.filter((l) => l.name).map((l) => [l.name as string, l]))

    for (const spec of specs) {
      const live = byName.get(spec.name)

      if (live && live.id != null) {
        rollbackState.push({
          name: spec.name,
          existed: true,
          id: live.id,
          prior: { ...live },
        })
        const res = await client.zia('PUT', `/locations/${live.id}`, { body: buildPayload(spec, live.id) })
        if (!res.ok) {
          throw new Error(`Failed to update location "${spec.name}": ${zscalerErrorMessage(res)}`)
        }
      } else {
        const res = await client.zia('POST', '/locations', { body: buildPayload(spec) })
        if (!res.ok) {
          throw new Error(`Failed to create location "${spec.name}": ${zscalerErrorMessage(res)}`)
        }
        const created = parseJson<LiveLocation>(res.body)
        if (created?.id == null) {
          throw new Error(`Location "${spec.name}" was created but the API returned no id`)
        }
        rollbackState.push({ name: spec.name, existed: false, id: created.id })
        createdIds.push(created.id)
      }

      deployed.push(spec.name)
    }

    // ZIA changes are staged — push them to production once, after all writes.
    const act = await client.activate()
    if (!act.ok) {
      return {
        success: false,
        message: `Staged ${deployed.length} ZIA location(s) but activation failed: ${zscalerErrorMessage(
          act,
        )}. The changes are saved but not active — re-run to retry activation.`,
        artifacts: { vanity, deployedLocations: deployed },
        rollbackData: { previousState: rollbackState, createdIds },
      }
    }

    return {
      success: true,
      message: `Deployed and activated ${deployed.length} ZIA location(s) on tenant "${vanity}": ${deployed.join(
        ', ',
      )}`,
      artifacts: { vanity, deployedLocations: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Location deployment failed after ${deployed.length} of ${specs.length} location(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { vanity, deployedLocations: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/** List all ZIA locations; throws on a non-OK response. */
export async function listLocations(client: ZscalerClient): Promise<LiveLocation[]> {
  const res = await client.ziaGetAll<LiveLocation>('/locations')
  if (!res.ok) {
    throw new Error(
      `Failed to list locations: ${zscalerErrorMessage({ status: res.status, ok: false, body: res.body })}`,
    )
  }
  return res.items
}

/** Find a location by name; null when absent. */
export async function findLocation(client: ZscalerClient, name: string): Promise<LiveLocation | null> {
  const all = await listLocations(client)
  return all.find((l) => l.name === name) ?? null
}

/**
 * Build the API body from a spec. The many optional fields live in location_json
 * and are spread over the first-class fields (JSON keys win for advanced
 * settings), but `name` is always taken from the name field. On update the live
 * id is echoed back so ZIA treats the PUT as an in-place edit.
 */
function buildPayload(spec: LocationSpec, id?: number): Record<string, unknown> {
  const payload: Record<string, unknown> = { name: spec.name }
  if (spec.country) payload.country = spec.country
  if (spec.tz) payload.tz = spec.tz

  if (spec.locationJson) {
    const extra = parseLocationObject(spec.locationJson)
    if (extra) Object.assign(payload, extra)
  }

  // name always from the name field, even if location_json tried to override it.
  payload.name = spec.name
  if (id != null) payload.id = id
  return payload
}
