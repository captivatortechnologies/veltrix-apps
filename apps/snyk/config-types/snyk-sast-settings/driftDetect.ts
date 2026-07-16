import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildSnykClient } from '../../lib/snyk'
import { readSastSettings } from './deploy'
import { extractSastSettings } from './validate'

/**
 * Detect drift between the deployed SAST settings and the live org: compare the
 * live sast_enabled to the deployed value.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildSnykClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built
  if (!client.hasOrg) return { hasDrift: false, diffs: [] }

  const spec = extractSastSettings(ctx.deployedConfig)

  try {
    const live = await readSastSettings(client)
    const liveEnabled = live?.sast_enabled ?? false
    if (liveEnabled !== spec.sastEnabled) {
      diffs.push({
        field: 'sast_enabled',
        expected: String(spec.sastEnabled),
        actual: String(liveEnabled),
        severity: 'warning',
      })
    }
  } catch (error) {
    diffs.push({
      field: 'snyk',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
