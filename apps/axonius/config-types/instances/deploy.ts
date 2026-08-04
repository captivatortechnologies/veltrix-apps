import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildAxoniusUrl, buildAuthHeaders, apiUrl, getJson, sendJson, verifyTls } from '../../lib/axoniusApi'
import { INSTANCES_LIST_RESOURCE, UPDATE_INSTANCE_RESOURCE, instancesFromResponse, findInstance, buildUpdateAttrsBody, parseText, parseBool, type AxoniusInstance } from './_shared'

/**
 * Deploy Axonius instance attrs over the REST API (443):
 *   read:   GET api/instances  → find the live instance by node_id (also the
 *           rollback snapshot — this config type is update-only, so there is
 *           no "created" branch)
 *   update: PUT api/instances  with the FLAT (non-JSON:API) update_attrs body
 *           — see _shared.ts for why
 *
 * A node_id that doesn't match a live instance fails the whole deploy with a
 * clear error — this config type never creates a node. rollbackData records,
 * per instance, the prior node_name/hostname/use_as_environment_name so
 * rollback can restore them exactly. Verify against a live Axonius tenant.
 */
interface PriorEntry {
  nodeId: string
  attributes: Record<string, unknown>
}

function snapshotAttributes(instance: AxoniusInstance): Record<string, unknown> {
  return {
    node_name: instance.node_name ?? '',
    hostname: instance.hostname ?? '',
    use_as_environment_name: instance.use_as_environment_name === true,
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for instance deployment' }
  }

  const base = buildAxoniusUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeaders(credential)
  if (Object.keys(headers).length !== 2) {
    return { success: false, message: 'Axonius needs an API key (username) and API secret (token) — attach both to this connection.' }
  }
  const opts = { verifyTls: verifyTls(settings) }

  const previous: PriorEntry[] = []
  const applied: string[] = []

  try {
    const live = instancesFromResponse(await getJson<unknown>(apiUrl(base, settings, INSTANCES_LIST_RESOURCE), headers, { verifyTls: verifyTls(settings) }))

    for (const item of items) {
      const nodeId = parseText(item.fields.node_id)
      if (!nodeId) continue

      const existing = findInstance(live, nodeId)
      if (!existing) {
        throw new Error(`Instance with node_id "${nodeId}" was not found — this config type never creates a node. Confirm the node_id against GET api/instances.`)
      }

      const body = buildUpdateAttrsBody({
        nodeId,
        nodeName: parseText(item.fields.node_name),
        hostname: parseText(item.fields.hostname) || String(existing.hostname ?? ''),
        useAsEnvironmentName: parseBool(item.fields.use_as_environment_name),
      })

      await sendJson('PUT', apiUrl(base, settings, UPDATE_INSTANCE_RESOURCE), headers, body, opts)
      previous.push({ nodeId, attributes: snapshotAttributes(existing) })
      applied.push(nodeId)
    }

    return {
      success: true,
      message: `Applied ${applied.length} instance${applied.length === 1 ? '' : 's'}: ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Instance deploy failed after ${applied.length} instance${applied.length === 1 ? '' : 's'}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
