import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildAkeylessClient } from '../../lib/akeyless'
import { listRotatedSecrets } from './deploy'
import { extractRotatedSecretSpecs } from './validate'

/**
 * Detect drift for rotated secret configs - EXISTENCE + ACTIVE STATE ONLY.
 *
 * Akeyless has no "get rotated-secret configuration" endpoint (only
 * /rotated-secret-list, which returns id/name/type/active - never the
 * rotation settings themselves - and /rotated-secret-get-value, which
 * returns the rotated credential VALUE and is out of scope for this app).
 * Field-level drift (rotation interval, target association, auth mode,
 * etc.) genuinely cannot be verified without reading secret material, so
 * this is intentionally not attempted rather than faked. See canvas.yaml.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildAkeylessClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built

  const specs = extractRotatedSecretSpecs(ctx.deployedConfig).filter((s) => s.name && s.type)

  let live
  try {
    live = await listRotatedSecrets(client)
  } catch (error) {
    return {
      hasDrift: true,
      diffs: [
        {
          field: 'akeyless-account',
          expected: 'reachable',
          actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
          severity: 'critical',
        },
      ],
    }
  }

  const liveByName = new Map(live.map((p) => [p.name, p]))
  for (const spec of specs) {
    const producer = liveByName.get(spec.name)
    if (!producer) {
      diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }
    if (producer.active === false) {
      diffs.push({ field: `${spec.name}.active`, expected: 'true', actual: 'false', severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
