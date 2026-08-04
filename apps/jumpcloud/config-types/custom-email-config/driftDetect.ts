import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildJumpCloudClient } from '../../lib/jumpcloudApi'
import { getCustomEmailByType } from './deploy'
import { extractCustomEmailSpecs } from './_shared'

const COMPARED_FIELDS = ['subject', 'title', 'header', 'body', 'button', 'nextStepContactInfo'] as const

/**
 * Detect drift between the deployed Custom Email overrides and the live org.
 * Re-fetches each declared override by type and diffs every managed field.
 * Best-effort: if the org can't be read the check reports no drift rather than
 * raising a false positive.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildJumpCloudClient(ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const specs = extractCustomEmailSpecs(ctx.deployedConfig).filter((s) => s.type)

  for (const spec of specs) {
    let live
    try {
      live = await getCustomEmailByType(client, spec.type)
    } catch {
      continue // best-effort — skip what we can't read
    }
    if (!live) {
      diffs.push({ field: spec.type, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }

    for (const field of COMPARED_FIELDS) {
      const liveValue = String(live[field] ?? '')
      const desiredValue = spec[field]
      if (liveValue !== desiredValue) {
        diffs.push({ field: `${spec.type}.${field}`, expected: desiredValue, actual: liveValue, severity: 'info' })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
