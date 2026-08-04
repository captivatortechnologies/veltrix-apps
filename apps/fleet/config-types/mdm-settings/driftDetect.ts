import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildFleetUrl, buildAuthHeader } from '../../lib/fleetApi'
import { parseScope, getMdm } from './_shared'

function yesNo(value: unknown): boolean {
  return String(value ?? '').trim().toLowerCase() === 'yes'
}

/**
 * Drift for MDM settings: per declared scope, compare disk-encryption/
 * BitLocker-PIN toggles, OS update minimum-version+deadline pairs and the
 * setup-experience IdP-auth toggle against the live `mdm` block. Best-effort —
 * a scope that can't be read is skipped rather than raising false drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const base = buildFleetUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  for (const item of items) {
    const scope = parseScope(item.fields.teamId)
    const scopeLabel = scope.teamId === undefined ? 'global' : `team ${scope.teamId}`
    const live = await getMdm(base, headers, scope)
    const fields = item.fields

    const check = (field: string, expected: unknown, actual: unknown) => {
      if (actual !== undefined && actual !== expected) diffs.push({ field: `${scopeLabel}.${field}`, expected, actual, severity: 'warning' })
    }

    check('enable_disk_encryption', yesNo(fields.enableDiskEncryption), live.enable_disk_encryption)
    check('windows_require_bitlocker_pin', yesNo(fields.windowsRequireBitlockerPin), live.windows_require_bitlocker_pin)

    const setupExperience = live.setup_experience as Record<string, unknown> | undefined
    check('setup_experience.enable_end_user_authentication', yesNo(fields.enableEndUserAuthentication), setupExperience?.enable_end_user_authentication)

    if (scope.teamId === undefined) {
      check('enable_recovery_lock_password', yesNo(fields.enableRecoveryLockPassword), live.enable_recovery_lock_password)
      check('apple_require_hardware_attestation', yesNo(fields.appleRequireHardwareAttestation), live.apple_require_hardware_attestation)
      check('windows_enabled_and_configured', yesNo(fields.windowsEnabledAndConfigured), live.windows_enabled_and_configured)
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
