import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildSecretServerClient } from '../../lib/secretServerApi'
import {
  extractFolderSpecs,
  searchFolders,
  resolveParentFolderId,
  findFolderByNameAndParent,
  normalizeBool,
} from './_shared'

/**
 * Drift for folders: for each declared folder, re-find it by name within its
 * parent and compare the managed inheritance flags. A folder that can't be found
 * is critical drift. Best-effort — an unresolved parent is skipped, and a read
 * error asserts no drift rather than raising a false critical. Read-only:
 * GET /api/v1/folders.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildSecretServerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const items = ctx.deployedConfig.items ?? ctx.deployedConfig.sections ?? []
  const specs = extractFolderSpecs(items).filter((s) => s.folderName)
  if (specs.length === 0) return { hasDrift: false, diffs }

  try {
    for (const spec of specs) {
      const parent = await resolveParentFolderId(client, spec.parentFolderName)
      if (parent.id === null) continue // best-effort: parent unresolved, skip

      const siblings = await searchFolders(client, spec.folderName)
      const match = findFolderByNameAndParent(siblings, spec.folderName, parent.id)
      if (!match) {
        diffs.push({ field: spec.folderName, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      if (match.inheritPermissions !== undefined && normalizeBool(match.inheritPermissions) !== spec.inheritPermissions) {
        diffs.push({
          field: `${spec.folderName}.inheritPermissions`,
          expected: spec.inheritPermissions,
          actual: normalizeBool(match.inheritPermissions),
          severity: 'warning',
        })
      }
      if (match.inheritSecretPolicy !== undefined && normalizeBool(match.inheritSecretPolicy) !== spec.inheritSecretPolicy) {
        diffs.push({
          field: `${spec.folderName}.inheritSecretPolicy`,
          expected: spec.inheritSecretPolicy,
          actual: normalizeBool(match.inheritSecretPolicy),
          severity: 'warning',
        })
      }
    }
  } catch {
    return { hasDrift: false, diffs } // best-effort: unreadable → no drift asserted
  }

  return { hasDrift: diffs.length > 0, diffs }
}
