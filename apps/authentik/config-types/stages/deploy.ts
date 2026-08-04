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
import {
  buildCreateBody,
  buildPatchBody,
  STAGE_ENDPOINT_SEGMENT,
  readStageType,
  snapshotManagedFields,
  type AuthentikStage,
  type ManagedStageFields,
  type StageType,
} from './_shared'

/**
 * Deploy authentik Stages over the Core API. Each item's Type selects a
 * DIFFERENT authentik model/endpoint:
 *   read (identity): GET   /stages/<segment>/?name=<name>   → list + exact-match
 *   create:           POST  /stages/<segment>/                the type's *StageRequest
 *   update:           PATCH /stages/<segment>/{stage_uuid}/    the type's Patched*StageRequest
 *
 * Retyping an existing item is NOT migrated — see canvas.yaml's header comment.
 */
interface PreviousEntry {
  name: string
  type: StageType
  pk: string | null
  existed: boolean
  prior: ManagedStageFields | null
}
interface CreatedStage {
  pk?: string
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  const token = resolveApiToken(credential)
  if (!token) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }

  const base = buildApiBase(buildAuthentikUrl(component, connectivity, connectivityProvider))
  const verifyTls = resolveVerifyTls(settings)

  const previous: PreviousEntry[] = []
  const applied: string[] = []

  try {
    for (const item of items) {
      const name = String(item.fields.name ?? '').trim()
      if (!name) continue
      const type = readStageType(item.fields.type)
      const listUrl = `${base}/stages/${STAGE_ENDPOINT_SEGMENT[type]}/`

      const existing = await findByName<AuthentikStage>(listUrl, token, name, { verifyTls })

      if (existing && existing.pk) {
        await sendJson('PATCH', `${listUrl}${encodeURIComponent(existing.pk)}/`, token, buildPatchBody(item.fields), { verifyTls })
        previous.push({ name, type, pk: existing.pk, existed: true, prior: snapshotManagedFields(existing, type) })
      } else {
        const created = await sendJson<CreatedStage>('POST', listUrl, token, buildCreateBody(item.fields), { verifyTls })
        previous.push({ name, type, pk: created?.pk ?? null, existed: false, prior: null })
      }
      applied.push(`${name} (${type})`)
    }

    return {
      success: true,
      message: `Applied ${applied.length} stage(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `authentik stage deploy failed after ${applied.length} stage(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
