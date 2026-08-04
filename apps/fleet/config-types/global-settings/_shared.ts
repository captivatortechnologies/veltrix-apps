// Shared helpers for the Fleet global-settings config type (deploy +
// driftDetect). Manages a bounded, non-secret slice of the org config
// singleton (PATCH /api/v1/fleet/config) — org_info, server_settings,
// features, host/activity expiry, webhook_settings, fleet_desktop.
//
// Fleet's config PATCH does not document partial merging WITHIN a submitted
// top-level section, so deploy reads the CURRENT config first and merges
// declared fields on top of it before submitting each owned section in full —
// this preserves any field within a section that this canvas doesn't expose,
// rather than nulling it out. Verify against a live Fleet (fleetdm) instance.
import { getJson, FLEET_API_BASE } from '../../lib/fleetApi'

/** The subset of Fleet's org config this config type owns. */
export interface OwnedSections {
  org_info?: Record<string, unknown>
  server_settings?: Record<string, unknown>
  features?: Record<string, unknown>
  host_expiry_settings?: Record<string, unknown>
  activity_expiry_settings?: Record<string, unknown>
  webhook_settings?: Record<string, unknown>
  fleet_desktop?: Record<string, unknown>
}

export async function getFleetConfig(base: string, headers: Record<string, string>): Promise<OwnedSections | null> {
  try {
    return await getJson<OwnedSections>(`${base}${FLEET_API_BASE}/config`, headers)
  } catch {
    return null
  }
}

/** Pull out just the sections this config type owns (for a rollback snapshot). */
export function extractOwnedSections(config: OwnedSections | null): OwnedSections {
  if (!config) return {}
  const { org_info, server_settings, features, host_expiry_settings, activity_expiry_settings, webhook_settings, fleet_desktop } = config
  return { org_info, server_settings, features, host_expiry_settings, activity_expiry_settings, webhook_settings, fleet_desktop }
}

function yesNo(value: unknown, fallback: boolean): boolean {
  const s = String(value ?? '').trim().toLowerCase()
  if (!s) return fallback
  return s === 'yes' || s === 'true'
}

function num(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

/**
 * Merge the canvas item's declared fields on top of the CURRENT config's owned
 * sections, producing the full body to PATCH. Fields left blank on the canvas
 * fall back to whatever the current config already has (never null it out),
 * except booleans/numbers with an explicit canvas default, which always win.
 */
export function buildPatchBody(current: OwnedSections, fields: Record<string, unknown>): OwnedSections {
  const c = current

  const org_info = {
    ...c.org_info,
    ...(fields.orgName !== undefined && String(fields.orgName).trim() ? { org_name: String(fields.orgName).trim() } : {}),
    ...(fields.orgLogoUrlDarkMode !== undefined && String(fields.orgLogoUrlDarkMode).trim()
      ? { org_logo_url_dark_mode: String(fields.orgLogoUrlDarkMode).trim() }
      : {}),
    ...(fields.orgLogoUrlLightMode !== undefined && String(fields.orgLogoUrlLightMode).trim()
      ? { org_logo_url_light_mode: String(fields.orgLogoUrlLightMode).trim() }
      : {}),
    ...(fields.contactUrl !== undefined && String(fields.contactUrl).trim() ? { contact_url: String(fields.contactUrl).trim() } : {}),
  }

  const server_settings = {
    ...c.server_settings,
    ...(String(fields.serverUrl ?? '').trim() ? { server_url: String(fields.serverUrl).trim() } : {}),
    enable_analytics: yesNo(fields.enableAnalytics, Boolean((c.server_settings as Record<string, unknown> | undefined)?.enable_analytics ?? true)),
    ai_features_disabled: yesNo(fields.aiFeaturesDisabled, Boolean((c.server_settings as Record<string, unknown> | undefined)?.ai_features_disabled ?? false)),
  }

  const features = {
    ...c.features,
    enable_host_users: yesNo(fields.enableHostUsers, Boolean((c.features as Record<string, unknown> | undefined)?.enable_host_users ?? true)),
    enable_software_inventory: yesNo(
      fields.enableSoftwareInventory,
      Boolean((c.features as Record<string, unknown> | undefined)?.enable_software_inventory ?? true),
    ),
  }

  const host_expiry_settings = {
    host_expiry_enabled: yesNo(fields.hostExpiryEnabled, false),
    host_expiry_window: num(fields.hostExpiryWindowDays, 30),
  }

  const activity_expiry_settings = {
    ...c.activity_expiry_settings,
    activity_expiry_enabled: yesNo(fields.activityExpiryEnabled, false),
    activity_expiry_window: num(fields.activityExpiryWindowDays, 90),
  }

  const webhook_settings = {
    host_status_webhook: {
      enable_host_status_webhook: yesNo(fields.hostStatusWebhookEnabled, false),
      destination_url: String(fields.hostStatusWebhookUrl ?? '').trim(),
      host_percentage: num(fields.hostStatusWebhookPercentage, 5),
      days_count: num(fields.hostStatusWebhookDaysCount, 7),
    },
    failing_policies_webhook: {
      enable_failing_policies_webhook: yesNo(fields.failingPoliciesWebhookEnabled, false),
      destination_url: String(fields.failingPoliciesWebhookUrl ?? '').trim(),
      host_batch_size: num(fields.failingPoliciesWebhookBatchSize, 0),
    },
    vulnerabilities_webhook: {
      enable_vulnerabilities_webhook: yesNo(fields.vulnerabilitiesWebhookEnabled, false),
      destination_url: String(fields.vulnerabilitiesWebhookUrl ?? '').trim(),
      host_batch_size: num(fields.vulnerabilitiesWebhookBatchSize, 0),
    },
    activities_webhook: {
      enable_activities_webhook: yesNo(fields.activitiesWebhookEnabled, false),
      destination_url: String(fields.activitiesWebhookUrl ?? '').trim(),
    },
  }

  const fleet_desktop = {
    ...c.fleet_desktop,
    ...(String(fields.transparencyUrl ?? '').trim() ? { transparency_url: String(fields.transparencyUrl).trim() } : {}),
    ...(String(fields.alternativeBrowserHost ?? '').trim() ? { alternative_browser_host: String(fields.alternativeBrowserHost).trim() } : {}),
  }

  return { org_info, server_settings, features, host_expiry_settings, activity_expiry_settings, webhook_settings, fleet_desktop }
}
