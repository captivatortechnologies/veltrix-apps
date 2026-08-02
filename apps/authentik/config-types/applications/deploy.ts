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
import { buildCreateBody, buildPatchBody, snapshotManagedFields, type AuthentikApplication, type ManagedApplicationFields } from './_shared'

/**
 * Deploy authentik Applications over the Core API:
 *   read (identity):  GET   /core/applications/{slug}/   → 200 existing, 404 missing
 *   create:            POST  /core/applications/           with an `ApplicationRequest`
 *   update:            PATCH /core/applications/{slug}/    with a `PatchedApplicationRequest`
 *                       (partial — fields this config type does not manage, e.g.
 *                       meta_launch_url / open_in_new_tab / meta_hide, are left alone)
 *
 * The `slug` is authentik's own path identity for the resource (unlike, say,
 * Auth0's server-assigned client_id), so this config type retrieves by identity
 * directly rather than listing and matching by name. `rollbackData` records, per
 * item, the prior managed fields (null when it did not exist) — rollback PATCHes
 * them back, or DELETEs an application this deploy created.
 */
interface PreviousEntry {
  slug: string
  existed: boolean
  prior: ManagedApplicationFields | null
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

      const path = `${base}/core/applications/${encodeURIComponent(slug)}/`
      const existing = await getJsonOrNull<AuthentikApplication>(path, token, { verifyTls })

      if (existing) {
        await sendJson('PATCH', path, token, buildPatchBody(item.fields), { verifyTls })
        previous.push({ slug, existed: true, prior: snapshotManagedFields(existing) })
      } else {
        await sendJson('POST', `${base}/core/applications/`, token, buildCreateBody(slug, item.fields), { verifyTls })
        previous.push({ slug, existed: false, prior: null })
      }
      applied.push(slug)
    }

    return {
      success: true,
      message: `Applied ${applied.length} application(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `authentik application deploy failed after ${applied.length} application(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
