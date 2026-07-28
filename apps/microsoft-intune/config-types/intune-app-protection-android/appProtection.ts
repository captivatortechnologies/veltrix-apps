// =============================================================================
// Intune Android app protection (MAM) — Graph androidManagedAppProtection model.
//
// An app protection policy is a single-platform MAM policy: it carries the base
// managedAppProtection scalars (PIN, data-transfer/clipboard controls, save-as,
// device compliance, minimum OS) PLUS the Android-only encryption/screen-capture
// toggles, then binds its managed apps via a SEPARATE targetApps action and its
// inclusion/exclusion groups via the SEPARATE assign action (never inline).
//
// Canvas field keys are kept IDENTICAL to the Graph property names so extract /
// deploy / drift / rollback all key off one MANAGED_FIELDS list (DRY). Property
// names, per-property types and every enum value are verified against Microsoft
// Learn (androidManagedAppProtection, beta), which the shared IntuneClient targets.
// =============================================================================

import { buildAssignments, readAssignments, type AssignmentSpec } from '../../lib/assignments'
import { buildTargetApps, readTargetedAppIds, type AppGroupType } from '../../lib/targetApps'

/** The @odata.type discriminator for an Android MAM app protection policy. */
export const ANDROID_APP_PROTECTION_ODATA_TYPE = '#microsoft.graph.androidManagedAppProtection'

/** The Graph collection that holds Android app protection policies. */
export const ANDROID_APP_PROTECTION_PATH = '/deviceAppManagement/androidManagedAppProtections'

/** managedAppDataTransferLevel enum (inbound sources / outbound destinations). */
export const DATA_TRANSFER_LEVELS = ['allApps', 'managedApps', 'none'] as const

/** managedAppClipboardSharingLevel enum. */
export const CLIPBOARD_SHARING_LEVELS = ['allApps', 'managedAppsWithPasteIn', 'managedApps', 'blocked'] as const

/** targetedManagedAppGroupType enum (which public apps the policy targets). */
export const APP_GROUP_TYPES: readonly AppGroupType[] = [
  'selectedPublicApps',
  'allApps',
  'allMicrosoftApps',
  'allCoreMicrosoftApps',
]

type FieldKind = 'checkbox' | 'number' | 'string' | 'enum'

/** One managed policy setting: its canvas key (== Graph property) + how to read it. */
export interface ManagedField {
  key: string
  kind: FieldKind
  label: string
  min?: number
  max?: number
  options?: readonly string[]
}

/**
 * The managed scalar policy fields, in canvas order. A checkbox is ALWAYS sent
 * (a definite boolean); a number/string/enum is sent only when configured. Ranges
 * follow the Intune admin center (PIN length 4-16) and Graph (maximumPinRetries
 * 1-65535).
 */
export const MANAGED_FIELDS: ManagedField[] = [
  { key: 'pinRequired', kind: 'checkbox', label: 'Require app PIN' },
  { key: 'minimumPinLength', kind: 'number', label: 'Minimum PIN length', min: 4, max: 16 },
  { key: 'maximumPinRetries', kind: 'number', label: 'Maximum PIN attempts', min: 1, max: 65535 },
  { key: 'allowedInboundDataTransferSources', kind: 'enum', label: 'Allowed inbound data sources', options: DATA_TRANSFER_LEVELS },
  { key: 'allowedOutboundDataTransferDestinations', kind: 'enum', label: 'Allowed outbound data destinations', options: DATA_TRANSFER_LEVELS },
  { key: 'allowedOutboundClipboardSharingLevel', kind: 'enum', label: 'Clipboard sharing level', options: CLIPBOARD_SHARING_LEVELS },
  { key: 'saveAsBlocked', kind: 'checkbox', label: 'Block "Save As"' },
  { key: 'screenCaptureBlocked', kind: 'checkbox', label: 'Block screen capture' },
  { key: 'encryptAppData', kind: 'checkbox', label: 'Encrypt app data' },
  { key: 'deviceComplianceRequired', kind: 'checkbox', label: 'Require device compliance' },
  { key: 'minimumRequiredOsVersion', kind: 'string', label: 'Minimum required OS version' },
]

/** A configured setting value, or undefined meaning "not configured / omit". */
export type ManagedValue = boolean | number | string | undefined

/** One canvas item = one Android app protection policy. */
export interface AndroidAppProtectionSpec {
  sectionName: string
  name: string
  description: string
  /** canvas field key → normalized value; undefined = not configured. Checkboxes are always boolean. */
  settings: Record<string, ManagedValue>
  appGroupType: AppGroupType
  /** Android package ids to target — only used when appGroupType is selectedPublicApps. */
  targetedApps: string[]
  assignment: AssignmentSpec
}

// --- Field value readers -----------------------------------------------------

/** A checkbox is a definite boolean: on when true/'true'/'on'/'yes'/'1'. */
export function readCheckbox(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const t = value.trim().toLowerCase()
    return t === 'true' || t === 'on' || t === 'yes' || t === '1'
  }
  return false
}

export function readNumberSetting(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value.trim())
    if (Number.isFinite(n)) return n
  }
  return undefined
}

export function readStringSetting(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const t = value.trim()
    if (t !== '') return t
  }
  return undefined
}

/** Read a tags/list field into a trimmed string array (accepts a comma/newline string too). */
export function readList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter((v) => v.length > 0)
  if (typeof value === 'string') return value.split(/[\n,]/).map((v) => v.trim()).filter((v) => v.length > 0)
  return []
}

/** Normalize the appGroupType select; defaults to selectedPublicApps. */
export function readAppGroupType(value: unknown): AppGroupType {
  if (typeof value === 'string') {
    const t = value.trim()
    if ((APP_GROUP_TYPES as readonly string[]).includes(t)) return t as AppGroupType
  }
  return 'selectedPublicApps'
}

/** Read every managed setting off a section's fields into a normalized map. */
export function readManagedSettings(fields: Record<string, unknown>): Record<string, ManagedValue> {
  const out: Record<string, ManagedValue> = {}
  for (const f of MANAGED_FIELDS) {
    const raw = fields[f.key]
    // Enum values are read raw (so validate can reject an unknown value) and only
    // guarded to a known option when the body is built.
    out[f.key] =
      f.kind === 'checkbox'
        ? readCheckbox(raw)
        : f.kind === 'number'
          ? readNumberSetting(raw)
          : readStringSetting(raw)
  }
  return out
}

/** Read the include/exclude groups + all-users flag for the assign action (MAM is user-scoped). */
export function readAssignmentSpec(fields: Record<string, unknown>): AssignmentSpec {
  return {
    includeGroupIds: readList(fields.includeGroups),
    excludeGroupIds: readList(fields.excludeGroups),
    allDevices: false,
    allUsers: readCheckbox(fields.allUsers),
  }
}

// hasAnyAssignment is defined once in lib/assignments (single source of truth).
export { hasAnyAssignment } from '../../lib/assignments'

// --- Body builders -----------------------------------------------------------

/**
 * Build a create/update body: the @odata.type discriminator, identity fields and
 * the managed scalars. Checkboxes are always sent; numbers/strings/enums only when
 * configured. Targeted apps and assignments are converged via their own actions.
 */
export function buildProtectionBody(spec: AndroidAppProtectionSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    '@odata.type': ANDROID_APP_PROTECTION_ODATA_TYPE,
    displayName: spec.name,
    description: spec.description,
    roleScopeTagIds: ['0'],
  }
  for (const f of MANAGED_FIELDS) {
    const value = spec.settings[f.key]
    if (f.kind === 'checkbox') body[f.key] = value === true
    else if (value === undefined) continue
    else if (f.kind === 'enum') {
      if (f.options && typeof value === 'string' && f.options.includes(value)) body[f.key] = value
    } else body[f.key] = value
  }
  return body
}

/** The targetApps action body for this policy (apps only sent for selectedPublicApps). */
export function buildTargetAppsBody(spec: AndroidAppProtectionSpec): ReturnType<typeof buildTargetApps> {
  return buildTargetApps({ platform: 'android', appIds: spec.targetedApps, appGroupType: spec.appGroupType })
}

/** The assign action body for this policy. */
export function buildAssignBody(spec: AndroidAppProtectionSpec): { assignments: ReturnType<typeof buildAssignments> } {
  return { assignments: buildAssignments(spec.assignment) }
}

// --- Live-policy reading (drift / rollback) ----------------------------------

/** An androidManagedAppProtection as returned by GET (scalar props addressed by name). */
export interface LiveAndroidAppProtection {
  id?: string
  '@odata.type'?: string
  displayName?: string
  description?: string
  roleScopeTagIds?: string[]
  appGroupType?: string
  apps?: Array<{ mobileAppIdentifier?: Record<string, unknown> }>
  assignments?: Array<{ target?: Record<string, unknown> }>
  [key: string]: unknown
}

/**
 * Capture the managed subset of a live policy (identity + every managed field it
 * carries, including explicit false/0 values Graph returns) so rollback can restore it.
 */
export function capturePriorFields(live: LiveAndroidAppProtection): Record<string, unknown> {
  const prior: Record<string, unknown> = {
    displayName: live.displayName ?? '',
    description: typeof live.description === 'string' ? live.description : '',
    roleScopeTagIds: Array.isArray(live.roleScopeTagIds) && live.roleScopeTagIds.length > 0 ? live.roleScopeTagIds : ['0'],
  }
  for (const f of MANAGED_FIELDS) {
    if (live[f.key] !== undefined) prior[f.key] = live[f.key]
  }
  return prior
}

/** Rebuild a restore PATCH body from captured prior fields (re-adds the @odata.type). */
export function buildRestoreBody(prior: Record<string, unknown>): Record<string, unknown> {
  return { '@odata.type': ANDROID_APP_PROTECTION_ODATA_TYPE, ...prior }
}

/** Read the targeted Android package ids off a live policy's expanded apps collection. */
export function readLiveTargetedApps(live: LiveAndroidAppProtection): string[] {
  return readTargetedAppIds('android', live.apps)
}

/** Read include/exclude groups + all-users off a live policy's expanded assignments. */
export function readLiveAssignment(live: LiveAndroidAppProtection): ReturnType<typeof readAssignments> {
  return readAssignments(live.assignments)
}

/** Re-export so deploy/rollback build assign/targetApps bodies without importing the libs twice. */
export { buildAssignments, buildTargetApps }
export type { AppGroupType }
