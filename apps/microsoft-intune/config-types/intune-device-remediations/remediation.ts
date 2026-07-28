// =============================================================================
// Intune device remediation — Graph deviceHealthScripts domain model.
//
// A device remediation (proactive remediation) is a deviceHealthScript: a
// detection + optional remediation PowerShell script pair with a run schedule.
// The script bodies are Graph `Binary` properties, so they travel BASE64-encoded
// on the wire (detectionScriptContent / remediationScriptContent) — the canvas
// holds plain text, this module encodes on write and decodes for drift compare.
//
// Assignments use a DIFFERENT shape from the shared assign action: each target
// (from buildAssignments) is wrapped as a deviceHealthScriptAssignment carrying
// runRemediationScript + a runSchedule (daily → interval/time/useUtc, hourly →
// interval only), and the whole set is posted under `deviceHealthScriptAssignments`.
//
// Property names + read-only fields (version, timestamps, isGlobalScript,
// highestAvailableVersion) are verified against Microsoft Learn (beta); the shared
// IntuneClient targets Graph beta where deviceHealthScripts live.
// =============================================================================

import { buildAssignments, readAssignments, type AssignmentSpec } from '../../lib/assignments'

/** The deviceHealthScript resource @odata.type (a concrete type; sent for parity with the exemplars). */
export const DEVICE_HEALTH_SCRIPT_ODATA_TYPE = '#microsoft.graph.deviceHealthScript'

/** runAsAccountType enum. */
export const RUN_AS_ACCOUNTS = ['system', 'user'] as const
export type RunAsAccount = (typeof RUN_AS_ACCOUNTS)[number]

/** Run-schedule frequencies the canvas exposes. */
export const SCHEDULE_FREQUENCIES = ['daily', 'hourly'] as const
export type ScheduleFrequency = (typeof SCHEDULE_FREQUENCIES)[number]

export const DAILY_SCHEDULE_ODATA_TYPE = '#microsoft.graph.deviceHealthScriptDailySchedule'
export const HOURLY_SCHEDULE_ODATA_TYPE = '#microsoft.graph.deviceHealthScriptHourlySchedule'
export const DEVICE_HEALTH_SCRIPT_ASSIGNMENT_ODATA_TYPE = '#microsoft.graph.deviceHealthScriptAssignment'

export interface RemediationSchedule {
  frequency: ScheduleFrequency
  interval: number
  /** HH:MM (24h) — only meaningful for a daily schedule. */
  time: string
}

/** One canvas item = one device remediation (detection/remediation scripts + run options + schedule + assignment). */
export interface RemediationSpec {
  sectionName: string
  name: string
  description: string
  publisher: string
  /** Plain-text scripts (base64-encoded only when building the Graph body). */
  detectionScript: string
  remediationScript: string
  /** Raw select value — validated against RUN_AS_ACCOUNTS, coerced to a valid literal on build. */
  runAsAccount: string
  enforceSignatureCheck: boolean
  runAs32Bit: boolean
  schedule: RemediationSchedule
  assignments: AssignmentSpec
}

/** The prior live state captured at deploy so rollback can restore it (scripts kept DECODED). */
export interface RemediationPrior {
  description: string
  publisher: string
  detectionScript: string
  remediationScript: string
  runAsAccount: string
  enforceSignatureCheck: boolean
  runAs32Bit: boolean
  schedule: RemediationSchedule
  assignments: AssignmentSpec
}

// --- Field value readers (used by the canvas extractor) ----------------------

const pad2 = (n: number): string => String(n).padStart(2, '0')

export function normalizeRunAsAccount(value: unknown): RunAsAccount | '' {
  if (typeof value === 'string') {
    const t = value.trim().toLowerCase()
    if (t === 'system' || t === 'user') return t
  }
  return ''
}

export function normalizeFrequency(value: unknown): ScheduleFrequency {
  return typeof value === 'string' && value.trim().toLowerCase() === 'hourly' ? 'hourly' : 'daily'
}

/** Scripts are kept verbatim (never trimmed) so multi-line PowerShell round-trips unchanged. */
export function readScript(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function readNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value.trim())
    if (Number.isFinite(n)) return n
  }
  return undefined
}

export function readBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase()
    return v === 'true' || v === 'on' || v === 'yes'
  }
  return false
}

/** Read a tags/list field into a trimmed string array (accepts a comma/newline string too). */
export function readList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter((v) => v.length > 0)
  if (typeof value === 'string') return value.split(/[\n,]/).map((v) => v.trim()).filter((v) => v.length > 0)
  return []
}

/** Normalize an HH:MM string (defensive: pads, clamps, tolerates a trailing :SS from Graph). */
export function hhmm(value: unknown): string {
  if (typeof value !== 'string') return '01:00'
  const m = value.trim().match(/^(\d{1,2}):(\d{2})/)
  if (!m) return '01:00'
  const h = Math.min(23, Math.max(0, Number(m[1])))
  const min = Math.min(59, Math.max(0, Number(m[2])))
  return `${pad2(h)}:${pad2(min)}`
}

/** Build a Graph TimeOfDay from an HH:MM string. */
export function toTimeOfDay(value: string): string {
  return `${hhmm(value)}:00.0000000`
}

// hasAnyAssignment is defined once in lib/assignments (single source of truth).
export { hasAnyAssignment } from '../../lib/assignments'

// --- base64 (Buffer is a node global; typechecks against @types/node) ---------

export function encodeScript(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64')
}

export function decodeScript(value: unknown): string {
  if (typeof value !== 'string' || value === '') return ''
  try {
    return Buffer.from(value, 'base64').toString('utf8')
  } catch {
    return ''
  }
}

/** Normalize a script for comparison so CRLF/LF and trailing whitespace never false-positive as drift. */
export function normalizeScript(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim()
}

// --- Body builders -----------------------------------------------------------

/** Build the create/PATCH body — scripts are base64-encoded; a blank remediation script is omitted. */
export function buildRemediationBody(spec: RemediationSpec): Record<string, unknown> {
  const runAsAccount = normalizeRunAsAccount(spec.runAsAccount) || 'system'
  const body: Record<string, unknown> = {
    '@odata.type': DEVICE_HEALTH_SCRIPT_ODATA_TYPE,
    displayName: spec.name,
    description: spec.description,
    publisher: spec.publisher,
    detectionScriptContent: encodeScript(spec.detectionScript),
    runAsAccount,
    enforceSignatureCheck: spec.enforceSignatureCheck,
    runAs32Bit: spec.runAs32Bit,
    roleScopeTagIds: ['0'],
  }
  if (spec.remediationScript.trim() !== '') body.remediationScriptContent = encodeScript(spec.remediationScript)
  return body
}

/** Build the runSchedule for an assignment: hourly carries only interval; daily carries interval + time + useUtc. */
export function buildRunSchedule(schedule: RemediationSchedule): Record<string, unknown> {
  if (schedule.frequency === 'hourly') {
    return { '@odata.type': HOURLY_SCHEDULE_ODATA_TYPE, interval: schedule.interval }
  }
  return { '@odata.type': DAILY_SCHEDULE_ODATA_TYPE, interval: schedule.interval, time: toTimeOfDay(schedule.time), useUtc: false }
}

/** Wrap each assignment target as a deviceHealthScriptAssignment (target + runRemediationScript + shared runSchedule). */
export function buildRemediationAssignments(spec: RemediationSpec): Record<string, unknown>[] {
  const runSchedule = buildRunSchedule(spec.schedule)
  const runRemediationScript = spec.remediationScript.trim() !== ''
  return buildAssignments(spec.assignments).map((a) => ({
    '@odata.type': DEVICE_HEALTH_SCRIPT_ASSIGNMENT_ODATA_TYPE,
    target: a.target,
    runRemediationScript,
    runSchedule,
  }))
}

/** The body for the assign action (converges assignments; an empty set clears them). */
export function buildAssignRequest(spec: RemediationSpec): Record<string, unknown> {
  return { deviceHealthScriptAssignments: buildRemediationAssignments(spec) }
}

// --- Live-script reading (drift / rollback) ----------------------------------

/** A deviceHealthScript as returned by GET (scripts arrive base64-encoded). */
export interface LiveDeviceHealthScript {
  id?: string
  displayName?: string
  description?: string
  publisher?: string
  detectionScriptContent?: string
  remediationScriptContent?: string
  runAsAccount?: string
  enforceSignatureCheck?: boolean
  runAs32Bit?: boolean
  isGlobalScript?: boolean
  roleScopeTagIds?: string[]
  assignments?: Array<{ target?: Record<string, unknown>; runRemediationScript?: boolean; runSchedule?: Record<string, unknown> }>
  [key: string]: unknown
}

/** Read the run schedule off a live script's first assignment (defaults to daily 01:00 when absent). */
export function readLiveSchedule(live: LiveDeviceHealthScript): RemediationSchedule {
  const sched = (live.assignments ?? [])[0]?.runSchedule ?? {}
  const odata = String(sched['@odata.type'] ?? '').toLowerCase()
  const frequency: ScheduleFrequency = odata.includes('hourly') ? 'hourly' : 'daily'
  const interval = typeof sched.interval === 'number' && Number.isFinite(sched.interval) ? sched.interval : 1
  return { frequency, interval, time: hhmm(sched.time) }
}

/** Read include/exclude groups + all-devices/all-users off a live script's assignments. */
export function readLiveAssignment(live: LiveDeviceHealthScript): AssignmentSpec {
  return readAssignments(live.assignments)
}

/** Capture the managed subset of a live script (identity + decoded scripts + schedule + assignment) for rollback. */
export function capturePrior(live: LiveDeviceHealthScript): RemediationPrior {
  return {
    description: typeof live.description === 'string' ? live.description : '',
    publisher: typeof live.publisher === 'string' ? live.publisher : '',
    detectionScript: decodeScript(live.detectionScriptContent),
    remediationScript: decodeScript(live.remediationScriptContent),
    runAsAccount: normalizeRunAsAccount(live.runAsAccount) || 'system',
    enforceSignatureCheck: Boolean(live.enforceSignatureCheck),
    runAs32Bit: Boolean(live.runAs32Bit),
    schedule: readLiveSchedule(live),
    assignments: readLiveAssignment(live),
  }
}

/** Rebuild a full spec from a captured prior (for the rollback restore PATCH + re-assign). */
export function restoreSpec(name: string, prior: RemediationPrior): RemediationSpec {
  return {
    sectionName: name,
    name,
    description: prior.description,
    publisher: prior.publisher,
    detectionScript: prior.detectionScript,
    remediationScript: prior.remediationScript,
    runAsAccount: prior.runAsAccount || 'system',
    enforceSignatureCheck: prior.enforceSignatureCheck,
    runAs32Bit: prior.runAs32Bit,
    schedule: prior.schedule,
    assignments: prior.assignments,
  }
}

/** Re-export so deploy/rollback can build the assign body without importing the lib twice. */
export { buildAssignments }
