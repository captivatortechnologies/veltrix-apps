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
import { buildCreateBody, buildPatchBody, snapshotManagedFields, type AuthentikScopeMapping, type ManagedScopeMappingFields } from './_shared'

/**
 * Deploy authentik Scope Mappings over the Core API:
 *   read (identity): GET   /propertymappings/provider/scope/?name=<name>   → list + exact-match
 *   create:           POST  /propertymappings/provider/scope/                a `ScopeMappingRequest`
 *   update:           PATCH /propertymappings/provider/scope/{pm_uuid}/       a `PatchedScopeMappingRequest`
 */
interface PreviousEntry {
  name: string
  pk: string | null
  existed: boolean
  prior: ManagedScopeMappingFields | null
}
interface CreatedMapping {
  pk?: string
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  const token = resolveApiToken(credential)
  if (!token) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }

  const base = buildApiBase(buildAuthentikUrl(component, connectivity, connectivityProvider))
  const verifyTls = resolveVerifyTls(settings)
  const listUrl = `${base}/propertymappings/provider/scope/`

  const previous: PreviousEntry[] = []
  const applied: string[] = []

  try {
    for (const item of items) {
      const name = String(item.fields.name ?? '').trim()
      if (!name) continue

      const existing = await findByName<AuthentikScopeMapping>(listUrl, token, name, { verifyTls })

      if (existing && existing.pk) {
        await sendJson('PATCH', `${listUrl}${encodeURIComponent(existing.pk)}/`, token, buildPatchBody(item.fields), { verifyTls })
        previous.push({ name, pk: existing.pk, existed: true, prior: snapshotManagedFields(existing) })
      } else {
        const created = await sendJson<CreatedMapping>('POST', listUrl, token, buildCreateBody(item.fields), { verifyTls })
        previous.push({ name, pk: created?.pk ?? null, existed: false, prior: null })
      }
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} scope mapping(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `authentik scope mapping deploy failed after ${applied.length} mapping(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
