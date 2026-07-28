// =============================================================================
// Intune device compliance policy — Graph deviceCompliancePolicies domain model.
//
// A compliance policy is an ABSTRACT deviceCompliancePolicy; every create/update
// carries a per-platform `@odata.type` discriminator and only that platform's
// scalar properties. Notably iOS uses the `passcode*` prefix where the other four
// platforms use `password*`, iOS has no `storageRequireEncryption`, jailbreak/root
// detection is iOS/Android-only, and the Windows Defender/health-attestation flags
// (bitLocker/secureBoot/defender/firewall/tpm) are Windows-only. This module owns
// the platform → property mapping so deploy/drift/rollback share one code path.
//
// `scheduledActionsForRule` is REQUIRED at create (a policy with no scheduled
// action is rejected) and must carry exactly one `block` action; on update it is
// converged via the separate scheduleActionsForRules action, never inline PATCH.
//
// Property names + per-platform applicability are verified against Microsoft Learn
// (v1.0 + beta resource pages); the shared IntuneClient targets Graph beta, where
// every field modeled here is present.
// =============================================================================

import { buildAssignments, readAssignments, type AssignmentSpec } from '../../lib/assignments'

/** Supported compliance platforms (the canvas `platform` select values). */
export type CompliancePlatform = 'windows' | 'ios' | 'macos' | 'androidDeviceOwner' | 'androidWorkProfile'

/** Per-platform `@odata.type` discriminator + a human label. */
export const PLATFORMS: Record<CompliancePlatform, { odataType: string; label: string }> = {
  windows: { odataType: '#microsoft.graph.windows10CompliancePolicy', label: 'Windows 10/11' },
  ios: { odataType: '#microsoft.graph.iosCompliancePolicy', label: 'iOS/iPadOS' },
  macos: { odataType: '#microsoft.graph.macOSCompliancePolicy', label: 'macOS' },
  androidDeviceOwner: { odataType: '#microsoft.graph.androidDeviceOwnerCompliancePolicy', label: 'Android Enterprise (fully managed / device owner)' },
  androidWorkProfile: { odataType: '#microsoft.graph.androidWorkProfileCompliancePolicy', label: 'Android Enterprise (work profile)' },
}

export const COMPLIANCE_PLATFORM_KEYS = Object.keys(PLATFORMS) as CompliancePlatform[]

/** deviceComplianceActionType values this app models (block is always required). */
export const NON_COMPLIANCE_ACTIONS = ['block', 'retire'] as const
export type NonComplianceAction = (typeof NON_COMPLIANCE_ACTIONS)[number]

/** deviceThreatProtectionLevel enum. 'notconfigured' (canvas-only) means: omit. */
export const THREAT_LEVELS = ['unavailable', 'secured', 'low', 'medium', 'high', 'notSet'] as const

type FieldKind = 'bool' | 'number' | 'string' | 'threatLevel'

/** One managed compliance setting: its canvas key + how it maps to a Graph property per platform. */
export interface ComplianceField {
  key: string
  kind: FieldKind
  /** The Graph property name for a platform, or null when the platform has no such setting. */
  graphProp: (platform: CompliancePlatform) => string | null
}

const ALL = () => true
const isWindows = (p: CompliancePlatform) => p === 'windows'
const hasEncryption = (p: CompliancePlatform) => p !== 'ios' // iOS is always encrypted — no property
// jailbreak/root block: iOS + Android work profile only. androidDeviceOwner has
// NO securityBlockJailbrokenDevices property (it uses Play Integrity / SafetyNet
// attestation instead), so emitting it there would make Graph reject the create.
const hasJailbreak = (p: CompliancePlatform) => p === 'ios' || p === 'androidWorkProfile'

function prop(name: string, supports: (p: CompliancePlatform) => boolean): (p: CompliancePlatform) => string | null {
  return (p) => (supports(p) ? name : null)
}

/** The managed compliance fields, in canvas order. iOS swaps the password* trio for passcode*. */
export const COMPLIANCE_FIELDS: ComplianceField[] = [
  { key: 'password_required', kind: 'bool', graphProp: (p) => (p === 'ios' ? 'passcodeRequired' : 'passwordRequired') },
  { key: 'password_minimum_length', kind: 'number', graphProp: (p) => (p === 'ios' ? 'passcodeMinimumLength' : 'passwordMinimumLength') },
  { key: 'password_minutes_of_inactivity', kind: 'number', graphProp: (p) => (p === 'ios' ? 'passcodeMinutesOfInactivityBeforeLock' : 'passwordMinutesOfInactivityBeforeLock') },
  { key: 'os_minimum_version', kind: 'string', graphProp: prop('osMinimumVersion', ALL) },
  { key: 'os_maximum_version', kind: 'string', graphProp: prop('osMaximumVersion', ALL) },
  { key: 'storage_require_encryption', kind: 'bool', graphProp: prop('storageRequireEncryption', hasEncryption) },
  { key: 'security_block_jailbroken', kind: 'bool', graphProp: prop('securityBlockJailbrokenDevices', hasJailbreak) },
  { key: 'device_threat_protection_enabled', kind: 'bool', graphProp: prop('deviceThreatProtectionEnabled', ALL) },
  { key: 'device_threat_protection_level', kind: 'threatLevel', graphProp: prop('deviceThreatProtectionRequiredSecurityLevel', ALL) },
  { key: 'bitlocker_enabled', kind: 'bool', graphProp: prop('bitLockerEnabled', isWindows) },
  { key: 'secure_boot_enabled', kind: 'bool', graphProp: prop('secureBootEnabled', isWindows) },
  { key: 'defender_enabled', kind: 'bool', graphProp: prop('defenderEnabled', isWindows) },
  { key: 'active_firewall_required', kind: 'bool', graphProp: prop('activeFirewallRequired', isWindows) },
  { key: 'tpm_required', kind: 'bool', graphProp: prop('tpmRequired', isWindows) },
]

/** A settings value that is actually configured, or undefined meaning "not configured / omit". */
export type ComplianceSettingValue = boolean | number | string | undefined

/** One canvas item = one compliance policy (a platform + its settings + actions + assignment). */
export interface CompliancePolicySpec {
  sectionName: string
  name: string
  platform: CompliancePlatform | ''
  description: string
  /** canvas field key → normalized value; undefined = not configured (omitted from the body). */
  settings: Record<string, ComplianceSettingValue>
  gracePeriodHours: number
  nonComplianceAction: NonComplianceAction
  assignment: AssignmentSpec
}

// --- Field value readers (used by the canvas extractor) ----------------------

export function normalizePlatform(value: unknown): CompliancePlatform | '' {
  if (typeof value === 'string') {
    const t = value.trim()
    if ((COMPLIANCE_PLATFORM_KEYS as readonly string[]).includes(t)) return t as CompliancePlatform
  }
  return ''
}

/** Tri-state boolean: 'require' → true, 'notrequire' → false, anything else → undefined. */
export function readBoolSetting(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const t = value.trim().toLowerCase()
    if (t === 'require' || t === 'required' || t === 'true' || t === 'yes') return true
    if (t === 'notrequire' || t === 'notrequired' || t === 'false' || t === 'no') return false
  }
  return undefined
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

export function readThreatLevel(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const t = value.trim()
    if ((THREAT_LEVELS as readonly string[]).includes(t)) return t
  }
  return undefined
}

export function readNonComplianceAction(value: unknown): NonComplianceAction {
  if (typeof value === 'string' && value.trim().toLowerCase() === 'retire') return 'retire'
  return 'block'
}

/** True when a checkbox/flag value is on. */
export function readFlag(value: unknown): boolean {
  return value === true || (typeof value === 'string' && value.trim().toLowerCase() === 'true')
}

/** Read a tags/list field into a trimmed string array (accepts a comma-separated string too). */
export function readList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter((v) => v.length > 0)
  if (typeof value === 'string') return value.split(',').map((v) => v.trim()).filter((v) => v.length > 0)
  return []
}

/** Read every managed compliance setting off a section's fields into a normalized map. */
export function readComplianceSettings(fields: Record<string, unknown>): Record<string, ComplianceSettingValue> {
  const out: Record<string, ComplianceSettingValue> = {}
  for (const f of COMPLIANCE_FIELDS) {
    const raw = fields[f.key]
    out[f.key] =
      f.kind === 'bool'
        ? readBoolSetting(raw)
        : f.kind === 'number'
          ? readNumberSetting(raw)
          : f.kind === 'threatLevel'
            ? readThreatLevel(raw)
            : readStringSetting(raw)
  }
  return out
}

/** Read the include/exclude groups + all-devices/all-users flags for the assign action. */
export function readAssignmentSpec(fields: Record<string, unknown>): AssignmentSpec {
  return {
    includeGroupIds: readList(fields.include_groups),
    excludeGroupIds: readList(fields.exclude_groups),
    allDevices: readFlag(fields.all_devices),
    allUsers: readFlag(fields.all_users),
  }
}

// hasAnyAssignment is defined once in lib/assignments (single source of truth).
export { hasAnyAssignment } from '../../lib/assignments'

// --- Body builders -----------------------------------------------------------

/**
 * Build the scheduledActionsForRule for a policy. Intune requires exactly one
 * `block` action (the "mark non-compliant after grace period" schedule), so it is
 * always present; a `retire` choice appends a second action after the same grace.
 */
export function buildScheduledActions(spec: CompliancePolicySpec): Record<string, unknown>[] {
  const actionItem = (actionType: NonComplianceAction): Record<string, unknown> => ({
    '@odata.type': '#microsoft.graph.deviceComplianceActionItem',
    actionType,
    gracePeriodHours: spec.gracePeriodHours,
    notificationTemplateId: '',
    notificationMessageCCList: [],
  })
  const configs: Record<string, unknown>[] = [actionItem('block')]
  if (spec.nonComplianceAction === 'retire') configs.push(actionItem('retire'))
  return [
    {
      '@odata.type': '#microsoft.graph.deviceComplianceScheduledActionForRule',
      ruleName: 'PasswordRequired',
      scheduledActionConfigurations: configs,
    },
  ]
}

/** The body for the scheduleActionsForRules action (update path for scheduled actions). */
export function buildScheduleActionsRequest(spec: CompliancePolicySpec): Record<string, unknown> {
  return { deviceComplianceScheduledActionForRules: buildScheduledActions(spec) }
}

/**
 * Build a create/update body: the platform `@odata.type`, identity fields and only
 * the settings applicable to the platform that are actually configured. Scheduled
 * actions are included inline only on create (they are required); on update they go
 * through the separate scheduleActionsForRules action.
 */
export function buildComplianceBody(spec: CompliancePolicySpec, opts: { includeScheduledActions: boolean }): Record<string, unknown> {
  const platform = spec.platform as CompliancePlatform
  const body: Record<string, unknown> = {
    '@odata.type': PLATFORMS[platform].odataType,
    displayName: spec.name,
    description: spec.description,
    roleScopeTagIds: ['0'],
  }
  for (const f of COMPLIANCE_FIELDS) {
    const name = f.graphProp(platform)
    const value = spec.settings[f.key]
    if (name && value !== undefined) body[name] = value
  }
  if (opts.includeScheduledActions) body.scheduledActionsForRule = buildScheduledActions(spec)
  return body
}

// --- Live-policy reading (drift / rollback) ----------------------------------

/** A deviceCompliancePolicy as returned by GET (scalar props are addressed by name). */
export interface LiveCompliancePolicy {
  id?: string
  '@odata.type'?: string
  displayName?: string
  description?: string
  roleScopeTagIds?: string[]
  assignments?: Array<{ target?: Record<string, unknown> }>
  [key: string]: unknown
}

/** Strip a leading '#' and namespace so two @odata.type strings compare by short name. */
export function normalizeOdataType(value: unknown): string {
  return String(value ?? '').replace(/^#/, '').trim().toLowerCase()
}

/** The platform of a live policy from its @odata.type, or '' when unrecognized. */
export function platformFromOdataType(odataType: unknown): CompliancePlatform | '' {
  const norm = normalizeOdataType(odataType)
  for (const key of COMPLIANCE_PLATFORM_KEYS) {
    if (normalizeOdataType(PLATFORMS[key].odataType) === norm) return key
  }
  return ''
}

/**
 * Capture the managed subset of a live policy (identity + every applicable field,
 * including explicit false/0 values Graph returns) so rollback can restore it.
 */
export function capturePriorFields(live: LiveCompliancePolicy, platform: CompliancePlatform): Record<string, unknown> {
  const prior: Record<string, unknown> = {
    displayName: live.displayName ?? '',
    description: typeof live.description === 'string' ? live.description : '',
    roleScopeTagIds: Array.isArray(live.roleScopeTagIds) && live.roleScopeTagIds.length > 0 ? live.roleScopeTagIds : ['0'],
  }
  for (const f of COMPLIANCE_FIELDS) {
    const name = f.graphProp(platform)
    if (name && live[name] !== undefined) prior[name] = live[name]
  }
  return prior
}

/** Rebuild a restore PATCH body from captured prior fields (adds the @odata.type). */
export function buildRestoreBody(prior: Record<string, unknown>, platform: CompliancePlatform): Record<string, unknown> {
  return { '@odata.type': PLATFORMS[platform].odataType, ...prior }
}

/** A live scheduledActionsForRule rule (its configurations expanded). */
export interface LiveScheduledActionForRule {
  ruleName?: string
  scheduledActionConfigurations?: Array<Record<string, unknown>>
}

/**
 * Normalize a live policy's scheduledActionsForRule into the exact shape the
 * scheduleActionsForRules action accepts, dropping server-managed fields (ids)
 * so it can be replayed verbatim on rollback. Deploy converges these on update
 * (grace period / retire), so rollback must be able to restore the prior set.
 */
export function capturePriorScheduledActions(rules: LiveScheduledActionForRule[] | undefined): Record<string, unknown>[] {
  return (Array.isArray(rules) ? rules : []).map((rule) => ({
    '@odata.type': '#microsoft.graph.deviceComplianceScheduledActionForRule',
    ruleName: typeof rule?.ruleName === 'string' && rule.ruleName ? rule.ruleName : 'PasswordRequired',
    scheduledActionConfigurations: (Array.isArray(rule?.scheduledActionConfigurations) ? rule.scheduledActionConfigurations : []).map((c) => ({
      '@odata.type': '#microsoft.graph.deviceComplianceActionItem',
      actionType: c?.actionType,
      gracePeriodHours: typeof c?.gracePeriodHours === 'number' ? c.gracePeriodHours : 0,
      notificationTemplateId: typeof c?.notificationTemplateId === 'string' ? c.notificationTemplateId : '',
      notificationMessageCCList: Array.isArray(c?.notificationMessageCCList) ? c.notificationMessageCCList : [],
    })),
  }))
}

/** Wrap captured prior scheduled actions for the scheduleActionsForRules action. */
export function buildScheduleActionsRequestFromPrior(scheduled: Record<string, unknown>[]): Record<string, unknown> {
  return { deviceComplianceScheduledActionForRules: scheduled }
}

/** Read include/exclude groups + all-devices/all-users off a live policy's assignments. */
export function readLiveAssignment(live: LiveCompliancePolicy): ReturnType<typeof readAssignments> {
  return readAssignments(live.assignments)
}

/** Re-export so deploy/rollback build the assign body without importing the lib twice. */
export { buildAssignments }
