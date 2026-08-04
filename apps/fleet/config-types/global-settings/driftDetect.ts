import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildFleetUrl, buildAuthHeader } from '../../lib/fleetApi'
import { getFleetConfig } from './_shared'

function yesNo(value: unknown): boolean {
  return String(value ?? '').trim().toLowerCase() === 'yes'
}

/**
 * Drift for global settings: compare each field this config type manages
 * against the live config. Only the specific sub-keys this type owns are
 * checked — other fields within the same top-level section (left untouched by
 * deploy's read-merge-write) are not compared. Best-effort — a config that
 * can't be read is skipped rather than raising false drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const item = items[0]
  if (!item) return { hasDrift: false, diffs }
  const fields = item.fields

  const base = buildFleetUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const live = await getFleetConfig(base, headers)
  if (!live) return { hasDrift: false, diffs }

  const check = (field: string, expected: unknown, actual: unknown) => {
    if (actual !== undefined && actual !== expected) diffs.push({ field, expected, actual, severity: 'warning' })
  }

  const server = live.server_settings as Record<string, unknown> | undefined
  check('server_settings.enable_analytics', yesNo(fields.enableAnalytics), server?.enable_analytics)
  check('server_settings.ai_features_disabled', yesNo(fields.aiFeaturesDisabled), server?.ai_features_disabled)

  const features = live.features as Record<string, unknown> | undefined
  check('features.enable_host_users', yesNo(fields.enableHostUsers), features?.enable_host_users)
  check('features.enable_software_inventory', yesNo(fields.enableSoftwareInventory), features?.enable_software_inventory)

  const hostExpiry = live.host_expiry_settings as Record<string, unknown> | undefined
  check('host_expiry_settings.host_expiry_enabled', yesNo(fields.hostExpiryEnabled), hostExpiry?.host_expiry_enabled)

  const activityExpiry = live.activity_expiry_settings as Record<string, unknown> | undefined
  check('activity_expiry_settings.activity_expiry_enabled', yesNo(fields.activityExpiryEnabled), activityExpiry?.activity_expiry_enabled)

  const webhooks = live.webhook_settings as Record<string, Record<string, unknown>> | undefined
  check(
    'webhook_settings.host_status_webhook.enable_host_status_webhook',
    yesNo(fields.hostStatusWebhookEnabled),
    webhooks?.host_status_webhook?.enable_host_status_webhook,
  )
  check(
    'webhook_settings.failing_policies_webhook.enable_failing_policies_webhook',
    yesNo(fields.failingPoliciesWebhookEnabled),
    webhooks?.failing_policies_webhook?.enable_failing_policies_webhook,
  )
  check(
    'webhook_settings.vulnerabilities_webhook.enable_vulnerabilities_webhook',
    yesNo(fields.vulnerabilitiesWebhookEnabled),
    webhooks?.vulnerabilities_webhook?.enable_vulnerabilities_webhook,
  )
  check(
    'webhook_settings.activities_webhook.enable_activities_webhook',
    yesNo(fields.activitiesWebhookEnabled),
    webhooks?.activities_webhook?.enable_activities_webhook,
  )

  return { hasDrift: diffs.length > 0, diffs }
}
