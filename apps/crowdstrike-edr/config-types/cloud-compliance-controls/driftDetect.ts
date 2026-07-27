import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient, sameSet, type FalconClient } from '../../lib/falcon'
import { attachDriftActor, veltrixActorLogins } from '../lib/crowdstrikeAudit'
import { controlFramework, findControl, readAssignedRuleIds, ruleReadCoords } from './controlApi'
import { extractControlSpecs, type ControlSpec, type LiveControl } from './validate'

/**
 * Detect drift between the deployed compliance control configuration and the
 * live tenant state. Looks up each declared control and diffs its description,
 * section and parent framework, plus its assigned rule IDs (read from the Cloud
 * Security rules collection, since the control entity does not carry them).
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

  const specs = extractControlSpecs(ctx.deployedConfig).filter((s) => s.name && s.frameworkId && s.section)

  for (const spec of specs) {
    const label = `${spec.name} (${spec.section})`
    const before = diffs.length
    try {
      const live = await findControl(client, {
        name: spec.name,
        frameworkId: spec.frameworkId,
        section: spec.section,
      })

      if (!live) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      diffs.push(...(await diffControl(client, spec, live)))

      // Attribute every diff this control produced to Falcon's recorded last
      // modifier (best-effort — the control entity carries no modifier fields
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

async function diffControl(
  client: FalconClient,
  spec: ControlSpec,
  live: LiveControl,
): Promise<DriftDiff[]> {
  const diffs: DriftDiff[] = []
  const label = `${spec.name}`

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

  const liveSection = typeof live.section_name === 'string' ? live.section_name : ''
  if (liveSection !== spec.section) {
    diffs.push({
      field: `${label}.section`,
      expected: spec.section,
      actual: liveSection || 'none',
      severity: 'critical',
    })
  }

  const liveFrameworkUuid = controlFramework(live)?.uuid ?? ''
  if (liveFrameworkUuid !== spec.frameworkId) {
    diffs.push({
      field: `${label}.frameworkId`,
      expected: spec.frameworkId,
      actual: liveFrameworkUuid || 'none',
      severity: 'critical',
    })
  }

  // Assigned rule IDs — read from the rules collection and compare sets.
  const liveRuleIds = await readAssignedRuleIds(client, ruleReadCoords(live))
  if (!sameSet(liveRuleIds, spec.ruleIds)) {
    diffs.push({
      field: `${label}.ruleIds`,
      expected: spec.ruleIds.join(', ') || 'none',
      actual: liveRuleIds.join(', ') || 'none',
      severity: 'warning',
    })
  }

  return diffs
}
