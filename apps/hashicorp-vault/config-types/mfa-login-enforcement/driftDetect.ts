import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildVaultClient } from '../../lib/vault'
import { getEnforcement } from './deploy'
import { extractEnforcementSpecs } from './validate'

/**
 * Detect drift between the deployed login-MFA enforcement configuration and the
 * live cluster. Re-reads each enforcement from GET
 * /identity/mfa/login-enforcement/{name} and diffs ONLY the authored fields
 * (compared as sets — order is not significant):
 *
 *   - mfa_method_ids         → critical (the methods a login must satisfy — a
 *                              mismatch changes WHAT MFA is required)
 *   - auth_method_types      → warning
 *   - auth_method_accessors  → warning
 *   - identity_group_ids     → warning
 *   - identity_entity_ids    → warning
 *
 * Server-computed fields (id, namespace_id, name) are excluded. There are no
 * write-only/secret fields on an enforcement.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildVaultClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractEnforcementSpecs(ctx.deployedConfig).filter((s) => s.name && s.mfaMethodIds.length > 0)

  for (const spec of specs) {
    try {
      const live = await getEnforcement(client, spec.name)

      if (!live) {
        diffs.push({ field: spec.name, expected: 'present', actual: 'missing', severity: 'critical' })
        continue
      }

      // mfa_method_ids — the methods required; a mismatch changes what MFA applies.
      compareSet(diffs, `${spec.name}.mfa_method_ids`, spec.mfaMethodIds, live.mfa_method_ids, 'critical')

      // selectors — which logins the enforcement covers.
      compareSet(diffs, `${spec.name}.auth_method_types`, spec.authMethodTypes, live.auth_method_types, 'warning')
      compareSet(
        diffs,
        `${spec.name}.auth_method_accessors`,
        spec.authMethodAccessors,
        live.auth_method_accessors,
        'warning',
      )
      compareSet(diffs, `${spec.name}.identity_group_ids`, spec.identityGroupIds, live.identity_group_ids, 'warning')
      compareSet(diffs, `${spec.name}.identity_entity_ids`, spec.identityEntityIds, live.identity_entity_ids, 'warning')
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

/** Compare an authored id list to the live one as SETS (order-insensitive), pushing a diff on mismatch. */
function compareSet(
  diffs: DriftDiff[],
  field: string,
  expected: string[],
  liveRaw: string[] | undefined,
  severity: DriftDiff['severity'],
): void {
  const live = liveRaw ?? []
  const expectedSet = new Set(expected)
  const liveSet = new Set(live)
  const same = expectedSet.size === liveSet.size && [...expectedSet].every((v) => liveSet.has(v))
  if (!same) {
    diffs.push({
      field,
      expected: expected.length ? [...expectedSet].sort().join(', ') : 'none',
      actual: live.length ? [...liveSet].sort().join(', ') : 'none',
      severity,
    })
  }
}
