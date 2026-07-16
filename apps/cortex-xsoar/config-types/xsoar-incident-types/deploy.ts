import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildXsoarClient, parseJsonValue, xsoarErrorMessage, type XsoarClient } from '../../lib/xsoar'
import {
  extractIncidentTypeSpecs,
  isProtectedType,
  type IncidentTypeSpec,
  type LiveIncidentType,
} from './validate'

/** XSOAR marks a brand-new content item with version -1; the server assigns 1. */
const NEW_CONTENT_VERSION = -1

export interface IncidentTypeRollbackEntry {
  name: string
  existed: boolean
  /** Server id (needed for delete of a created type / restore of an updated one). */
  id?: string
  prior?: LiveIncidentType
}

/**
 * Deploy XSOAR incident types via the server REST API.
 *
 * Identity is the type NAME. List every incident type (GET /incidenttype), match
 * on name, then upsert with POST /incidenttype — sending version -1 for a new
 * type and the live version for an update so XSOAR accepts the write. Built-in /
 * locked (system) types are never modified.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildXsoarClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, serverUrl } = built

  const specs = extractIncidentTypeSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: IncidentTypeRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    const existing = await listIncidentTypes(client)
    const byName = new Map(existing.filter((t) => t.name).map((t) => [t.name as string, t]))

    for (const spec of specs) {
      const live = byName.get(spec.name)

      if (live && isProtectedType(live)) {
        throw new Error(`Incident type "${spec.name}" is a built-in/locked type and cannot be modified`)
      }

      if (live) {
        rollbackState.push({ name: spec.name, existed: true, id: live.id, prior: live })
        await saveIncidentType(client, spec, live)
      } else {
        const created = await saveIncidentType(client, spec, null)
        rollbackState.push({ name: spec.name, existed: false, id: created?.id })
        if (created?.id) createdIds.push(created.id)
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} incident type(s) to ${serverUrl}: ${deployed.join(', ')}`,
      artifacts: { serverUrl, deployedIncidentTypes: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Incident type deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { serverUrl, deployedIncidentTypes: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/** GET every incident type; throws on a non-OK response. */
export async function listIncidentTypes(client: XsoarClient): Promise<LiveIncidentType[]> {
  const res = await client.getJson<LiveIncidentType[]>('/incidenttype')
  if (!res.ok) throw new Error(`Failed to list incident types: ${res.error ?? `HTTP ${res.status}`}`)
  return Array.isArray(res.value) ? res.value : []
}

/**
 * Upsert one incident type via POST /incidenttype. On update, `live` supplies the
 * id + version XSOAR needs; on create, version -1 is sent and the server assigns
 * the id. Returns the saved type (with its server id).
 */
export async function saveIncidentType(
  client: XsoarClient,
  spec: IncidentTypeSpec,
  live: LiveIncidentType | null,
): Promise<LiveIncidentType | null> {
  const body: Record<string, unknown> = {
    name: spec.name,
    color: spec.color ?? live?.color ?? '#000000',
    playbookId: spec.playbookId ?? '',
    autorun: spec.autorun,
    disabled: spec.disabled,
    preProcessingScript: spec.preProcessingScript ?? '',
    closureScript: spec.closureScript ?? '',
    version: live && typeof live.version === 'number' ? live.version : NEW_CONTENT_VERSION,
  }
  if (live?.id) body.id = live.id

  const res = await client.request('POST', '/incidenttype', { body })
  if (!res.ok) throw new Error(`Failed to save incident type "${spec.name}": ${xsoarErrorMessage(res)}`)
  return parseJsonValue<LiveIncidentType>(res.body).value
}
