import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildDatadogClient } from '../../lib/datadogApi'
import { listArchives, readArchive } from './deploy'
import { extractArchiveSpecs, findArchiveByName, parseJsonObject, type ArchiveResource } from './_shared'

/**
 * Detect drift between the deployed Log Archive configuration and the live
 * organization: query, destination (whole-object compare) and
 * rehydration_tags.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const built = buildDatadogClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built

  const specs = extractArchiveSpecs(ctx.deployedConfig).filter((s) => s.name && s.query)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  let live: ArchiveResource[]
  try {
    live = await listArchives(client)
  } catch (error) {
    return {
      hasDrift: true,
      diffs: [{ field: 'datadog', expected: 'reachable', actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`, severity: 'critical' }],
    }
  }

  const diffs: DriftDiff[] = []

  for (const spec of specs) {
    const label = spec.name
    const found = findArchiveByName(live, spec.name)
    if (!found || !found.id) {
      diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }

    let full: ArchiveResource
    try {
      full = await readArchive(client, found.id)
    } catch (error) {
      diffs.push({ field: label, expected: 'readable', actual: `unreadable: ${error instanceof Error ? error.message : 'unknown'}`, severity: 'warning' })
      continue
    }
    const attrs = full.attributes ?? {}

    if (spec.query !== (attrs.query ?? '')) {
      diffs.push({ field: `${label}.query`, expected: spec.query, actual: attrs.query ?? 'not set', severity: 'warning' })
    }

    const destination = parseJsonObject(spec.destinationRaw)
    const declaredDestination = destination.ok ? (destination.value ?? {}) : {}
    if (JSON.stringify(declaredDestination) !== JSON.stringify(attrs.destination ?? {})) {
      diffs.push({
        field: `${label}.destination`,
        expected: JSON.stringify(declaredDestination),
        actual: JSON.stringify(attrs.destination ?? {}),
        severity: 'warning',
      })
    }

    const liveTags = Array.isArray(attrs.rehydration_tags) ? [...attrs.rehydration_tags].sort() : []
    const declaredTags = [...spec.rehydrationTags].sort()
    if (JSON.stringify(declaredTags) !== JSON.stringify(liveTags)) {
      diffs.push({ field: `${label}.rehydration_tags`, expected: spec.rehydrationTags, actual: attrs.rehydration_tags ?? [], severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
