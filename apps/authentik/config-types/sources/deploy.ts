import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildAuthentikUrl,
  buildApiBase,
  resolveApiToken,
  resolveVerifyTls,
  getJsonOrNull,
  sendJson,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/authentikApi'
import {
  buildCreateBody,
  buildPatchBody,
  readSourceType,
  SOURCE_ENDPOINT_SEGMENT,
  snapshotManagedFields,
  type AuthentikSource,
  type ManagedSourceFields,
  type SourceType,
} from './_shared'

/**
 * Deploy authentik Sources over the Core API. Each item's Type selects a
 * DIFFERENT authentik model/endpoint:
 *   read (identity): GET   /sources/<segment>/{slug}/   → 200 existing, 404 missing
 *   create:           POST  /sources/<segment>/           the type's *SourceRequest
 *   update:           PATCH /sources/<segment>/{slug}/     the type's Patched*SourceRequest
 *
 * Like Applications/Flows, a source's `slug` is its own path identity, so this
 * retrieves by identity directly (within the item's selected type's
 * endpoint) rather than listing and matching by name. `consumer_secret` /
 * `bind_password` are write-only — see _shared.ts.
 */
interface PreviousEntry {
  slug: string
  type: SourceType
  existed: boolean
  prior: ManagedSourceFields | null
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
      const slug = String(item.fields.slug ?? '').trim()
      if (!slug) continue
      const type = readSourceType(item.fields.type)
      const listUrl = `${base}/sources/${SOURCE_ENDPOINT_SEGMENT[type]}/`
      const path = `${listUrl}${encodeURIComponent(slug)}/`

      const existing = await getJsonOrNull<AuthentikSource>(path, token, { verifyTls })

      if (existing) {
        await sendJson('PATCH', path, token, buildPatchBody(item.fields), { verifyTls })
        previous.push({ slug, type, existed: true, prior: snapshotManagedFields(existing, type) })
      } else {
        await sendJson('POST', listUrl, token, buildCreateBody(item.fields), { verifyTls })
        previous.push({ slug, type, existed: false, prior: null })
      }
      applied.push(`${slug} (${type})`)
    }

    return {
      success: true,
      message: `Applied ${applied.length} source(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `authentik source deploy failed after ${applied.length} source(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
