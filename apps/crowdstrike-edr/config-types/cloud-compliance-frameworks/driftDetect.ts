import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient } from '../../lib/falcon'
import { attachDriftActor, veltrixActorLogins } from '../lib/crowdstrikeAudit'
import { findFrameworkByName } from './frameworkApi'
import { extractFrameworkSpecs, type FrameworkSpec, type LiveFramework } from './validate'

/**
 * Detect drift between the deployed compliance framework configuration and the
 * live tenant state. Looks up each declared framework and diffs the managed
 * fields (description) plus the expected version when one is declared.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  // Connection identity our own deploys are recorded under — excluded so
  // attribution reflects the MANUAL change, not a Veltrix deploy.
  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  const specs = extractFrameworkSpecs(ctx.deployedConfig).filter((s) => s.name)

  for (const spec of specs) {
    const label = spec.name
    const before = diffs.length
    try {
      const live = await findFrameworkByName(client, spec.name)

      if (!live) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      diffs.push(...diffFramework(spec, live))

      // Attribute every diff this framework produced to Falcon's recorded last
      // modifier (best-effort — the framework entity carries no modifier fields
      // today, so this is a no-op until the API surfaces one).
      attachDriftActor(diffs.slice(before), live, { excludeActorLogins })
    } catch (error) {
      diffs.push({
        field: label,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

function diffFramework(spec: FrameworkSpec, live: LiveFramework): DriftDiff[] {
  const diffs: DriftDiff[] = []
  const label = spec.name

  const liveDescription = typeof live.description === 'string' ? live.description : ''
  const specDescription = spec.description ?? ''
  if (liveDescription !== specDescription) {
    diffs.push({
      field: `${label}.description`,
      expected: specDescription || 'none',
      actual: liveDescription || 'none',
      severity: 'warning',
    })
  }

  // Version is server-managed; only compare when the config declares one.
  if (spec.version) {
    const liveVersion = typeof live.version === 'string' ? live.version : ''
    if (liveVersion !== spec.version) {
      diffs.push({
        field: `${label}.version`,
        expected: spec.version,
        actual: liveVersion || 'none',
        severity: 'warning',
      })
    }
  }

  return diffs
}
