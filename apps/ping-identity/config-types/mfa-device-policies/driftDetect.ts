import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildPingOneClient, stableStringify } from '../../lib/pingOne'
import { buildPolicyBody, findPolicyByName } from './deploy'
import { extractPolicySpecs } from './validate'

/**
 * Detect drift between the deployed MFA device policy configuration and the
 * live PingOne environment. Each declared policy is re-found by name and its
 * meaningful fields are compared: `default`, `newDeviceNotification`,
 * `authentication.deviceSelection`, `ignoreUserLock`, and each channel's
 * `enabled` + OTP sub-fields (via a stable-key JSON compare, so field order
 * never reads as drift). Server-managed readOnly fields (id, environment,
 * updatedAt, _links, forSignOnPolicy) are never modeled so they cannot read
 * as drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildPingOneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractPolicySpecs(ctx.deployedConfig).filter((s) => s.name)

  for (const spec of specs) {
    try {
      const live = await findPolicyByName(client, spec.name)

      if (!live) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      const expected = buildPolicyBody(spec)

      compareScalar(diffs, `${spec.name}.default`, spec.default, live.default ?? false)
      compareScalar(
        diffs,
        `${spec.name}.newDeviceNotification`,
        spec.newDeviceNotification,
        live.newDeviceNotification ?? 'NONE',
      )
      compareScalar(
        diffs,
        `${spec.name}.authentication.deviceSelection`,
        spec.deviceSelection,
        live.authentication?.deviceSelection ?? 'DEFAULT_TO_FIRST',
      )
      compareScalar(diffs, `${spec.name}.ignoreUserLock`, spec.ignoreUserLock, live.ignoreUserLock ?? false)

      for (const channel of ['sms', 'voice', 'email', 'totp', 'mobile'] as const) {
        compareStable(diffs, `${spec.name}.${channel}`, expected[channel], live[channel])
      }

      // fido2 is optional - only compared when this policy configured it.
      if ('fido2' in expected) {
        compareStable(diffs, `${spec.name}.fido2`, expected.fido2, live.fido2)
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

function compareScalar(diffs: DriftDiff[], field: string, expected: unknown, actual: unknown): void {
  if (expected !== actual) {
    diffs.push({ field, expected, actual, severity: 'critical' })
  }
}

function compareStable(diffs: DriftDiff[], field: string, expected: unknown, actual: unknown): void {
  if (stableStringify(expected ?? null) !== stableStringify(actual ?? null)) {
    diffs.push({ field, expected: expected ?? 'not set', actual: actual ?? 'not set', severity: 'critical' })
  }
}
