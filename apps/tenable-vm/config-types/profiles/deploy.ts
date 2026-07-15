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
  existed: boolean
  /** id (or uuid) the API returns — the rollback key, never the name. */
  id?: number | string
  /** Full prior body captured before an update, replayed (PUT) on rollback. */
  prior?: Record<string, unknown>
}

/**
 * Deploy scan/sensor profiles to a Tenable VM tenant via the Profiles API.
 *
 * For each declared profile:
 *   - GET  /profiles             — list + find by name (capture prior state)
 *   - PUT  /profiles/{id}        — update existing (keyed on the returned id)
 *   - POST /profiles             — create missing (capture the created id/uuid)
 *
 * The request body is `{ ...settingsJson, name }` — the freeform settings are
 * merged first and the canvas name is forced to win, since name is the
 * profile's logical identity. Names are matched exactly in the live list;
 * create-vs-update is decided by that match and rollback is keyed on the
 * id/uuid the API returns — never on the name.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildTenableClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractProfileSpecs(ctx.canvas).filter((s) => s.name)
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

      const existing = await findProfile(client, spec.name)
      const existingId = existing ? profileIdentifier(existing) : undefined

      if (existing && existingId !== undefined) {
        // Capture the FULL prior body so rollback can restore freeform tuning
        // fields we do not otherwise know the shape of.
        const prior = await getProfileById(client, existingId)
        rollbackState.push({
          name: spec.name,
          existed: true,
          id: existingId,
          prior: prior ?? undefined,
        })

        const res = await client.request('PUT', `/profiles/${existingId}`, {
          body: buildProfileBody(spec, settings ?? undefined),
        })
        if (!res.ok) {
          throw new Error(`Failed to update profile "${spec.name}": ${tenableErrorMessage(res)}`)
        }
      } else {
        const res = await client.request('POST', '/profiles', {
          body: buildProfileBody(spec, settings ?? undefined),
        })
        if (!res.ok) {
          throw new Error(`Failed to create profile "${spec.name}": ${tenableErrorMessage(res)}`)
        }
        const created = parseJson<LiveProfile>(res.body)
        const createdId = created ? profileIdentifier(created) : undefined
        rollbackState.push({ name: spec.name, existed: false, id: createdId })
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

/** The stable identity Tenable returns for a profile — prefer id, fall back to uuid. */
export function profileIdentifier(live: LiveProfile): number | string | undefined {
  if (live.id !== undefined && live.id !== null && live.id !== '') return live.id
  if (typeof live.uuid === 'string' && live.uuid) return live.uuid
  return undefined
}

/** Look up a profile by exact name in the tenant list; null when absent. */
export async function findProfile(client: TenableClient, name: string): Promise<LiveProfile | null> {
  const res = await client.request('GET', '/profiles')
  if (!res.ok) {
    throw new Error(`Failed to list profiles while resolving "${name}": ${tenableErrorMessage(res)}`)
  }
  const profiles = parseJson<{ profiles?: LiveProfile[] }>(res.body)?.profiles ?? []
  // Match the first exact name. Rollback is keyed on the returned id/uuid, so an
  // ambiguous name still reverts precisely.
  return profiles.find((p) => p.name === name) ?? null
}

/** Fetch a single profile's full body by id/uuid; null on 404. */
export async function getProfileById(
  client: TenableClient,
  id: number | string,
): Promise<LiveProfile | null> {
  const res = await client.request('GET', `/profiles/${id}`)
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`Failed to fetch profile ${id}: ${tenableErrorMessage(res)}`)
  }
  return parseJson<LiveProfile>(res.body)
}

/**
 * Build the create/update request body: merge the freeform settingsJson first,
 * then force the canvas name to win. name is the profile's logical identity, so
 * a stray "name" key inside settingsJson must not override it.
 */
export function buildProfileBody(
  spec: ProfileSpec,
  settings: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return { ...(settings ?? {}), name: spec.name }
}
