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
import { buildCreateBody, buildPatchBody, snapshotManagedFields, type AuthentikFlow, type ManagedFlowFields } from './_shared'

/**
 * Deploy authentik Flows over the Flows API:
 *   read (identity): GET   /flows/instances/{slug}/   → 200 existing, 404 missing
 *   create:           POST  /flows/instances/           a `FlowRequest`
 *   update:           PATCH /flows/instances/{slug}/    a `PatchedFlowRequest`
 *
 * Like Applications, a flow's `slug` is authentik's own path identity for the
 * resource, so this config type retrieves by identity directly rather than
 * listing and matching by name. `rollbackData` records, per item, the prior
 * managed fields (null when it did not exist) — rollback PATCHes them back, or
 * DELETEs a flow this deploy created.
 */
interface PreviousEntry {
  slug: string
  existed: boolean
  prior: ManagedFlowFields | null
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

      const path = `${base}/flows/instances/${encodeURIComponent(slug)}/`
      const existing = await getJsonOrNull<AuthentikFlow>(path, token, { verifyTls })

      if (existing) {
        await sendJson('PATCH', path, token, buildPatchBody(item.fields), { verifyTls })
        previous.push({ slug, existed: true, prior: snapshotManagedFields(existing) })
      } else {
        await sendJson('POST', `${base}/flows/instances/`, token, buildCreateBody(slug, item.fields), { verifyTls })
        previous.push({ slug, existed: false, prior: null })
      }
      applied.push(slug)
    }

    return {
      success: true,
      message: `Applied ${applied.length} flow(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `authentik flow deploy failed after ${applied.length} flow(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
