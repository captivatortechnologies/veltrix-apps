import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildPPClient } from '../../lib/proofpoint'
import { extractExemptionSpecs, getExemptions, senderKey } from './validate'

/**
 * Detect drift between the deployed email-tagging exemptions and the live org.
 * Each declared exempt sender that is no longer present is critical drift
 * (someone removed a managed exemption, exposing that sender to tagging again).
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildPPClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractExemptionSpecs(ctx.deployedConfig).filter((s) => s.sender)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const current = await getExemptions(client)
    const currentKeys = new Set(current.map(senderKey))

    for (const spec of specs) {
      if (!currentKeys.has(senderKey(spec.sender))) {
        diffs.push({ field: spec.sender, expected: 'exempt', actual: 'not exempt', severity: 'critical' })
      }
    }
  } catch (error) {
    diffs.push({
      field: 'proofpoint',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
