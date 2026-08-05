import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildTeleportClient } from '../../lib/teleport'
import { getDatabase } from './deploy'
import { extractDatabaseSpecs, type Label } from './validate'

function sortedLabels(labels: Label[]): string {
  return [...labels]
    .map((l) => `${l.name}=${l.value}`)
    .sort()
    .join(';')
}

/**
 * Detect drift between the deployed database configuration and live Teleport
 * state. Compares protocol, connection URI, and labels — the fields verified
 * to round-trip through lib/web/ui/server.go's `MakeDatabase`. AWS RDS
 * metadata and the CA certificate are write-only from this API's perspective
 * (not echoed back in a format this app can reliably read) and are not
 * drift-checked — see README.md's Coverage notes.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildTeleportClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractDatabaseSpecs(ctx.deployedConfig).filter((s) => s.name && s.protocol && s.uri)

  for (const spec of specs) {
    try {
      const live = await getDatabase(client, spec.name)

      if (!live) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      if (spec.protocol !== (live.protocol ?? '')) {
        diffs.push({ field: `${spec.name}.protocol`, expected: spec.protocol, actual: live.protocol ?? '', severity: 'critical' })
      }
      if (spec.uri !== (live.uri ?? '')) {
        diffs.push({ field: `${spec.name}.uri`, expected: spec.uri, actual: live.uri ?? '', severity: 'critical' })
      }

      const expectedLabels = sortedLabels(spec.labels)
      const actualLabels = sortedLabels(live.labels ?? [])
      if (expectedLabels !== actualLabels) {
        diffs.push({ field: `${spec.name}.labels`, expected: expectedLabels, actual: actualLabels, severity: 'warning' })
      }
    } catch (error) {
      diffs.push({
        field: spec.name,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
