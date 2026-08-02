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
import { buildCreateBody, buildPatchBody, snapshotManagedFields, type AuthentikOAuth2Provider, type ManagedOAuth2ProviderFields } from './_shared'

/**
 * Deploy authentik OAuth2/OpenID Providers over the Core API:
 *   read (identity): GET   /providers/oauth2/?name=<name>   → list + exact-match
 *                     (the path key is a server-assigned integer `pk`, not a
 *                     user-declared identity, so — unlike Applications/Flows —
 *                     this upserts by NAME rather than retrieving directly)
 *   create:           POST  /providers/oauth2/                an `OAuth2ProviderRequest`
 *   update:           PATCH /providers/oauth2/{pk}/            a `PatchedOAuth2ProviderRequest`
 *
 * `client_secret` is never read, sent or captured — authentik generates/rotates
 * it and this config type treats it as a write-only value it does not manage.
 * `rollbackData` records, per item, the prior managed fields (null when it did
 * not exist) and the resolved `pk` — rollback PATCHes them back, or DELETEs a
 * provider this deploy created.
 */
interface PreviousEntry {
  name: string
  pk: number | null
  existed: boolean
  prior: ManagedOAuth2ProviderFields | null
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
  const listUrl = `${base}/providers/oauth2/`

  const previous: PreviousEntry[] = []
  const applied: string[] = []

  try {
    for (const item of items) {
      const name = String(item.fields.name ?? '').trim()
      if (!name) continue

      const existing = await findByName<AuthentikOAuth2Provider>(listUrl, token, name, { verifyTls })

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
      message: `Applied ${applied.length} OAuth2/OpenID provider(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `authentik OAuth2/OpenID provider deploy failed after ${applied.length} provider(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
