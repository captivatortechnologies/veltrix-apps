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
import { buildCreateBody, buildPatchBody, snapshotManagedFields, type AuthentikSAMLProvider, type ManagedSAMLProviderFields } from './_shared'

/**
 * Deploy authentik SAML Providers over the Core API:
 *   read (identity): GET   /providers/saml/?name=<name>   → list + exact-match
 *   create:           POST  /providers/saml/                a `SAMLProviderRequest`
 *   update:           PATCH /providers/saml/{pk}/            a `PatchedSAMLProviderRequest`
 */
interface PreviousEntry {
  name: string
  pk: number | null
  existed: boolean
  prior: ManagedSAMLProviderFields | null
}
interface CreatedProvider {
  pk?: number
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  const token = resolveApiToken(credential)
  if (!token) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }

  const base = buildApiBase(buildAuthentikUrl(component, connectivity, connectivityProvider))
  const verifyTls = resolveVerifyTls(settings)
  const listUrl = `${base}/providers/saml/`

  const previous: PreviousEntry[] = []
  const applied: string[] = []

  try {
    for (const item of items) {
      const name = String(item.fields.name ?? '').trim()
      if (!name) continue

      const existing = await findByName<AuthentikSAMLProvider>(listUrl, token, name, { verifyTls })

      if (existing && typeof existing.pk === 'number') {
        await sendJson('PATCH', `${listUrl}${existing.pk}/`, token, buildPatchBody(item.fields), { verifyTls })
        previous.push({ name, pk: existing.pk, existed: true, prior: snapshotManagedFields(existing) })
      } else {
        const created = await sendJson<CreatedProvider>('POST', listUrl, token, buildCreateBody(item.fields), { verifyTls })
        previous.push({ name, pk: typeof created?.pk === 'number' ? created.pk : null, existed: false, prior: null })
      }
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} SAML provider(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `authentik SAML provider deploy failed after ${applied.length} provider(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
