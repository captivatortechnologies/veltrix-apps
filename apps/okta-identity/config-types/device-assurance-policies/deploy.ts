import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient, oktaErrorMessage, parseJson, type OktaClient } from '../../lib/okta'
import {
  extractDeviceAssuranceSpecs,
  parseConfigObject,
  type DeviceAssuranceSpec,
  type LiveDeviceAssurance,
} from './validate'

export interface DeviceAssuranceRollbackEntry {
  name: string
  existed: boolean
  /** The policy id Okta assigns — the rollback key (never the name). */
  id?: string
  /** Prior policy body with server-managed readOnly fields stripped, replayed via PUT. */
  prior?: Record<string, unknown>
}

/** Server-managed fields Okta returns on a policy but that must never be sent back. */
export const READONLY_DEVICE_ASSURANCE_FIELDS = [
  'id',
  'createdBy',
  'createdDate',
  'lastUpdate',
  'lastUpdatedBy',
  '_links',
] as const

/**
 * Deploy device assurance policies to an Okta org via the Device Assurance API.
 * NO UPSERT exists, so for each declared policy:
 *   - GET  /device-assurances          — list (paginated) and match by name
 *   - PUT  /device-assurances/{id}     — update an existing policy (capture prior)
 *   - POST /device-assurances          — create a missing policy (capture the id)
 *
 * `platform` is immutable — a matched policy whose declared platform differs is
 * rejected with clear "delete and recreate" guidance. There is no lifecycle.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractDeviceAssuranceSpecs(ctx.canvas).filter((s) => s.name && s.platform && s.configJson)
  const rollbackState: DeviceAssuranceRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const config = spec.configJson ? parseConfigObject(spec.configJson) : null
      if (config === null) {
        throw new Error(`Device assurance policy "${spec.name}": requirements (configJson) is not a valid JSON object`)
      }

      const existing = await findDeviceAssurance(client, spec.name)

      if (existing && existing.id) {
        // platform is immutable — fail fast with clear guidance.
        if (existing.platform && spec.platform !== existing.platform) {
          throw new Error(
            `Device assurance policy "${spec.name}" already exists for platform "${existing.platform}" — the platform is immutable. Delete and recreate the policy to change it.`,
          )
        }

        // UPDATE IN PLACE. Capture the prior body (keyed on the returned id).
        rollbackState.push({
          name: spec.name,
          existed: true,
          id: existing.id,
          prior: stripReadOnlyDeviceAssuranceFields(existing),
        })

        const res = await client.request('PUT', `/device-assurances/${existing.id}`, {
          body: buildDeviceAssuranceBody(spec, config),
        })
        if (!res.ok) {
          throw new Error(`Failed to update device assurance policy "${spec.name}": ${oktaErrorMessage(res)}`)
        }
      } else {
        const res = await client.request('POST', '/device-assurances', {
          body: buildDeviceAssuranceBody(spec, config),
        })
        if (!res.ok) {
          throw new Error(`Failed to create device assurance policy "${spec.name}": ${oktaErrorMessage(res)}`)
        }
        const created = parseJson<LiveDeviceAssurance>(res.body)
        if (!created?.id) {
          throw new Error(`Device assurance policy "${spec.name}" was created but the API returned no id`)
        }
        rollbackState.push({ name: spec.name, existed: false, id: created.id })
        createdIds.push(created.id)
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} device assurance policy(ies) to Okta org at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedPolicies: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Device assurance policy deployment failed after ${deployed.length} of ${specs.length} policy(ies): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedPolicies: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ------------------------------------------------------------------

/** Find a policy by exact name across the paginated list; null when absent. */
export async function findDeviceAssurance(client: OktaClient, name: string): Promise<LiveDeviceAssurance | null> {
  const res = await client.getAll<LiveDeviceAssurance>('/device-assurances')
  if (!res.ok) {
    throw new Error(
      `Failed to list device assurance policies while resolving "${name}": ${oktaErrorMessage({
        status: res.status,
        ok: res.ok,
        body: res.body,
        nextUrl: null,
      })}`,
    )
  }
  return res.items.find((p) => p.name === name) ?? null
}

/** Fetch a single policy by id; null on 404. */
export async function getDeviceAssuranceById(client: OktaClient, id: string): Promise<LiveDeviceAssurance | null> {
  const res = await client.request('GET', `/device-assurances/${id}`)
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`Failed to fetch device assurance policy ${id}: ${oktaErrorMessage(res)}`)
  }
  return parseJson<LiveDeviceAssurance>(res.body)
}

/**
 * Build the create/update body: the platform-specific requirements come from the
 * parsed config blob, while platform/name come from the modeled fields and always
 * win — the free-form JSON can never override the policy's identity.
 */
export function buildDeviceAssuranceBody(
  spec: DeviceAssuranceSpec,
  config: Record<string, unknown>,
): Record<string, unknown> {
  return { ...config, platform: spec.platform, name: spec.name }
}

/** Copy a live policy without the server-managed readOnly fields (safe to PUT back). */
export function stripReadOnlyDeviceAssuranceFields(policy: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(policy)) {
    if (!(READONLY_DEVICE_ASSURANCE_FIELDS as readonly string[]).includes(key)) out[key] = value
  }
  return out
}
