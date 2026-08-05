import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildTinesClient } from '../../lib/tinesApi'
import { extractFolderSpecs, findFolder, findFolderByName } from './_shared'
import { listFolders } from './deploy'

/**
 * Detect drift between the deployed folders configuration and the live Tines
 * tenant. Re-finds each declared folder scoped by (team, content type,
 * parent, name): a missing folder is CRITICAL drift. Best-effort — an
 * unreadable scope raises no false drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildTinesClient(ctx.component?.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const specs = extractFolderSpecs(ctx.deployedConfig).filter((s) => s.name && s.teamId && s.contentType)
  if (specs.length === 0) return { hasDrift: false, diffs }

  const cache = new Map<string, Awaited<ReturnType<typeof listFolders>>>()
  for (const spec of specs) {
    const key = `${spec.teamId}::${spec.contentType}`
    let live = cache.get(key)
    if (!live) {
      try {
        live = await listFolders(client, spec.teamId, spec.contentType)
        cache.set(key, live)
      } catch {
        continue // best-effort: can't read this scope, no drift asserted for it
      }
    }

    const parent = spec.parentFolderName ? findFolderByName(live, spec.teamId, spec.contentType, spec.parentFolderName) : null
    const parentId = spec.parentFolderName ? (parent?.id !== undefined ? String(parent.id) : '__unresolved__') : null
    const match = findFolder(live, spec, parentId)
    if (!match) {
      diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
