import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildFmcClient } from '../../lib/fmc'
import { buildUrlObjectIndex, resolveRefs } from '../../lib/fmcRefs'
import { extractUrlGroupSpecs, URL_GROUPS_PATH } from './validate'

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const specs = extractUrlGroupSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  const built = buildFmcClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built

  const [listed, index] = await Promise.all([client.list(URL_GROUPS_PATH), buildUrlObjectIndex(client)])
  if (!listed.ok) {
    return {
      hasDrift: true,
      diffs: [{ field: 'url-groups', expected: 'reachable', actual: `list failed (HTTP ${listed.status})`, severity: 'critical' }],
    }
  }

  const byName = new Map(listed.items.map((item) => [(item.name ?? '').toLowerCase(), item]))
  const diffs: DriftDiff[] = []

  for (const spec of specs) {
    const live = byName.get(spec.name.toLowerCase())
    if (!live) {
      diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }

    const { resolved, missing } = resolveRefs(index, spec.urlObjectNames)
    if (missing.length > 0) {
      diffs.push({
        field: `${spec.name}.url_object_names`,
        expected: `all ${spec.urlObjectNames.length} member(s) resolvable`,
        actual: `${missing.length} unresolved: ${missing.join(', ')}`,
        severity: 'warning',
      })
    }

    const expectedObjectIds = resolved.map((r) => r.id).sort()
    const liveObjects = Array.isArray(live.objects) ? (live.objects as Array<{ id?: string }>) : []
    const liveObjectIds = liveObjects.map((o) => o.id).filter((id): id is string => typeof id === 'string').sort()
    if (JSON.stringify(expectedObjectIds) !== JSON.stringify(liveObjectIds)) {
      diffs.push({
        field: `${spec.name}.url_object_names`,
        expected: `${expectedObjectIds.length} object member(s)`,
        actual: `${liveObjectIds.length} object member(s)`,
        severity: 'info',
      })
    }

    const expectedLiterals = [...spec.literalUrls].sort()
    const liveLiterals = Array.isArray(live.literals) ? (live.literals as Array<{ url?: string }>) : []
    const liveLiteralUrls = liveLiterals.map((l) => l.url).filter((u): u is string => typeof u === 'string').sort()
    if (JSON.stringify(expectedLiterals) !== JSON.stringify(liveLiteralUrls)) {
      diffs.push({
        field: `${spec.name}.literal_urls`,
        expected: `${expectedLiterals.length} literal URL(s)`,
        actual: `${liveLiteralUrls.length} literal URL(s)`,
        severity: 'info',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
