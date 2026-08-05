import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildSophosClient } from '../../lib/sophosCentral'
import { createScanningExclusion, listScanningExclusions, updateScanningExclusion, type SophosScanningExclusion } from '../../lib/sophosApi'
import { buildScanningExclusionBody, extractScanningExclusionSpecs, scanningExclusionKey, scanningExclusionMatches } from './_shared'

export interface ScanningExclusionRollbackEntry {
  key: string
  action: 'created' | 'patched' | 'unchanged'
  id?: string
  prior?: { scanMode?: string; comment?: string }
}

/**
 * Deploy Sophos Central scanning exclusions, reconciled by (type, value):
 *   create: POST  /settings/exclusions/scanning                     when no live exclusion matches
 *   patch:  PATCH /settings/exclusions/scanning/{id}                 when scanMode/comment differ
 *   no-op:  nothing                                                   when the live exclusion already matches
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildSophosClient(ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const specs = extractScanningExclusionSpecs(ctx.canvas).filter((s) => s.type && s.value)
  const previous: ScanningExclusionRollbackEntry[] = []
  const deployed: string[] = []

  try {
    const live = await listScanningExclusions(client)
    const liveByKey = new Map(live.map((e) => [scanningExclusionKey(e.type, e.value), e] as const))

    for (const spec of specs) {
      const key = scanningExclusionKey(spec.type, spec.value)
      const match: SophosScanningExclusion | undefined = liveByKey.get(key)
      const label = `${spec.type}:${spec.value}`

      if (!match) {
        const created = await createScanningExclusion(client, buildScanningExclusionBody(spec))
        previous.push({ key, action: 'created', id: created.id })
      } else if (scanningExclusionMatches(spec, match)) {
        previous.push({ key, action: 'unchanged' })
      } else {
        if (match.id) {
          await updateScanningExclusion(client, match.id, { scanMode: spec.scanMode || undefined, comment: spec.comment })
        }
        previous.push({ key, action: 'patched', id: match.id, prior: { scanMode: match.scanMode, comment: match.comment } })
      }
      deployed.push(label)
    }

    return {
      success: true,
      message: `Applied ${deployed.length} scanning exclusion(s): ${deployed.join(', ') || '(none)'}`,
      artifacts: { deployed },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Scanning exclusion deploy failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { deployed },
      rollbackData: { previous },
    }
  }
}
