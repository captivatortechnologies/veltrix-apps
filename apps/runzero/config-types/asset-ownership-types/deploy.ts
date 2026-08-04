import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildRunzeroUrl, buildAuthHeader, resolveRunzeroToken, getJson, sendJson, coerceList, MISSING_CREDENTIAL_MESSAGE } from '../../lib/runzeroApi'
import {
  buildOwnershipTypePost,
  buildOwnershipTypeUpdate,
  ownershipTypeMatches,
  findOwnershipType,
  text,
  type RunzeroOwnershipType,
  type OwnershipTypeRollbackEntry,
} from './_shared'

/**
 * Deploy runZero Asset Ownership Types over the console REST API's BATCH endpoints:
 *   read (identity): GET  /account/assets/ownership-types      → find each live type by name
 *   create:          POST /account/assets/ownership-types      body: array of new AssetOwnershipTypePost
 *   update:          PUT  /account/assets/ownership-types      body: array of changed AssetOwnershipType
 *
 * Unlike every other config type in this app, this sends AT MOST one batch POST and one batch PUT
 * per deploy — matching the endpoint's own array-in/array-out design — rather than one call per
 * item. Types whose declared fields already match the live type are skipped (no-op). The name is
 * the stable identity used to upsert. rollbackData records, per type, whether it already existed,
 * its id, and its prior body — so rollback can restore an update or delete a create.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!resolveRunzeroToken(credential)) {
    return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  const base = buildRunzeroUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)
  const timeoutMs = timeoutFrom(settings)

  const previous: OwnershipTypeRollbackEntry[] = []
  const applied: string[] = []

  try {
    const live = coerceList<RunzeroOwnershipType>(await getJson<unknown>(`${base}/account/assets/ownership-types`, headers, timeoutMs))

    const toCreate: Array<{ name: string; body: ReturnType<typeof buildOwnershipTypePost> }> = []
    const toUpdate: RunzeroOwnershipType[] = []

    for (const item of items) {
      const name = text(item.fields.name)
      if (!name) continue

      const existing = findOwnershipType(live, name)
      if (existing && existing.id) {
        if (!ownershipTypeMatches(existing, item.fields)) {
          toUpdate.push(buildOwnershipTypeUpdate(existing, item.fields))
        }
        previous.push({ name, typeId: existing.id, existed: true, prior: existing })
      } else {
        toCreate.push({ name, body: buildOwnershipTypePost(item.fields) })
      }
      applied.push(name)
    }

    if (toCreate.length > 0) {
      const created = coerceList<RunzeroOwnershipType>(
        await sendJson<unknown>('POST', `${base}/account/assets/ownership-types`, headers, toCreate.map((c) => c.body), timeoutMs),
      )
      for (const { name } of toCreate) {
        const match = findOwnershipType(created, name)
        previous.push({ name, typeId: match?.id ?? null, existed: false, prior: null })
      }
    }

    if (toUpdate.length > 0) {
      await sendJson('PUT', `${base}/account/assets/ownership-types`, headers, toUpdate, timeoutMs)
    }

    return {
      success: true,
      message: `Applied ${applied.length} asset ownership type(s): ${applied.join(', ') || '(none)'} (${toCreate.length} created, ${toUpdate.length} updated).`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Asset ownership type deploy failed after ${applied.length} type(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}

/** Resolve the per-request timeout (ms) from the app setting, defaulting to the client default. */
function timeoutFrom(settings: Record<string, unknown>): number | undefined {
  const raw = settings?.request_timeout_seconds
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw * 1000 : undefined
}
