// =============================================================================
// Intune app configuration policies (MAM) — Graph targetedManagedAppConfiguration.
//
// An app configuration policy delivers a set of custom key/value settings AS-IS
// into a set of managed apps (MAM, not managed devices). It is a
// targetedManagedAppConfiguration under /deviceAppManagement. Its payload — the
// displayName, description and the customSettings key/value pairs — is written on
// the create/PATCH body; the managed apps it targets and the user groups it
// deploys to are bound by TWO SEPARATE actions after the policy exists:
//   POST .../{id}/targetApps  { appGroupType, apps:[{ mobileAppIdentifier … }] }
//   POST .../{id}/assign      { assignments:[{ target … }] }
// so appGroupType/targetedApps and the assignment groups are NEVER on the body.
//
// App-config apps are identified per platform (iOS bundleId / Android packageId),
// so ONE policy targets ONE platform via a `platform` select that picks the
// identifier type through the shared buildTargetApps helper.
//
// Property names, customSettings shape (keyValuePair name/value) and the
// appGroupType enum are verified against Microsoft Learn (beta
// targetedManagedAppConfiguration); the shared IntuneClient targets Graph beta.
// =============================================================================

import { buildAssignments, readAssignments, type AssignmentSpec } from '../../lib/assignments'
import { buildTargetApps, readTargetedAppIds, type AppGroupType, type MamPlatform } from '../../lib/targetApps'

/** The @odata.type discriminator for a targeted app configuration policy. */
export const APP_CONFIG_ODATA_TYPE = '#microsoft.graph.targetedManagedAppConfiguration'

/** The Graph collection that holds app configuration policies. */
export const APP_CONFIG_PATH = '/deviceAppManagement/targetedManagedAppConfigurations'

/** The @odata.type for each custom setting entry (a keyValuePair). */
export const KEY_VALUE_PAIR_ODATA_TYPE = 'microsoft.graph.keyValuePair'

/** targetedManagedAppGroupType (which public apps the policy configures). */
export const APP_GROUP_TYPES: readonly AppGroupType[] = ['selectedPublicApps', 'allApps', 'allMicrosoftApps', 'allCoreMicrosoftApps']

/** The platforms a policy can target (picks the app-identifier type). */
export const PLATFORMS: readonly MamPlatform[] = ['ios', 'android']

/** One custom setting pushed into managed apps: a string key + string value. */
export interface CustomSetting {
  name: string
  value: string
}

/** One canvas item = one app configuration policy. */
export interface AppConfigSpec {
  sectionName: string
  name: string
  description: string
  /** The platform whose app identifiers the targeted apps use. */
  platform: MamPlatform
  appGroupType: AppGroupType
  /** Bundle ids (iOS) / package ids (Android); only used when appGroupType is selectedPublicApps. */
  targetedApps: string[]
  /** The parsed custom key/value settings (empty when none / unparsable). */
  customSettings: CustomSetting[]
  /** A parse error for the raw customSettings input, surfaced by validate; undefined when clean. */
  customSettingsError?: string
  assignment: AssignmentSpec
}

// --- Field value readers -----------------------------------------------------

/** Read a tags/list field into a trimmed string array (accepts a comma/newline string too). */
export function readList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter((v) => v.length > 0)
  if (typeof value === 'string') return value.split(/[\n,]/).map((v) => v.trim()).filter((v) => v.length > 0)
  return []
}

/** True when a checkbox/flag value is on. */
export function readFlag(value: unknown): boolean {
  return value === true || (typeof value === 'string' && ['true', 'on', 'yes', '1'].includes(value.trim().toLowerCase()))
}

/** Read a required string field (trimmed), or '' when blank/absent. */
export function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** Normalize the platform select; defaults to iOS when unset/unknown. */
export function normalizePlatform(value: unknown): MamPlatform {
  if (typeof value === 'string') {
    const t = value.trim().toLowerCase()
    if (t === 'android') return 'android'
    if (t === 'ios') return 'ios'
  }
  return 'ios'
}

/** Normalize an appGroupType select; defaults to selectedPublicApps when unset/unknown. */
export function normalizeAppGroupType(value: unknown): AppGroupType {
  if (typeof value === 'string') {
    const t = value.trim()
    if ((APP_GROUP_TYPES as readonly string[]).includes(t)) return t as AppGroupType
  }
  return 'selectedPublicApps'
}

/** Coerce any keyValuePair value to the String type Graph requires. */
function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** Validate + normalize an array of raw setting entries into CustomSetting[]. */
function coerceSettingsArray(items: unknown[]): { settings: CustomSetting[]; error?: string } {
  const settings: CustomSetting[] = []
  const seen = new Set<string>()
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { settings: [], error: `Custom setting #${i + 1} must be an object with a "name" and "value"` }
    }
    const rec = item as Record<string, unknown>
    const name = typeof rec.name === 'string' ? rec.name.trim() : ''
    if (name === '') return { settings: [], error: `Custom setting #${i + 1} is missing a non-empty "name"` }
    if (seen.has(name)) return { settings: [], error: `Duplicate custom setting name "${name}"` }
    seen.add(name)
    settings.push({ name, value: stringifyValue(rec.value) })
  }
  return { settings }
}

/** Parse `key=value` lines (one per line) into CustomSetting[]. */
function parseKeyValueLines(text: string): { settings: CustomSetting[]; error?: string } {
  const settings: CustomSetting[] = []
  const seen = new Set<string>()
  for (const line of text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0)) {
    const eq = line.indexOf('=')
    if (eq < 0) return { settings: [], error: `Custom setting "${line}" must be in key=value form` }
    const name = line.slice(0, eq).trim()
    const value = line.slice(eq + 1).trim()
    if (name === '') return { settings: [], error: `Custom setting "${line}" has an empty key` }
    if (seen.has(name)) return { settings: [], error: `Duplicate custom setting name "${name}"` }
    seen.add(name)
    settings.push({ name, value })
  }
  return { settings }
}

/**
 * Parse the customSettings field. Accepts EITHER a JSON array of
 * `{ name, value }` objects (or a pre-structured array), OR a plain-text block of
 * `key=value` lines. Returns the normalized settings and, when the input cannot be
 * parsed, a human-readable error (so validate can block the deploy).
 */
export function parseCustomSettings(raw: unknown): { settings: CustomSetting[]; error?: string } {
  if (Array.isArray(raw)) return coerceSettingsArray(raw)
  if (typeof raw !== 'string') return { settings: [] }
  const text = raw.trim()
  if (text === '') return { settings: [] }

  if (text.startsWith('[') || text.startsWith('{')) {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return { settings: [], error: 'Custom settings must be valid JSON (an array of { name, value } objects) or key=value lines' }
    }
    if (!Array.isArray(parsed)) return { settings: [], error: 'Custom settings JSON must be an array of { name, value } objects' }
    return coerceSettingsArray(parsed)
  }

  return parseKeyValueLines(text)
}

/**
 * Read the assignment target set. App-config policies target USERS, so only
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

/** True when at least one assignment target is declared (drives the no-assignment warning). */
export function hasAnyAssignment(spec: AssignmentSpec): boolean {
  return spec.includeGroupIds.length > 0 || spec.excludeGroupIds.length > 0 || Boolean(spec.allUsers)
}

// --- Body builders -----------------------------------------------------------

/** Map custom settings to the Graph keyValuePair collection shape. */
function toKeyValuePairs(settings: CustomSetting[]): Array<Record<string, unknown>> {
  return settings.map((s) => ({ '@odata.type': KEY_VALUE_PAIR_ODATA_TYPE, name: s.name, value: s.value }))
}

/** Build the create/PATCH body — the @odata.type subtype + identity + customSettings. */
export function buildConfigBody(spec: AppConfigSpec): Record<string, unknown> {
  return {
    '@odata.type': APP_CONFIG_ODATA_TYPE,
    displayName: spec.name,
    description: spec.description,
    roleScopeTagIds: ['0'],
    customSettings: toKeyValuePairs(spec.customSettings),
  }
}

/** The targetApps action body ({ appGroupType, apps }) for the policy's platform. */
export function buildTargetAppsBody(spec: AppConfigSpec): ReturnType<typeof buildTargetApps> {
  return buildTargetApps({ platform: spec.platform, appIds: spec.targetedApps, appGroupType: spec.appGroupType })
}

/** The assign action body ({ assignments }). */
export function buildAssignBody(spec: AssignmentSpec): { assignments: ReturnType<typeof buildAssignments> } {
  return { assignments: buildAssignments(spec) }
}

/** Rebuild a restore PATCH body from captured prior identity + custom settings. */
export function buildRestoreBody(name: string, description: string, customSettings: CustomSetting[]): Record<string, unknown> {
  return {
    '@odata.type': APP_CONFIG_ODATA_TYPE,
    displayName: name,
    description,
    roleScopeTagIds: ['0'],
    customSettings: toKeyValuePairs(customSettings),
  }
}

// --- Live-policy reading (drift / rollback) ----------------------------------

/** A targetedManagedAppConfiguration as returned by GET (apps/assignments expanded). */
export interface LiveAppConfig {
  '@odata.type'?: string
  id?: string
  displayName?: string
  description?: string
  roleScopeTagIds?: string[]
  appGroupType?: string
  customSettings?: Array<{ name?: unknown; value?: unknown }>
  apps?: Array<{ mobileAppIdentifier?: Record<string, unknown> }>
  assignments?: Array<{ target?: Record<string, unknown> }>
  [key: string]: unknown
}

/** The appGroupType of a live policy, defaulting to selectedPublicApps when absent/unknown. */
export function readLiveAppGroupType(live: LiveAppConfig | null): AppGroupType {
  return normalizeAppGroupType(live?.appGroupType)
}

/** The custom settings of a live policy (blank names dropped, values coerced to string). */
export function readLiveCustomSettings(live: LiveAppConfig | null): CustomSetting[] {
  const out: CustomSetting[] = []
  for (const s of live?.customSettings ?? []) {
    const name = typeof s?.name === 'string' ? s.name.trim() : ''
    if (name === '') continue
    out.push({ name, value: stringifyValue(s?.value) })
  }
  return out
}

/** The targeted app ids of a live policy, read for the declared platform. */
export function readLiveTargetedApps(live: LiveAppConfig | null, platform: MamPlatform): string[] {
  return readTargetedAppIds(platform, live?.apps)
}

/** Read include/exclude groups + all-users off a live policy's assignments. */
export function readLiveAssignment(live: LiveAppConfig | null): ReturnType<typeof readAssignments> {
  return readAssignments(live?.assignments)
}

// --- Comparison + formatting (drift) -----------------------------------------

/** Order-insensitive comparison of two custom-setting sets (by name, value-sensitive). */
export function sameCustomSettings(a: CustomSetting[], b: CustomSetting[]): boolean {
  if (a.length !== b.length) return false
  const mapB = new Map(b.map((s) => [s.name, s.value]))
  return a.every((s) => mapB.has(s.name) && mapB.get(s.name) === s.value)
}

/** Order-insensitive comparison of two id sets (case-insensitive). */
export function sameGroups(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(a.map((id) => id.toLowerCase()))
  return b.every((id) => set.has(id.toLowerCase()))
}

/** Render custom settings for a drift expected/actual value. */
export function formatCustomSettings(settings: CustomSetting[]): string {
  return settings.length ? settings.map((s) => `${s.name}=${s.value}`).join(', ') : 'none'
}

export { buildAssignments, buildTargetApps, readAssignments }
export type { AppGroupType, AssignmentSpec, MamPlatform }
