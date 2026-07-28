import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient, sameSet } from '../../lib/falcon'
import { attachDriftActor, veltrixActorLogins } from '../lib/crowdstrikeAudit'
import { cidGroupIdOf, findCidGroup, getCidGroupMembers } from './deploy'
import { extractCidGroupSpecs } from './validate'

/**
 * Detect drift between the deployed MSSP CID group configuration and the live
 * tenant state. Each declared group is looked up by its `name` identity and its
 * description + member CID set are diffed. Attribution is best-effort — MSSP
 * entities may not carry a last-modifier field.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const excludeActorLogins = veltrixActorLogins(ctx.credential)
  const specs = extractCidGroupSpecs(ctx.deployedConfig).filter((s) => s.name)

  for (const spec of specs) {
    const before = diffs.length
    try {
      const live = await findCidGroup(client, spec.name)
      if (!live) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      if ((live.description ?? '') !== (spec.description ?? '')) {
        diffs.push({
          field: `${spec.name}.description`,
          expected: spec.description ?? 'not set',
          actual: live.description ?? 'not set',
          severity: 'info',
        })
      }

      const id = cidGroupIdOf(live)
      if (id) {
        const liveCids = await getCidGroupMembers(client, id)
        if (!sameSet(liveCids, spec.cids)) {
          diffs.push({
            field: `${spec.name}.cids`,
            expected: spec.cids.join(', ') || 'none',
            actual: liveCids.join(', ') || 'none',
            severity: 'warning',
          })
        }
      }

      attachDriftActor(diffs.slice(before), live, { excludeActorLogins })
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
