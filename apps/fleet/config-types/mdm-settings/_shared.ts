// Shared helpers for the Fleet mdm-settings config type (deploy + driftDetect).
// One item = one scope: the org-wide default (PATCH /api/v1/fleet/config,
// `mdm` block) or a single team's override (PATCH /api/v1/fleet/fleets/{id},
// `mdm` block — a Fleet Premium feature; the per-team `mdm` schema is a subset
// of the global one, so global-only fields are ignored for a team scope).
import { getJson, sendJson, FLEET_API_BASE } from '../../lib/fleetApi'

export interface MdmScope {
  teamId: number | undefined // undefined = global/org-wide
}

/** "global" or a team id text field → the scope this item configures. */
export function parseScope(value: unknown): MdmScope {
  const raw = String(value ?? '').trim().toLowerCase()
  if (!raw || raw === 'global') return { teamId: undefined }
  const n = Number(raw)
  return { teamId: Number.isFinite(n) ? n : undefined }
}

function yesNo(value: unknown, fallback = false): boolean {
  const s = String(value ?? '').trim().toLowerCase()
  if (!s) return fallback
  return s === 'yes' || s === 'true'
}

function dateRange(minVersion: unknown, deadline: unknown): Record<string, unknown> | undefined {
  const minimum_version = String(minVersion ?? '').trim()
  const deadlineStr = String(deadline ?? '').trim()
  if (!minimum_version && !deadlineStr) return undefined
  return { minimum_version, deadline: deadlineStr }
}

/** GET the live `mdm` block for a scope (best-effort — {} on failure). */
export async function getMdm(base: string, headers: Record<string, string>, scope: MdmScope): Promise<Record<string, unknown>> {
  try {
    if (scope.teamId === undefined) {
      const config = await getJson<{ mdm?: Record<string, unknown> }>(`${base}${FLEET_API_BASE}/config`, headers)
      return config.mdm ?? {}
    }
    const res = await getJson<{ team?: { mdm?: Record<string, unknown> } }>(`${base}${FLEET_API_BASE}/fleets/${scope.teamId}`, headers)
    return res.team?.mdm ?? {}
  } catch {
    return {}
  }
}

/** PATCH the `mdm` block for a scope. */
export async function setMdm(
  base: string,
  headers: Record<string, string>,
  scope: MdmScope,
  mdm: Record<string, unknown>,
): Promise<void> {
  if (scope.teamId === undefined) {
    await sendJson('PATCH', `${base}${FLEET_API_BASE}/config`, headers, { mdm })
    return
  }
  await sendJson('PATCH', `${base}${FLEET_API_BASE}/fleets/${scope.teamId}`, headers, { mdm })
}

/**
 * Merge declared fields on top of the current `mdm` block. Global-only fields
 * (recovery lock, hardware attestation, Windows MDM toggle, macOS migration)
 * are only applied when scope.teamId is undefined (global) — the per-team
 * schema doesn't accept them, so sending them to a team PATCH would either be
 * ignored or rejected depending on the Fleet version.
 */
export function buildMdmPatch(current: Record<string, unknown>, fields: Record<string, unknown>, scope: MdmScope): Record<string, unknown> {
  const patch: Record<string, unknown> = {
    ...current,
    enable_disk_encryption: yesNo(fields.enableDiskEncryption, Boolean(current.enable_disk_encryption)),
    windows_require_bitlocker_pin: yesNo(fields.windowsRequireBitlockerPin, Boolean(current.windows_require_bitlocker_pin)),
    setup_experience: {
      ...(current.setup_experience as Record<string, unknown> | undefined),
      enable_end_user_authentication: yesNo(
        fields.enableEndUserAuthentication,
        Boolean((current.setup_experience as Record<string, unknown> | undefined)?.enable_end_user_authentication),
      ),
    },
  }

  const macos = dateRange(fields.macosMinVersion, fields.macosDeadline)
  if (macos) patch.macos_updates = macos
  const ios = dateRange(fields.iosMinVersion, fields.iosDeadline)
  if (ios) patch.ios_updates = ios
  const ipados = dateRange(fields.ipadosMinVersion, fields.ipadosDeadline)
  if (ipados) patch.ipados_updates = ipados

  if (fields.windowsDeadlineDays !== undefined || fields.windowsGracePeriodDays !== undefined) {
    patch.windows_updates = {
      deadline_days: Number(fields.windowsDeadlineDays) || 0,
      grace_period_days: Number(fields.windowsGracePeriodDays) || 0,
    }
  }

  if (scope.teamId === undefined) {
    patch.enable_recovery_lock_password = yesNo(fields.enableRecoveryLockPassword, Boolean(current.enable_recovery_lock_password))
    patch.apple_require_hardware_attestation = yesNo(
      fields.appleRequireHardwareAttestation,
      Boolean(current.apple_require_hardware_attestation),
    )
    patch.windows_enabled_and_configured = yesNo(fields.windowsEnabledAndConfigured, Boolean(current.windows_enabled_and_configured))
    if (yesNo(fields.macosMigrationEnabled, false)) {
      patch.macos_migration = {
        enable: true,
        mode: String(fields.macosMigrationMode ?? 'voluntary').trim() || 'voluntary',
        webhook_url: String(fields.macosMigrationWebhookUrl ?? '').trim(),
      }
    } else if (current.macos_migration) {
      patch.macos_migration = { ...(current.macos_migration as Record<string, unknown>), enable: false }
    }
  }

  return patch
}
