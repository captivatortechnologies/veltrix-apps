import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildTenableClient,
  parseJson,
  tenableErrorMessage,
  type TenableClient,
} from '../../lib/tenable'
import { extractProfileSpecs, parseSettingsObject, type LiveProfile, type ProfileSpec } from './validate'

export interface ProfileRollbackEntry {
  name: string
  /** "agent" | "scanners" — needed to rebuild the sensor-scoped path on rollback. */
  sensorType: string
  existed: boolean
  /** id (or uuid) the API returns — the rollback key, never the name. */
  id?: number | string
  /** Full prior body captured before an update, replayed (PUT) on rollback. */
  prior?: Record<string, unknown>
}

/**
 * Deploy scan/agent profiles to a Tenable VM tenant via the Profiles API
 * (developer.tenable.com/reference/profiles-create — GET/POST
 * /sensors/profiles/{sensor_type}, GET/PUT/DELETE
 * /sensors/profiles/{sensor_type}/{profile_uuid}; sensor_type is "agent" or
 * "scanners").
 *
 * For each declared profile:
 *   - GET  /sensors/profiles/{sensorType}               — list + find by name
 *   - PUT  /sensors/profiles/{sensorType}/{uuid}         — update (keyed on the returned uuid)
 *   - POST /sensors/profiles/{sensorType}                — create (capture the created uuid)
 *
 * The request body is `{ name, description?, config? }` — settingsJson maps
 * straight into `config` (the API's freeform tuning object), never spread onto
 * the top level. Names are matched exactly within the declared sensor type
 * (an "agent" profile and a "scanners" profile may share a name — they are
 * different objects); create-vs-update is decided by that match and rollback
 * is keyed on the uuid the API returns — never on the name.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildTenableClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractProfileSpecs(ctx.canvas).filter((s) => s.name && s.sensorType)
  const rollbackState: ProfileRollbackEntry[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      // settingsJson is validated upstream; re-parse here to build the body and
      // to fail loudly rather than send a malformed settings object.
      const settings = spec.settingsJson ? parseSettingsObject(spec.settingsJson) : undefined
      if (spec.settingsJson && settings === null) {
        throw new Error(`Profile "${spec.name}": advanced settings are not a valid JSON object`)
      }

      const existing = await findProfile(client, spec.sensorType, spec.name)
      const existingId = existing ? profileIdentifier(existing) : undefined

      if (existing && existingId !== undefined) {
        // Capture the FULL prior body so rollback can restore freeform tuning
        // fields we do not otherwise know the shape of.
        const prior = await getProfileById(client, spec.sensorType, existingId)
        rollbackState.push({
          name: spec.name,
          sensorType: spec.sensorType,
          existed: true,
          id: existingId,
          prior: prior ?? undefined,
        })

        const res = await client.request('PUT', `/sensors/profiles/${spec.sensorType}/${existingId}`, {
          body: buildProfileBody(spec, settings ?? undefined),
        })
        if (!res.ok) {
          throw new Error(`Failed to update profile "${spec.name}": ${tenableErrorMessage(res)}`)
        }
      } else {
        const res = await client.request('POST', `/sensors/profiles/${spec.sensorType}`, {
          body: buildProfileBody(spec, settings ?? undefined),
        })
        if (!res.ok) {
          throw new Error(`Failed to create profile "${spec.name}": ${tenableErrorMessage(res)}`)
        }
        const created = parseJson<LiveProfile>(res.body)
        const createdId = created ? profileIdentifier(created) : undefined
        rollbackState.push({ name: spec.name, sensorType: spec.sensorType, existed: false, id: createdId })
        if (createdId === undefined) {
          throw new Error(`Profile "${spec.name}" was created but the API returned no id/uuid`)
        }
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} profile(s) to Tenable tenant at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedProfiles: deployed },
      rollbackData: {
        previousState: rollbackState,
        createdIds: rollbackState.filter((e) => !e.existed && e.id !== undefined).map((e) => e.id),
      },
    }
  } catch (error) {
    return {
      success: false,
      message: `Profile deployment failed after ${deployed.length} of ${specs.length} profile(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedProfiles: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: {
        previousState: rollbackState,
        createdIds: rollbackState.filter((e) => !e.existed && e.id !== undefined).map((e) => e.id),
      },
    }
  }
}

// --- Helpers ---

/**
 * The stable identity Tenable returns for a profile. GET (list/detail) returns
 * `profile_uuid`; POST (create) returns a bare `uuid` — check both.
 */
export function profileIdentifier(live: LiveProfile): number | string | undefined {
  if (typeof live.profile_uuid === 'string' && live.profile_uuid) return live.profile_uuid
  if (typeof live.uuid === 'string' && live.uuid) return live.uuid
  return undefined
}

/**
 * Look up a profile by exact name within a sensor type's list; null when absent.
 * GET /sensors/profiles/{sensor_type} returns `{ profiles: [...] }`, scoped to
 * that one sensor type only — an "agent" profile never collides with a
 * same-named "scanners" profile because they live under different lists.
 */
export async function findProfile(
  client: TenableClient,
  sensorType: string,
  name: string,
): Promise<LiveProfile | null> {
  const res = await client.request('GET', `/sensors/profiles/${sensorType}`)
  if (!res.ok) {
    throw new Error(`Failed to list ${sensorType} profiles while resolving "${name}": ${tenableErrorMessage(res)}`)
  }
  const profiles = parseJson<{ profiles?: LiveProfile[] }>(res.body)?.profiles ?? []
  // Match the first exact name. Rollback is keyed on the returned profile_uuid,
  // so an ambiguous name still reverts precisely.
  return profiles.find((p) => p.name === name) ?? null
}

/** Fetch a single profile's full body by uuid; null on 404. */
export async function getProfileById(
  client: TenableClient,
  sensorType: string,
  uuid: number | string,
): Promise<LiveProfile | null> {
  const res = await client.request('GET', `/sensors/profiles/${sensorType}/${uuid}`)
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`Failed to fetch ${sensorType} profile ${uuid}: ${tenableErrorMessage(res)}`)
  }
  return parseJson<LiveProfile>(res.body)
}

/**
 * Build the create/update request body: `{ name, description?, config? }`.
 * settingsJson maps straight into `config` — the API's freeform tuning object
 * (never spread onto the top level, which is NOT the real request shape).
 */
export function buildProfileBody(
  spec: ProfileSpec,
  settings: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const body: Record<string, unknown> = { name: spec.name }
  if (spec.description !== undefined) body.description = spec.description
  if (settings !== undefined) body.config = settings
  return body
}
