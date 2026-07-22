import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildTenableClient } from '../../lib/tenable'
import { attachDriftActor, veltrixActorLogins } from '../lib/tenableAudit'
import { findScannerGroup } from './deploy'
import { extractScannerGroupSpecs } from './validate'

/**
 * Detect drift between the deployed scanner group configuration and the live
 * tenant state. Looks up each declared group by name.
 *
 * A scanner group's only managed field is its name, which is also its logical
 * identity — so there is nothing further to diff once a group is found. If a
 * group was renamed or deleted in Tenable it no longer resolves by name and is
 * reported as missing (the meaningful drift for this config type). Membership
 * and pool type are not managed here and are deliberately not compared.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildTenableClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractScannerGroupSpecs(ctx.deployedConfig).filter((s) => s.name)
  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  for (const spec of specs) {
    const before = diffs.length
    try {
      const live = await findScannerGroup(client, spec.name)
      if (!live) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        await attachDriftActor(client, diffs.slice(before), { targetName: spec.name, excludeActorLogins })
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
