import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildDarktraceUrl, darktraceAuthFrom, dtGetJson, dtPostJson, type DarktraceAuth } from '../../lib/darktraceApi'
import { buildCreateBody, findTag, normalizeName, tagsFromList, tidFrom, type DarktraceTag } from './_shared'

/**
 * Deploy Darktrace tags over the REST API (443, DSA-signed):
 *   read (identity + rollback): GET  /tags          → live tags
 *   create:                     POST /tags { name, color?, description? }
 *
 * The tag name is the stable identity. Darktrace's tags are create/delete only
 * (no edit), so this UPSERTS idempotently: a tag that already exists is left
 * untouched (and NOT claimed for rollback); a new tag is created and its numeric
 * `tid` recorded in rollbackData.created so rollback can delete exactly what this
 * deploy created. When the create response omits the new tid it is resolved with a
 * single follow-up GET /tags. Verify against a live Darktrace.
 */

/** Read every live tag (best-effort) for identity matching + rollback. */
async function listTags(base: string, auth: DarktraceAuth): Promise<DarktraceTag[]> {
  try {
    return tagsFromList(await dtGetJson<unknown>(base, '/tags', {}, auth))
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  const auth = darktraceAuthFrom(credential)
  if (!auth) {
    return { success: false, message: 'Missing Darktrace API token pair (public + private) for tags deployment' }
  }

  const base = buildDarktraceUrl(component, connectivity, connectivityProvider)

  const created: Array<{ name: string; tid: number | null }> = []
  const applied: string[] = []
  let skipped = 0

  try {
    const live = await listTags(base, auth)

    for (const item of items) {
      const name = normalizeName(item.fields.name)
      if (!name) continue

      if (findTag(live, name)) {
        skipped++ // already present — idempotent no-op, not ours to roll back
        continue
      }

      const res = await dtPostJson<unknown>(base, '/tags', buildCreateBody(item.fields), auth)
      created.push({ name, tid: tidFrom(res) })
      applied.push(name)
    }

    // Resolve any tid the create response did not return, so rollback can delete
    // by tid rather than being left with an un-removable tag.
    if (created.some((c) => c.tid === null)) {
      const after = await listTags(base, auth)
      for (const c of created) {
        if (c.tid === null) c.tid = tidFrom(findTag(after, c.name))
      }
    }

    const summary = applied.length
      ? `Created ${applied.length} tag${applied.length === 1 ? '' : 's'}: ${applied.join(', ')}`
      : 'No new tags to create (all already present).'
    return {
      success: true,
      message: skipped ? `${summary} (${skipped} already present)` : summary,
      artifacts: { applied, skipped },
      rollbackData: { created },
    }
  } catch (error) {
    return {
      success: false,
      message: `Tags deploy failed after ${applied.length} tag${applied.length === 1 ? '' : 's'}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { created },
    }
  }
}
