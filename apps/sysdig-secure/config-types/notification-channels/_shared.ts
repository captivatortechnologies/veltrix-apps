// Shared helpers for the Sysdig Secure Notification Channels config type
// (validate + deploy + rollback + drift).
//
// Channel shape follows the Sysdig Secure /api/notificationChannels API
// (confirmed against terraform-provider-sysdig's v2 client). Verify against a
// live Sysdig Secure.

import { NOTIFICATION_CHANNEL_TYPES, type NotificationChannelOptions, type SysdigNotificationChannel } from '../../lib/sysdigApi'

export { NOTIFICATION_CHANNEL_TYPES }

/** The canvas fields for one notification-channel item. */
export interface ChannelFields {
  name?: unknown
  type?: unknown
  enabled?: unknown
  url?: unknown
  channel?: unknown
  isPrivateChannel?: unknown
  privateChannelUrl?: unknown
  templateVersion?: unknown
  emailRecipients?: unknown
  snsTopicArns?: unknown
  account?: unknown
  serviceKey?: unknown
  region?: unknown
  apiKey?: unknown
  routingKey?: unknown
  teamId?: unknown
  includeAdminUsers?: unknown
  allowInsecureConnections?: unknown
  additionalHeaders?: unknown
  sendTestNotification?: unknown
}

/** `enabled`/checkbox-ish values may arrive as booleans or common truthy strings. */
export function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === undefined || value === null || value === '') return fallback
  const s = String(value).trim().toLowerCase()
  if (s === 'false' || s === '0' || s === 'no') return false
  if (s === 'true' || s === '1' || s === 'yes') return true
  return fallback
}

/** Split a comma/newline separated value (or array) into trimmed strings. */
export function splitList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean)
  if (typeof value === 'string') {
    return value
      .split(/[,\n]/)
      .map((v) => v.trim())
      .filter(Boolean)
  }
  return []
}

/** A `keyvalue` canvas field arrives as a plain object; coerce loosely. */
function asHeaders(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  return undefined
}

/** Build the type-specific `options` bag from canvas fields. */
export function buildOptions(fields: ChannelFields): NotificationChannelOptions {
  const type = String(fields.type ?? '').trim()
  const options: NotificationChannelOptions = {
    notifyOnOk: false,
    notifyOnResolve: false,
    sendTestNotification: normalizeBoolean(fields.sendTestNotification, false),
  }

  switch (type) {
    case 'EMAIL':
      options.emailRecipients = splitList(fields.emailRecipients)
      break
    case 'SLACK':
      options.url = String(fields.url ?? '').trim()
      options.channel = String(fields.channel ?? '').trim()
      options.privateChannel = normalizeBoolean(fields.isPrivateChannel, false)
      if (options.privateChannel) options.privateChannelUrl = String(fields.privateChannelUrl ?? '').trim()
      break
    case 'WEBHOOK':
    case 'PROMETHEUS_ALERT_MANAGER':
      options.url = String(fields.url ?? '').trim()
      options.allowInsecureConnections = normalizeBoolean(fields.allowInsecureConnections, false)
      { const headers = asHeaders(fields.additionalHeaders); if (headers) options.additionalHeaders = headers }
      break
    case 'PAGER_DUTY':
      options.account = String(fields.account ?? '').trim()
      options.serviceKey = String(fields.serviceKey ?? '').trim()
      break
    case 'OPSGENIE':
      options.url = String(fields.url ?? '').trim()
      options.region = String(fields.region ?? 'US').trim()
      break
    case 'MS_TEAMS':
      options.url = String(fields.url ?? '').trim()
      break
    case 'SNS':
      options.snsTopicARNs = splitList(fields.snsTopicArns)
      break
    case 'VICTOROPS':
      options.apiKey = String(fields.apiKey ?? '').trim()
      options.routingKey = String(fields.routingKey ?? '').trim()
      break
    case 'TEAM_EMAIL': {
      const teamId = Number(fields.teamId)
      if (Number.isFinite(teamId)) options.teamId = teamId
      options.includeAdminUsers = normalizeBoolean(fields.includeAdminUsers, false)
      break
    }
    default:
      break
  }

  if (type === 'SLACK' || type === 'MS_TEAMS') {
    const version = String(fields.templateVersion ?? 'v2').trim() === 'v1' ? 'v1' : 'v2'
    const key = type === 'SLACK' ? `SLACK_SECURE_EVENT_NOTIFICATION_TEMPLATE_METADATA_${version}` : `MS_TEAMS_SECURE_EVENT_NOTIFICATION_TEMPLATE_METADATA_${version}`
    options.templateConfiguration = [{ templateKey: key, templateConfigurationSections: [] }]
  }

  return options
}

/**
 * Build the Sysdig notification-channel body from canvas fields. `teamId` is
 * left unset so the channel is shared with all teams (Sysdig's default) — this
 * app has no reliable source for "the calling token's own team id" to support
 * a team-scoped channel.
 */
export function buildChannelBody(fields: ChannelFields): SysdigNotificationChannel {
  return {
    name: String(fields.name ?? '').trim(),
    type: String(fields.type ?? '').trim(),
    enabled: normalizeBoolean(fields.enabled, true),
    options: buildOptions(fields),
  }
}

/** Find a live notification channel by exact name. */
export function findChannelByName(channels: SysdigNotificationChannel[], name: string): SysdigNotificationChannel | null {
  const n = name.trim()
  if (!n) return null
  return channels.find((c) => String(c.name ?? '').trim() === n) ?? null
}
