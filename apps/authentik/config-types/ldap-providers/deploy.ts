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
import { buildCreateBody, buildPatchBody, snapshotManagedFields, type AuthentikLDAPProvider, type ManagedLDAPProviderFields } from './_shared'

/**
 * Deploy authentik LDAP Providers over the Core API:
 *   read (identity): GET   /providers/ldap/?name=<name>   → list + exact-match
 *   create:           POST  /providers/ldap/                a `LDAPProviderRequest`
 *   update:           PATCH /providers/ldap/{pk}/            a `PatchedLDAPProviderRequest`
 */
interface PreviousEntry {
  name: string
  pk: number | null
  existed: boolean
  prior: ManagedLDAPProviderFields | null
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
  const listUrl = `${base}/providers/ldap/`

  const previous: PreviousEntry[] = []
  const applied: string[] = []

  try {
    for (const item of items) {
      const name = String(item.fields.name ?? '').trim()
      if (!name) continue

      const existing = await findByName<AuthentikLDAPProvider>(listUrl, token, name, { verifyTls })

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
      message: `Applied ${applied.length} LDAP provider(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `authentik LDAP provider deploy failed after ${applied.length} provider(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
