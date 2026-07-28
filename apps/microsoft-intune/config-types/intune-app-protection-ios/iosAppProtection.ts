// =============================================================================
// Intune iOS app protection (MAM) — Graph iosManagedAppProtection domain model.
//
// An iOS app protection policy is an iosManagedAppProtection under
// /deviceAppManagement. Its scalar settings (PIN, data-transfer / clipboard
// controls, "Save As", device-compliance requirement, minimum OS) are written on
// the create/PATCH body; the managed apps it protects and the groups it deploys
// to are bound by TWO SEPARATE actions after the policy exists:
//   POST .../{id}/targetApps  { appGroupType, apps:[{ mobileAppIdentifier … }] }
//   POST .../{id}/assign      { assignments:[{ target … }] }
// so appGroupType/targetedApps and the assignment groups are NEVER on the body.
// This module owns the canvas-key → Graph-property mapping and both action
// bodies so deploy/drift/rollback share one code path.
//
// Property names + enum members are verified against Microsoft Learn (beta
// iosManagedAppProtection); the shared IntuneClient targets Graph beta.
// =============================================================================

import { buildAssignments, readAssignments, type AssignmentSpec } from '../../lib/assignments'
import { buildTargetApps, readTargetedAppIds, type AppGroupType } from '../../lib/targetApps'

/** The @odata.type discriminator for an iOS app protection policy. */
export const IOS_MANAGED_APP_PROTECTION_ODATA_TYPE = '#microsoft.graph.iosManagedAppProtection'

/** managedAppDataTransferLevel (inbound sources / outbound destinations). */
export const DATA_TRANSFER_LEVELS = ['allApps', 'managedApps', 'none'] as const

/** managedAppClipboardSharingLevel (outbound clipboard). */
export const CLIPBOARD_SHARING_LEVELS = ['allApps', 'managedAppsWithPasteIn', 'managedApps', 'blocked'] as const

/** targetedManagedAppGroupType (which public apps the policy protects). */
export const APP_GROUP_TYPES: readonly AppGroupType[] = ['selectedPublicApps', 'allApps', 'allMicrosoftApps', 'allCoreMicrosoftApps']

type MamFieldType = 'bool' | 'number' | 'enum' | 'string'

interface MamFieldDef {
  /** Canvas field key — kept identical to the Graph property for a trivial mapping. */
  key: string
  label: string
  type: MamFieldType
  min?: number
  max?: number
  options?: readonly string[]
}

/**
 * The writable scalar fields this policy manages. The canvas key equals the Graph
 * property, so extract/deploy/drift all key off this one list (DRY). Ranges are
 * from the resource: maximumPinRetries is 1-65535, minimumPinLength is a positive
 * PIN length (no documented upper bound, so only a lower bound is enforced).
 */
export const MAM_FIELDS: MamFieldDef[] = [
  { key: 'pinRequired', label: 'Require an app PIN', type: 'bool' },
  { key: 'minimumPinLength', label: 'Minimum PIN length', type: 'number', min: 1 },
  { key: 'maximumPinRetries', label: 'Maximum PIN retries', type: 'number', min: 1, max: 65535 },
  { key: 'allowedInboundDataTransferSources', label: 'Allowed inbound data transfer sources', type: 'enum', options: DATA_TRANSFER_LEVELS },
  { key: 'allowedOutboundDataTransferDestinations', label: 'Allowed outbound data transfer destinations', type: 'enum', options: DATA_TRANSFER_LEVELS },
  { key: 'allowedOutboundClipboardSharingLevel', label: 'Allowed outbound clipboard sharing level', type: 'enum', options: CLIPBOARD_SHARING_LEVELS },
  { key: 'saveAsBlocked', label: 'Block "Save As"', type: 'bool' },
  { key: 'deviceComplianceRequired', label: 'Require device compliance', type: 'bool' },
  { key: 'minimumRequiredOsVersion', label: 'Minimum required OS version', type: 'string' },
]

/** One canvas item = one iOS MAM policy (scalars + targeted apps + assignment). */
export interface IosMamPolicySpec {
  sectionName: string
  name: string
  description: string
  /** Only the writable scalar Graph fields the user set, keyed by Graph property. */
  graph: Record<string, unknown>
  appGroupType: AppGroupType
  /** Bundle ids to protect; only meaningful when appGroupType is selectedPublicApps. */
  targetedApps: string[]
  assignment: AssignmentSpec
}

// --- Field value readers (used by the canvas extractor) ----------------------

/** Read a tags/list field into a trimmed string array (accepts a comma/newline string too). */
export function readList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter((v) => v.length > 0)
  if (typeof value === 'string') return value.split(/[\n,]/).map((v) => v.trim()).filter((v) => v.length > 0)
  return []
}

/** Parse a number field; undefined when blank/non-numeric (so it is left unmanaged). */
export function readNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value.trim())
    if (Number.isFinite(n)) return n
  }
  return undefined
}

/** Parse a checkbox field; undefined when unset (so it is left unmanaged). */
export function readBool(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase()
    if (v === 'true' || v === 'on' || v === 'yes') return true
    if (v === 'false' || v === 'off' || v === 'no') return false
  }
  return undefined
}

/** True when a checkbox/flag value is on. */
export function readFlag(value: unknown): boolean {
  return value === true || (typeof value === 'string' && ['true', 'on', 'yes'].includes(value.trim().toLowerCase()))
}

/** Normalize an appGroupType select; defaults to selectedPublicApps when unset/unknown. */
export function normalizeAppGroupType(value: unknown): AppGroupType {
  if (typeof value === 'string') {
    const t = value.trim()
    if ((APP_GROUP_TYPES as readonly string[]).includes(t)) return t as AppGroupType
  }
  return 'selectedPublicApps'
}

/** True when at least one assignment target is declared (drives the no-assignment warning). */
export function hasAnyAssignment(spec: AssignmentSpec): boolean {
  return spec.includeGroupIds.length > 0 || spec.excludeGroupIds.length > 0 || Boolean(spec.allUsers)
}

/** Read the writable scalar fields off a section into a Graph-keyed map (blank = omitted). */
export function readManagedFields(fields: Record<string, unknown>): Record<string, unknown> {
  const graph: Record<string, unknown> = {}
  for (const def of MAM_FIELDS) {
    const raw = fields[def.key]
    if (def.type === 'number') {
      const n = readNumber(raw)
      if (n !== undefined) graph[def.key] = n
    } else if (def.type === 'bool') {
      const b = readBool(raw)
      if (b !== undefined) graph[def.key] = b
    } else if (typeof raw === 'string' && raw.trim() !== '') {
      graph[def.key] = raw.trim()
    }
  }
  return graph
}

/**
 * Read the assignment target set. MAM app protection targets USERS, so only
 * include/exclude groups + all-licensed-users are read (no all-devices target).
 */
export function readAssignmentSpec(fields: Record<string, unknown>): AssignmentSpec {
  return {
    includeGroupIds: readList(fields.includeGroups),
    excludeGroupIds: readList(fields.excludeGroups),
    allDevices: false,
    allUsers: readFlag(fields.allUsers),
  }
}

// --- Body builders -----------------------------------------------------------

/** Build the create/PATCH body — the @odata.type subtype is required on both. */
export function buildPolicyBody(spec: IosMamPolicySpec): Record<string, unknown> {
  return {
    '@odata.type': IOS_MANAGED_APP_PROTECTION_ODATA_TYPE,
    displayName: spec.name,
    description: spec.description,
    roleScopeTagIds: ['0'],
    ...spec.graph,
  }
}

/** The targetApps action body ({ appGroupType, apps }) for an iOS policy. */
export function buildTargetAppsBody(appGroupType: AppGroupType, appIds: string[]): Record<string, unknown> {
  return buildTargetApps({ platform: 'ios', appIds, appGroupType })
}

/** The assign action body ({ assignments }). */
export function buildAssignBody(spec: AssignmentSpec): Record<string, unknown> {
  return { assignments: buildAssignments(spec) }
}

// --- Live-policy reading (drift / rollback) ----------------------------------

/** An iosManagedAppProtection as returned by GET (scalars addressed by name). */
export interface LiveIosMamPolicy {
  '@odata.type'?: string
  id?: string
  displayName?: string
  description?: string
  roleScopeTagIds?: string[]
  appGroupType?: string
  apps?: Array<{ mobileAppIdentifier?: Record<string, unknown> }>
  assignments?: Array<{ target?: Record<string, unknown> }>
  [key: string]: unknown
}

/** The appGroupType of a live policy, defaulting to selectedPublicApps when absent/unknown. */
export function readLiveAppGroupType(live: LiveIosMamPolicy | null): AppGroupType {
  return normalizeAppGroupType(live?.appGroupType)
}

/** The protected bundle ids of a live policy (order as returned). */
export function readLiveTargetedApps(live: LiveIosMamPolicy | null): string[] {
  return readTargetedAppIds('ios', live?.apps)
}

/** Read include/exclude groups + all-users off a live policy's assignments. */
export function readLiveAssignment(live: LiveIosMamPolicy | null): ReturnType<typeof readAssignments> {
  return readAssignments(live?.assignments)
}

/** Snapshot the writable scalar fields off a live policy (for rollback restore). */
export function capturePriorFields(live: LiveIosMamPolicy | null): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!live) return out
  for (const def of MAM_FIELDS) {
    if (def.key in live) out[def.key] = live[def.key]
  }
  return out
}

/** Rebuild a restore PATCH body from captured prior fields (adds the @odata.type + identity). */
export function buildRestoreBody(name: string, description: string, fields: Record<string, unknown>): Record<string, unknown> {
  return {
    '@odata.type': IOS_MANAGED_APP_PROTECTION_ODATA_TYPE,
    displayName: name,
    description,
    roleScopeTagIds: ['0'],
    ...fields,
  }
}

/** Re-export the field-def list metadata for validate (range/enum checks). */
export type { AppGroupType, AssignmentSpec }
export { readAssignments }
