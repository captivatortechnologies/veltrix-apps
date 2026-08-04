import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildCyberArkClient } from '../../lib/cyberark'
import { mapReferrers } from './deploy'
import { extractAllowedReferrerSpecs, referrerKey } from './validate'

/**
 * Detect drift between the deployed allowed-referrer configuration and the
 * live PVWA. A missing entry is critical drift; a "regularExpression"
 * mismatch on an existing entry is reported informationally only — there is
 * no verified update endpoint for it (see deploy.ts).
 *
 * Allowed referrers carry no creator/modifier metadata over this API, so
 * diffs are reported without an actor.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildCyberArkClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractAllowedReferrerSpecs(ctx.deployedConfig).filter((s) => s.referrerUrl)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const byKey = await mapReferrers(client)

    for (const spec of specs) {
      const found = byKey.get(referrerKey(spec))
      if (!found) {
        diffs.push({ field: spec.referrerUrl, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }
      const liveRegex = found.regularExpression === true || found.regularExpression === 'true'
      if (liveRegex !== spec.regularExpression) {
        diffs.push({
          field: `${spec.referrerUrl}.regular_expression (not auto-correctable — no update endpoint)`,
          expected: spec.regularExpression,
          actual: liveRegex,
          severity: 'info',
        })
      }
    }
  } catch (error) {
    diffs.push({
      field: 'cyberark',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  await client.logoff()
  return { hasDrift: diffs.length > 0, diffs }
}
