import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient, falconFailure, parseEnvelope, type FalconClient } from '../../lib/falcon'
import { findEntityByIdentity, type EntityEndpoints } from '../../lib/entityAdapter'
import { extractScriptSpecs, type LiveRtrScript, type ScriptSpec } from './validate'

// RTR script CREATE and UPDATE are multipart/form-data only (verified against
// FalconPy real_time_response_admin — no JSON alternative); the script body
// rides in the `content` form field. Sent via FalconClient.requestMultipart.
// find/get/delete/drift use JSON + query params. Worth a live smoke test.

const DEPLOY_AUDIT_COMMENT = 'Managed by Veltrix (crowdstrike-edr app)'
const ROLLBACK_AUDIT_COMMENT = 'Rollback by Veltrix (crowdstrike-edr app)'

/** Query/get/create/update/delete paths + identity field for RTR scripts. */
export const SCRIPT_ENDPOINTS: EntityEndpoints = {
  entity: '/real-time-response/entities/scripts/v1',
  queries: '/real-time-response/queries/scripts/v1',
  identityField: 'name',
}

/** Script fields this app manages and can restore on rollback. */
export interface ScriptRollbackEntry {
  name: string
  existed: boolean
  id?: string
  prior?: {
    description?: string
    platform?: string | string[]
    permission_type?: string
    content?: string
  }
}

/**
 * Deploy RTR custom scripts to a Falcon tenant.
 *
 * For each declared script:
 *   - find it by name (query → get, JSON)
 *   - PATCH the existing script (converge managed fields) — multipart, see caveat
 *   - POST a new script when missing — multipart, see caveat
 * A script's `name` is its identity; platform / permission_type / description /
 * content are the managed fields.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractScriptSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: ScriptRollbackEntry[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const existing = await findScript(client, spec.name)

      if (existing?.id) {
        rollbackState.push({
          name: spec.name,
          existed: true,
          id: existing.id,
          prior: {
            description: existing.description,
            platform: existing.platform,
            permission_type: existing.permission_type,
            content: existing.content,
          },
        })
        await updateScript(client, existing.id, spec)
      } else {
        const id = await createScript(client, spec)
        rollbackState.push({ name: spec.name, existed: false, id })
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} RTR script(s) to Falcon tenant at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedScripts: deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `RTR script deployment failed after ${deployed.length} of ${specs.length} script(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedScripts: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState },
    }
  }
}

// --- Helpers ---

/** Look up a script by its exact name; null when absent. */
export async function findScript(client: FalconClient, name: string): Promise<LiveRtrScript | null> {
  const found = await findEntityByIdentity(client, SCRIPT_ENDPOINTS, name)
  return (found as LiveRtrScript | null) ?? null
}

/** The create/update fields as the RTR Admin multipart form expects them. */
export function scriptFormFields(spec: ScriptSpec): Record<string, string | undefined> {
  return {
    name: spec.name,
    description: spec.description,
    permission_type: spec.permissionType,
    platform: spec.platform,
    content: spec.content,
    comments_for_audit_log: spec.commentsForAuditLog ?? DEPLOY_AUDIT_COMMENT,
  }
}

/** Create a script; returns the new id (or throws). */
export async function createScript(client: FalconClient, spec: ScriptSpec): Promise<string> {
  const res = await client.requestMultipart('POST', SCRIPT_ENDPOINTS.entity, {
    fields: scriptFormFields(spec),
  })
  const failure = falconFailure(res)
  if (failure) {
    throw new Error(`Failed to create RTR script "${spec.name}": ${failure}`)
  }
  // Create returns the new id as a bare string or an object — tolerate both.
  const created = parseEnvelope<LiveRtrScript | string>(res.body)?.resources?.[0]
  const id = typeof created === 'string' ? created : created?.id
  if (!id) {
    throw new Error(`RTR script "${spec.name}" was created but the API returned no id`)
  }
  return id
}

/** Update an existing script in place. */
export async function updateScript(client: FalconClient, id: string, spec: ScriptSpec): Promise<void> {
  const res = await client.requestMultipart('PATCH', SCRIPT_ENDPOINTS.entity, {
    fields: { id, ...scriptFormFields(spec) },
  })
  const failure = falconFailure(res)
  if (failure) {
    throw new Error(`Failed to update RTR script "${spec.name}": ${failure}`)
  }
}

/**
 * Restore a script's captured prior values (rollback). Only the fields that
 * were captured are sent, so a value GET never returned (e.g. content) is left
 * untouched rather than clobbered with an empty body.
 */
export async function restoreScript(
  client: FalconClient,
  id: string,
  name: string,
  prior: NonNullable<ScriptRollbackEntry['prior']>,
): Promise<void> {
  const fields: Record<string, string | undefined> = {
    id,
    name,
    comments_for_audit_log: ROLLBACK_AUDIT_COMMENT,
  }
  if (prior.description !== undefined) fields.description = prior.description
  if (prior.permission_type !== undefined) fields.permission_type = prior.permission_type
  if (prior.platform !== undefined) {
    fields.platform = Array.isArray(prior.platform) ? prior.platform[0] : prior.platform
  }
  if (prior.content !== undefined) fields.content = prior.content

  const res = await client.requestMultipart('PATCH', SCRIPT_ENDPOINTS.entity, { fields })
  const failure = falconFailure(res)
  if (failure) {
    throw new Error(`Failed to restore RTR script "${name}": ${failure}`)
  }
}

/** Delete a script by id, tolerating 404 (already gone is the desired state). */
export async function deleteScript(client: FalconClient, id: string): Promise<void> {
  const res = await client.request('DELETE', SCRIPT_ENDPOINTS.entity, {
    query: { ids: id },
  })
  const failure = res.status === 404 ? null : falconFailure(res)
  if (failure) {
    throw new Error(`Failed to delete RTR script: ${failure}`)
  }
}
