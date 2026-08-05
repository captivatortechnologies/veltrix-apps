import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildTeleportClient } from '../../lib/teleport'
import { normalizeResourceYaml } from '../../lib/resourceYaml'
import { getGithubConnector } from './deploy'
import { extractGithubConnectorSpecs, buildGithubConnectorYaml } from './validate'

/**
 * Detect drift between the deployed GitHub connector configuration and live
 * Teleport state. Re-reads each declared connector by name and compares the
 * full resource YAML, normalized (comments stripped, whitespace collapsed) so
 * a cosmetic re-serialization does not read as drift. The comparison
 * transiently includes client_secret in memory (see lib/teleport.ts) — never
 * logged or persisted beyond the diff.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildTeleportClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractGithubConnectorSpecs(ctx.deployedConfig).filter((s) => s.name && s.spec)

  for (const spec of specs) {
    try {
      const live = await getGithubConnector(client, spec.name)

      if (!live) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      const expected = normalizeResourceYaml(buildGithubConnectorYaml(spec))
      const actual = normalizeResourceYaml(live.content ?? '')
      if (expected !== actual) {
        diffs.push({ field: `${spec.name}.spec`, expected, actual, severity: 'critical' })
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
