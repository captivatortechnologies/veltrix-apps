import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildPPClient } from '../../lib/proofpoint'
import { extractAuthSettingsSpec, getLoginSettings, getMfaSettings } from './validate'

/**
 * Detect drift between the deployed Authentication Settings and the live org:
 * re-reads the MFA and Login settings and diffs every declared field.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildPPClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const sections = ctx.deployedConfig.sections ?? []
  if (sections.length === 0) return { hasDrift: false, diffs: [] }
  const spec = extractAuthSettingsSpec(ctx.deployedConfig)

  try {
    const mfa = await getMfaSettings(client)
    if (mfa.is_mfa_enabled !== spec.isMfaEnabled) {
      diffs.push({ field: 'is_mfa_enabled', expected: spec.isMfaEnabled, actual: mfa.is_mfa_enabled, severity: 'warning' })
    }
    if (mfa.mfa_admins_only !== spec.mfaAdminsOnly) {
      diffs.push({ field: 'mfa_admins_only', expected: spec.mfaAdminsOnly, actual: mfa.mfa_admins_only, severity: 'info' })
    }

    const login = await getLoginSettings(client)
    if (login.allow_local_login !== spec.allowLocalLogin) {
      diffs.push({ field: 'allow_local_login', expected: spec.allowLocalLogin, actual: login.allow_local_login, severity: 'warning' })
    }
    if (login.allow_azure_login !== spec.allowAzureLogin) {
      diffs.push({ field: 'allow_azure_login', expected: spec.allowAzureLogin, actual: login.allow_azure_login, severity: 'warning' })
    }
    if (login.force_azure_login !== spec.forceAzureLogin) {
      diffs.push({ field: 'force_azure_login', expected: spec.forceAzureLogin, actual: login.force_azure_login, severity: 'warning' })
    }
    const expectedIdp = spec.idpForForcedLogin || null
    if ((login.idp_for_forced_login ?? null) !== expectedIdp) {
      diffs.push({ field: 'idp_for_forced_login', expected: expectedIdp ?? 'not set', actual: login.idp_for_forced_login ?? 'not set', severity: 'warning' })
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
