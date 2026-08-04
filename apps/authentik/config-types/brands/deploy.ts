import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildAuthentikUrl,
  buildApiBase,
  resolveApiToken,
  resolveVerifyTls,
  findByField,
  sendJson,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/authentikApi'
import { buildCreateBody, buildPatchBody, snapshotManagedFields, type AuthentikBrand, type ManagedBrandFields } from './_shared'

/**
 * Deploy authentik Brands over the Core API:
 *   read (identity): GET   /core/brands/?domain=<domain>   → list + exact-match
 *   create:           POST  /core/brands/                    a `BrandRequest`
 *   update:           PATCH /core/brands/{brand_uuid}/         a `PatchedBrandRequest`
 *
 * A brand's API path key is a server-assigned UUID, so this config type
 * upserts by DOMAIN via the generic `findByField` helper.
 */
interface PreviousEntry {
  domain: string
  pk: string | null
  existed: boolean
  prior: ManagedBrandFields | null
}
interface CreatedBrand {
  brand_uuid?: string
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  const token = resolveApiToken(credential)
  if (!token) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }

  const base = buildApiBase(buildAuthentikUrl(component, connectivity, connectivityProvider))
  const verifyTls = resolveVerifyTls(settings)
  const listUrl = `${base}/core/brands/`

  const previous: PreviousEntry[] = []
  const applied: string[] = []

  try {
    for (const item of items) {
      const domain = String(item.fields.domain ?? '').trim()
      if (!domain) continue

      const existing = await findByField<AuthentikBrand>(listUrl, token, 'domain', domain, { verifyTls })

      if (existing && existing.brand_uuid) {
        await sendJson('PATCH', `${listUrl}${encodeURIComponent(existing.brand_uuid)}/`, token, buildPatchBody(item.fields), { verifyTls })
        previous.push({ domain, pk: existing.brand_uuid, existed: true, prior: snapshotManagedFields(existing) })
      } else {
        const created = await sendJson<CreatedBrand>('POST', listUrl, token, buildCreateBody(item.fields), { verifyTls })
        previous.push({ domain, pk: created?.brand_uuid ?? null, existed: false, prior: null })
      }
      applied.push(domain)
    }

    return {
      success: true,
      message: `Applied ${applied.length} brand(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `authentik brand deploy failed after ${applied.length} brand(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
