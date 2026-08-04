import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildPackSpec, groupOf, listPacks, findPack, connectFor, sendJson, groupResourcePath, upgradeQuery, type PackInstallInfo } from './_shared'

/**
 * Deploy Packs over the REST API:
 *   read (rollback): GET   /api/v1/m/<group>/packs                                → find live by id
 *   install:         POST  /api/v1/m/<group>/packs                                { id, source, spec, ... }
 *   upgrade:         PATCH /api/v1/m/<group>/packs/<id>?source=..&spec=..&disabled=..
 *
 * The pack id is the stable identity used to upsert. rollbackData records,
 * per pack, whether it already existed and — for an upgrade — its prior
 * `source` + exact resolved `version` (used to pin an exact downgrade, not the
 * looser original `spec`). Live lists are read once per Worker Group.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) return { success: false, message: 'Missing credential for Packs deployment' }

  const previous: Array<{ id: string; group: string; existed: boolean; priorSource: string | null; priorVersion: string | null }> = []
  const applied: string[] = []
  const liveByGroup = new Map<string, PackInstallInfo[]>()

  try {
    const { base, headers } = await connectFor({ component, credential, connectivity, connectivityProvider, settings })

    for (const item of items) {
      const spec = buildPackSpec(item.fields)
      if (!spec.id) continue
      if (spec.error || !spec.body) {
        return { success: false, message: `Pack ${spec.id}: ${spec.error ?? 'invalid configuration'}`, artifacts: { applied }, rollbackData: { previous } }
      }

      const group = groupOf(item.fields, settings ?? {})
      if (!liveByGroup.has(group)) liveByGroup.set(group, await listPacks(base, headers, group))
      const live = liveByGroup.get(group)!
      const existing = findPack(live, spec.id)

      if (existing) {
        const query = upgradeQuery({
          source: String(spec.body.source ?? ''),
          spec: String(spec.body.spec ?? ''),
          disabled: Boolean(spec.body.disabled),
        })
        await sendJson('PATCH', `${groupResourcePath(base, group, 'packs')}/${encodeURIComponent(spec.id)}${query}`, headers)
        previous.push({ id: spec.id, group, existed: true, priorSource: existing.source ?? null, priorVersion: existing.version ?? null })
      } else {
        await sendJson('POST', groupResourcePath(base, group, 'packs'), headers, spec.body)
        previous.push({ id: spec.id, group, existed: false, priorSource: null, priorVersion: null })
      }
      applied.push(group ? `${group}/${spec.id}` : spec.id)
    }

    return {
      success: true,
      message: `Applied ${applied.length} pack(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Pack deploy failed after ${applied.length} pack(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
