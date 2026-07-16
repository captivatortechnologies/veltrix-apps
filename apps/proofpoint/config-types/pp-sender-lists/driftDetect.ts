import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildPPClient } from '../../lib/proofpoint'
import { extractSenderSpecs, getOrg, readSenderList, senderKey } from './validate'

/**
 * Detect drift between the deployed sender-list configuration and the live org.
 * Each declared entry that is no longer present in its target list is critical
 * drift (someone removed a managed safe/blocked sender).
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildPPClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractSenderSpecs(ctx.deployedConfig).filter((s) => s.sender)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const org = await getOrg(client)
    const safeKeys = new Set(readSenderList(org, 'safe').map(senderKey))
    const blockedKeys = new Set(readSenderList(org, 'blocked').map(senderKey))

    for (const spec of specs) {
      const set = spec.listType === 'blocked' ? blockedKeys : safeKeys
      if (!set.has(senderKey(spec.sender))) {
        diffs.push({ field: `${spec.listType}:${spec.sender}`, expected: 'present', actual: 'missing', severity: 'critical' })
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
