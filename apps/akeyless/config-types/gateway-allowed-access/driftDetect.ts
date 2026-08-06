import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildAkeylessClient, stableStringify } from '../../lib/akeyless'
import { getAllowedAccess, mapLiveToSpec } from './deploy'
import { extractAllowedAccessSpecs } from './validate'

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildAkeylessClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built

  const specs = extractAllowedAccessSpecs(ctx.deployedConfig).filter((s) => s.name && s.accessId)

  for (const spec of specs) {
    let live
    try {
      live = await getAllowedAccess(client, spec.name)
    } catch (error) {
      diffs.push({
        field: spec.name,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
      continue
    }

    if (!live) {
      diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }

    if (live.access_id && live.access_id !== spec.accessId) {
      diffs.push({ field: `${spec.name}.accessId`, expected: spec.accessId, actual: live.access_id, severity: 'critical' })
    }

    const liveSpec = mapLiveToSpec(spec, live)
    for (const key of ['description', 'permissions', 'subClaims', 'caseSensitive'] as const) {
      const expected = stableStringify(spec[key])
      const actual = stableStringify(liveSpec[key])
      if (expected !== actual) {
        diffs.push({
          field: `${spec.name}.${key}`,
          expected: describeValue(spec[key]),
          actual: describeValue(liveSpec[key]),
          severity: 'warning',
        })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

function describeValue(value: unknown): string {
  if (Array.isArray(value)) return value.length ? value.join(', ') : '(none)'
  if (value && typeof value === 'object') return JSON.stringify(value)
  if (value === '' || value === undefined || value === null) return '(none)'
  return String(value)
}
