import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildCybereasonUrl,
  createSession,
  resolveTimeoutMs,
  looksLikeLoginPage,
  type CybereasonSession,
} from '../../lib/cybereasonApi'
import {
  GROUP_ENDPOINTS,
  buildGroupBody,
  groupsFromResponse,
  findGroupByName,
  groupId,
  createdGroupId,
  type CybereasonGroup,
} from './_shared'

/**
 * Deploy Cybereason sensor groups over the REST API:
 *   read (rollback): GET  /rest/groups       → prior snapshot
 *   update:          PUT  /rest/groups/{id}   when a group of that name exists
 *   create:          POST /rest/groups        otherwise → { groupId }
 *
 * Upsert is by group NAME. rollbackData records, per group, the prior group body
 * (null when it did not exist) and — for a group this deploy CREATED — the new
 * GUID, so rollback can restore the prior body or delete the created group.
 */
async function listGroups(session: CybereasonSession): Promise<CybereasonGroup[]> {
  try {
    const res = await session.get(GROUP_ENDPOINTS.list)
    if (!res.ok || looksLikeLoginPage(res.body)) return []
    return groupsFromResponse(res.body)
  } catch {
    return []
  }
}

interface PreviousGroup {
  name: string
  prior: CybereasonGroup | null
  createdId: string | null
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) return { success: false, message: 'Missing credential for sensor-group deployment' }

  const base = buildCybereasonUrl(component, connectivity, connectivityProvider)
  const timeoutMs = resolveTimeoutMs(settings)

  const previous: PreviousGroup[] = []
  const applied: string[] = []

  try {
    const session = await createSession(base, credential, timeoutMs)
    const live = await listGroups(session)

    for (const item of items) {
      const name = String(item.fields.name ?? '').trim()
      if (!name) continue
      const body = buildGroupBody(item.fields)
      const existing = findGroupByName(live, name)

      if (existing) {
        const id = groupId(existing)
        const res = await session.putJson(GROUP_ENDPOINTS.update(id), { ...existing, ...body })
        if (!res.ok || looksLikeLoginPage(res.body)) {
          throw new Error(`groups PUT → HTTP ${res.status}: ${res.body.slice(0, 200)}`)
        }
        previous.push({ name, prior: existing, createdId: null })
      } else {
        const res = await session.postJson(GROUP_ENDPOINTS.create, body)
        if (!res.ok || looksLikeLoginPage(res.body)) {
          throw new Error(`groups POST → HTTP ${res.status}: ${res.body.slice(0, 200)}`)
        }
        previous.push({ name, prior: null, createdId: createdGroupId(res.body) || null })
      }
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} sensor group(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Sensor-group deploy failed after ${applied.length} item(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
