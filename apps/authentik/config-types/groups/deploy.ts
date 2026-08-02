import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildAuthentikUrl,
  buildApiBase,
  resolveApiToken,
  resolveVerifyTls,
  findByName,
  sendJson,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/authentikApi'
import { buildCreateBody, buildPatchBody, snapshotManagedFields, type AuthentikGroup, type ManagedGroupFields } from './_shared'

/**
 * Deploy authentik Groups over the Core API:
 *   read (identity): GET   /core/groups/?name=<name>   → list + exact-match
 *                     (the path key is a server-assigned UUID, not a
 *                     user-declared identity, so this upserts by NAME)
 *   create:           POST  /core/groups/                an `GroupRequest`
 *   update:           PATCH /core/groups/{group_uuid}/    a `PatchedGroupRequest`
 *
 * `rollbackData` records, per item, the prior managed fields (null when it did
 * not exist) and the resolved `pk` (UUID) — rollback PATCHes them back, or
 * DELETEs a group this deploy created. Group membership (`users`) and `roles`
 * are never sent — see _shared.ts.
 */
interface PreviousEntry {
  name: string
  pk: string | null
  existed: boolean
  prior: ManagedGroupFields | null
}

interface CreatedGroup {
  pk?: string
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  const token = resolveApiToken(credential)
  if (!token) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }

  const base = buildApiBase(buildAuthentikUrl(component, connectivity, connectivityProvider))
  const verifyTls = resolveVerifyTls(settings)
  const listUrl = `${base}/core/groups/`

  const previous: PreviousEntry[] = []
  const applied: string[] = []

  try {
    for (const item of items) {
      const name = String(item.fields.name ?? '').trim()
      if (!name) continue

      const existing = await findByName<AuthentikGroup>(listUrl, token, name, { verifyTls })

      if (existing && existing.pk) {
        await sendJson('PATCH', `${listUrl}${encodeURIComponent(existing.pk)}/`, token, buildPatchBody(item.fields), { verifyTls })
        previous.push({ name, pk: existing.pk, existed: true, prior: snapshotManagedFields(existing) })
      } else {
        const created = await sendJson<CreatedGroup>('POST', listUrl, token, buildCreateBody(item.fields), { verifyTls })
        previous.push({ name, pk: created?.pk ?? null, existed: false, prior: null })
      }
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} group(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `authentik group deploy failed after ${applied.length} group(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
