// =============================================================================
// Shared helpers for the GravityZone Notification Settings config type.
//
// An account always exists — there is no create/delete, only update — so
// this config type is reconciled by accountId (blank = the account that
// generated the API key) and only ever calls
// accounts.configureNotificationsSettings. Only fields the canvas declares
// are managed; an undeclared field means "leave this field alone", not
// "clear it".
// =============================================================================

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'
import { canonicalJson, coerceBoolean, parseJsonArray, readOptionalNumber, sameSet, splitList, str } from '../../lib/gravityZoneCommon'
import type { GzConfigureNotificationsBody, GzNotificationsSettings } from '../../lib/gravityZoneApi'

export interface NotificationSettingsSpec {
  itemName: string
  accountId: string
  deleteAfter: number | undefined
  emailAddresses: string[]
  emailAddressesDeclared: boolean
  includeDeviceFQDN: boolean | undefined
  includeDeviceFQDNDeclared: boolean
  includeDeviceName: boolean | undefined
  includeDeviceNameDeclared: boolean
  sendOnlyPlainTextEmail: boolean | undefined
  sendOnlyPlainTextEmailDeclared: boolean
  notificationsSettingsRaw: string
}

/** The declaration's logical identity: its accountId (blank = the API key's own account). */
export function notificationSettingsKey(accountId: string): string {
  return accountId.trim().toLowerCase()
}

function declaredBoolean(raw: unknown): { value: boolean | undefined; declared: boolean } {
  const declared = raw !== undefined && raw !== ''
  return { value: declared ? coerceBoolean(raw, false) : undefined, declared }
}

export function extractNotificationSettingsSpecs(canvas: CanvasSnapshot): NotificationSettingsSpec[] {
  return (canvas.items ?? canvas.sections ?? []).map((item) => {
    const fields = item.fields ?? {}
    const fqdn = declaredBoolean(fields.includeDeviceFQDN)
    const deviceName = declaredBoolean(fields.includeDeviceName)
    const plainText = declaredBoolean(fields.sendOnlyPlainTextEmail)
    const emailAddresses = splitList(fields.emailAddresses)
    return {
      itemName: item.name,
      accountId: str(fields.accountId),
      deleteAfter: readOptionalNumber(fields.deleteAfter),
      emailAddresses,
      emailAddressesDeclared: emailAddresses.length > 0,
      includeDeviceFQDN: fqdn.value,
      includeDeviceFQDNDeclared: fqdn.declared,
      includeDeviceName: deviceName.value,
      includeDeviceNameDeclared: deviceName.declared,
      sendOnlyPlainTextEmail: plainText.value,
      sendOnlyPlainTextEmailDeclared: plainText.declared,
      notificationsSettingsRaw: str(fields.notificationsSettings),
    }
  })
}

export function parseNotificationsSettings(spec: NotificationSettingsSpec): { value: unknown[] | null; error: string | null } {
  return parseJsonArray(spec.notificationsSettingsRaw, `Notification settings "${spec.accountId || '(own)'}" Notification Types`)
}

/** Build the partial update body from only the fields the canvas declared. */
export function buildNotificationSettingsBody(spec: NotificationSettingsSpec, notificationsSettings: unknown[] | null): GzConfigureNotificationsBody {
  const body: GzConfigureNotificationsBody = {}
  if (spec.accountId) body.accountId = spec.accountId
  if (spec.deleteAfter !== undefined) body.deleteAfter = spec.deleteAfter
  if (spec.emailAddressesDeclared) body.emailAddresses = spec.emailAddresses
  if (spec.includeDeviceFQDNDeclared) body.includeDeviceFQDN = spec.includeDeviceFQDN
  if (spec.includeDeviceNameDeclared) body.includeDeviceName = spec.includeDeviceName
  if (spec.sendOnlyPlainTextEmailDeclared) body.sendOnlyPlainTextEmail = spec.sendOnlyPlainTextEmail
  if (spec.notificationsSettingsRaw && notificationsSettings) body.notificationsSettings = notificationsSettings as Array<Record<string, unknown>>
  return body
}

/** The live values for every field this spec declares — for drift comparison and rollback capture. */
export function declaredLiveSnapshot(spec: NotificationSettingsSpec, live: GzNotificationsSettings): GzConfigureNotificationsBody {
  const snap: GzConfigureNotificationsBody = {}
  if (spec.deleteAfter !== undefined) snap.deleteAfter = live.deleteAfter
  if (spec.emailAddressesDeclared) snap.emailAddresses = Array.isArray(live.emailAddresses) ? live.emailAddresses : []
  if (spec.includeDeviceFQDNDeclared) snap.includeDeviceFQDN = live.includeDeviceFQDN
  if (spec.includeDeviceNameDeclared) snap.includeDeviceName = live.includeDeviceName
  if (spec.sendOnlyPlainTextEmailDeclared) snap.sendOnlyPlainTextEmail = live.sendOnlyPlainTextEmail
  if (spec.notificationsSettingsRaw) snap.notificationsSettings = Array.isArray(live.notificationsSettings) ? live.notificationsSettings : []
  return snap
}

/** Does every field this spec declares already match the live account's notification settings? */
export function notificationSettingsMatch(spec: NotificationSettingsSpec, notificationsSettings: unknown[] | null, live: GzNotificationsSettings): boolean {
  if (spec.deleteAfter !== undefined && live.deleteAfter !== spec.deleteAfter) return false
  if (spec.emailAddressesDeclared && !sameSet(spec.emailAddresses, Array.isArray(live.emailAddresses) ? live.emailAddresses.map(String) : [])) return false
  if (spec.includeDeviceFQDNDeclared && Boolean(live.includeDeviceFQDN) !== spec.includeDeviceFQDN) return false
  if (spec.includeDeviceNameDeclared && Boolean(live.includeDeviceName) !== spec.includeDeviceName) return false
  if (spec.sendOnlyPlainTextEmailDeclared && Boolean(live.sendOnlyPlainTextEmail) !== spec.sendOnlyPlainTextEmail) return false
  if (spec.notificationsSettingsRaw && canonicalJson(live.notificationsSettings ?? []) !== canonicalJson(notificationsSettings ?? [])) return false
  return true
}
