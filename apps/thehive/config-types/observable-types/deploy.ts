import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildThehiveUrl, buildAuthHeader, sendJson, listObservableTypes, PRIMARY } from '../../lib/thehiveApi'
import {
  buildObservableTypeBody,
  findObservableType,
  observableTypeId,
  observableTypesFromList,
  type ObservableType,
} from './_shared'

/**
 * Deploy TheHive observable types over the REST API:
 *   read (rollback): list observable types             → find the live one by name
 *   create:          POST /api/v1/observable/type        with InputObservableType
 *
 * TheHive 5 has NO update endpoint for observable types, so this is a
 * create-if-missing upsert: an existing type is left untouched (its isAttachment
 * flag can't be changed in place — surfaced by drift instead). rollbackData
 * records ONLY the types we created (field null) so rollback deletes exactly
 * those and never touches pre-existing types.
 *
 * v5 paths are primary (see lib/thehiveApi.ts API_VERSION seam). Verify against a
 * live TheHive (see README, v4 vs v5).
 */
async function listTypes(base: string, headers: Record<string, string>): Promise<ObservableType[]> {
  try {
    return observableTypesFromList(await listObservableTypes<ObservableType>(base, headers))
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for observable type deployment' }
  }

  const base = buildThehiveUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const previous: Array<{ name: string; typeId: string | null }> = []
  const created: string[] = []
  const skipped: string[] = []

  try {
    const live = await listTypes(base, headers)

    for (const item of items) {
      const name = String(item.fields.name ?? '').trim()
      if (!name) continue

      const existing = findObservableType(live, name)
      if (existing) {
        // No update endpoint — leave it as-is, record nothing to roll back.
        skipped.push(name)
        continue
      }
      const madeType = await sendJson<ObservableType>('POST', `${base}${PRIMARY.observableType}`, headers, buildObservableTypeBody(item.fields))
      previous.push({ name, typeId: observableTypeId(madeType) })
      created.push(name)
    }

    const parts = [`${created.length} created`]
    if (skipped.length) parts.push(`${skipped.length} already present`)
    return {
      success: true,
      message: `Observable types: ${parts.join(', ')}${created.length ? ` (${created.join(', ')})` : ''}`,
      artifacts: { created, skipped },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Observable type deploy failed after ${created.length} created: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { created, skipped },
      rollbackData: { previous },
    }
  }
}
