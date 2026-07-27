import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient, sameSet } from '../../lib/falcon'
import { exclusionGroupIds, findExclusion, type LiveExclusion } from '../../lib/exclusionAdapter'
import { attachDriftActor, veltrixActorLogins } from '../lib/crowdstrikeAudit'
import { exclusionActorResource, liveString } from '../ml-exclusions/exclusionShared'
import { IOA_EXCLUSION_ENDPOINTS } from './deploy'
import { extractIoaExclusionSpecs, type IoaExclusionSpec } from './validate'

/**
 * Detect drift between the deployed IOA exclusion configuration and the live
 * tenant state. Looks up each declared exclusion and diffs the managed fields.
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

  const specs = extractIoaExclusionSpecs(ctx.deployedConfig).filter((s) => s.name)

  for (const spec of specs) {
    const label = spec.name
    const before = diffs.length
    try {
      const live = await findExclusion(client, IOA_EXCLUSION_ENDPOINTS, spec.name)

      if (!live) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      diffs.push(...diffIoaExclusion(spec, live))

      // Attribute every diff this exclusion produced to Falcon's recorded last
      // modifier (once) — no-op when nothing drifted or the change was ours.
      attachDriftActor(diffs.slice(before), exclusionActorResource(live), { excludeActorLogins })
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

function diffIoaExclusion(spec: IoaExclusionSpec, live: LiveExclusion): DriftDiff[] {
  const diffs: DriftDiff[] = []
  const label = spec.name

  // pattern id decides which behavior is suppressed — the most consequential field
  const livePattern = liveString(live.pattern_id)
  if (livePattern !== spec.patternId) {
    diffs.push({
      field: `${label}.patternId`,
      expected: spec.patternId,
      actual: livePattern || 'not set',
      severity: 'critical',
    })
  }

  const liveCl = liveString(live.cl_regex)
  if (liveCl !== spec.clRegex) {
    diffs.push({
      field: `${label}.clRegex`,
      expected: spec.clRegex,
      actual: liveCl || 'not set',
      severity: 'warning',
    })
  }

  const liveIfn = liveString(live.ifn_regex)
  if (liveIfn !== spec.ifnRegex) {
    diffs.push({
      field: `${label}.ifnRegex`,
      expected: spec.ifnRegex,
      actual: liveIfn || 'not set',
      severity: 'warning',
    })
  }

  const liveGlobal = live.applied_globally === true
  if (liveGlobal !== spec.appliedGlobally) {
    diffs.push({
      field: `${label}.appliedGlobally`,
      expected: spec.appliedGlobally,
      actual: liveGlobal,
      severity: 'critical',
    })
  } else if (!spec.appliedGlobally && !sameSet(exclusionGroupIds(live), spec.hostGroups)) {
    diffs.push({
      field: `${label}.hostGroups`,
      expected: spec.hostGroups.join(', '),
      actual: exclusionGroupIds(live).join(', ') || 'none',
      severity: 'warning',
    })
  }

  return diffs
}
