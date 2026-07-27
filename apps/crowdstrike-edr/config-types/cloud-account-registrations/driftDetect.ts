import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient } from '../../lib/falcon'
import { attachDriftActor, veltrixActorLogins } from '../lib/crowdstrikeAudit'
import { findAccount } from './deploy'
import { accountIdentity, extractAccountSpecs, type AccountSpec, type LiveAccount } from './validate'

/**
 * Detect drift between the deployed cloud account registrations and the live
 * Falcon Cloud Security state. Looks up each declared account and diffs the
 * managed fields (capability flags, account type, role/region, default sub).
 *
 * Attribution is best-effort: CSPM account resources are not verified to carry
 * a modifier field, so drifted diffs are usually reported without an actor.
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

  const specs = extractAccountSpecs(ctx.deployedConfig).filter(
    (s) => s.cloudProvider.length > 0 && accountIdentity(s).length > 0,
  )

  for (const spec of specs) {
    const label = `${spec.cloudProvider}:${accountIdentity(spec)}`
    const before = diffs.length
    try {
      const live = await findAccount(client, spec.cloudProvider, accountIdentity(spec))

      if (!live) {
        diffs.push({ field: label, expected: 'registered', actual: 'not registered', severity: 'critical' })
        continue
      }

      diffs.push(...diffAccount(spec, live, label))
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

function diffAccount(spec: AccountSpec, live: LiveAccount, label: string): DriftDiff[] {
  const diffs: DriftDiff[] = []

  if ((live.account_type ?? '') !== spec.accountType) {
    diffs.push({
      field: `${label}.accountType`,
      expected: spec.accountType,
      actual: live.account_type ?? 'not set',
      severity: 'warning',
    })
  }

  // Capability flags decide what Falcon assesses — a disabled feature that
  // should be on leaves the account under-protected.
  diffs.push(
    ...flagDiff(label, 'behaviorAssessment', spec.behaviorAssessmentEnabled, live.behavior_assessment_enabled),
    ...flagDiff(label, 'sensorManagement', spec.sensorManagementEnabled, live.sensor_management_enabled),
    ...flagDiff(label, 'dspm', spec.dspmEnabled, live.dspm_enabled),
  )

  if (spec.cloudProvider === 'aws') {
    if (spec.iamRoleArn && (live.iam_role_arn ?? '') !== spec.iamRoleArn) {
      diffs.push({
        field: `${label}.iamRoleArn`,
        expected: spec.iamRoleArn,
        actual: live.iam_role_arn ?? 'not set',
        severity: 'critical',
      })
    }
    if (spec.regions[0] && (live.cloudtrail_region ?? '') !== spec.regions[0]) {
      diffs.push({
        field: `${label}.cloudtrailRegion`,
        expected: spec.regions[0],
        actual: live.cloudtrail_region ?? 'not set',
        severity: 'warning',
      })
    }
  } else if (spec.cloudProvider === 'azure') {
    if ((live.default_subscription === true) !== spec.defaultSubscription) {
      diffs.push({
        field: `${label}.defaultSubscription`,
        expected: spec.defaultSubscription,
        actual: live.default_subscription === true,
        severity: 'warning',
      })
    }
  }

  return diffs
}

/** One capability flag comparison — a feature that should be on but is off is critical. */
function flagDiff(label: string, name: string, expected: boolean, live: boolean | undefined): DriftDiff[] {
  const actual = live === true
  if (actual === expected) return []
  return [
    {
      field: `${label}.${name}Enabled`,
      expected,
      actual,
      severity: expected && !actual ? 'critical' : 'warning',
    },
  ]
}
