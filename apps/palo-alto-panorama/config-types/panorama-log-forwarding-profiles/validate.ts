import type { CanvasSnapshot, DriftDiff, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { coerceBoolean, sameSet, splitList, type PanoramaEntry, type UpsertSpec } from '../../lib/panorama'

// Log Forwarding profiles (/Objects/LogForwardingProfiles) — referenced by name
// from panorama-security-rules ("log_setting"), and from any other rule type in
// this app that forwards logs. Cited: PAN-OS REST API "Objects" category, class
// LogForwardingProfiles in pypanrestv2 (github.com/mrzepa/pypanrestv2,
// Objects.py) and terraform-provider-panos panos_log_forwarding_profile
// (match_list[].{log_type,filter,send_to_panorama,send_syslog,send_email,
// send_http,send_snmptrap,quarantine}).
//
// The syslog/email/http/snmptrap server profiles named in send_* are NOT
// authored by this app (Device-category, template-scoped — see README
// Coverage) — reference existing profiles by name, the same precedent already
// used by security-rules' "log_setting"/"profile_group".
export const RESOURCE_PATH = '/Objects/LogForwardingProfiles'

export const LOG_TYPES = ['traffic', 'threat', 'wildfire', 'url', 'data', 'gtp', 'tunnel', 'auth', 'sctp', 'decryption'] as const
export type LogType = (typeof LOG_TYPES)[number]

const DEFAULT_MATCH_NAME = 'default'

export interface LogForwardingSpec {
  sectionName: string
  name: string
  description: string
  enhancedApplicationLogging: boolean
  matchName: string
  logType: string
  filter: string
  sendToPanorama: boolean
  sendSyslog: string[]
  sendEmail: string[]
  sendHttp: string[]
  sendSnmptrap: string[]
  quarantine: boolean
}

interface LiveMatchListEntry {
  '@name'?: string
  'log-type'?: string
  filter?: string
  'send-to-panorama'?: string
  'send-syslog'?: { member?: string[] }
  'send-email'?: { member?: string[] }
  'send-http'?: { member?: string[] }
  'send-snmptrap'?: { member?: string[] }
  quarantine?: string
}

export interface LiveLogForwarding extends PanoramaEntry {
  description?: string
  'enhanced-application-logging'?: string
  'match-list'?: { entry?: LiveMatchListEntry | LiveMatchListEntry[] }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function extractLogForwardingSpecs(canvas: CanvasSnapshot): LogForwardingSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: str(fields.name),
      description: str(fields.description),
      enhancedApplicationLogging: coerceBoolean(fields.enhanced_application_logging, false),
      matchName: str(fields.match_name) || DEFAULT_MATCH_NAME,
      logType: str(fields.log_type) || 'traffic',
      filter: str(fields.filter),
      sendToPanorama: coerceBoolean(fields.send_to_panorama, true),
      sendSyslog: splitList(fields.send_syslog),
      sendEmail: splitList(fields.send_email),
      sendHttp: splitList(fields.send_http),
      sendSnmptrap: splitList(fields.send_snmptrap),
      quarantine: coerceBoolean(fields.quarantine, false),
    }
  })
}

/** Build the REST entry fields for a log forwarding profile (single match-list entry). */
export function buildLogForwardingFields(spec: LogForwardingSpec): Record<string, unknown> {
  const match: Record<string, unknown> = {
    '@name': spec.matchName,
    'log-type': spec.logType,
    'send-to-panorama': spec.sendToPanorama ? 'yes' : 'no',
    quarantine: spec.quarantine ? 'yes' : 'no',
  }
  if (spec.filter) match.filter = spec.filter
  if (spec.sendSyslog.length > 0) match['send-syslog'] = { member: spec.sendSyslog }
  if (spec.sendEmail.length > 0) match['send-email'] = { member: spec.sendEmail }
  if (spec.sendHttp.length > 0) match['send-http'] = { member: spec.sendHttp }
  if (spec.sendSnmptrap.length > 0) match['send-snmptrap'] = { member: spec.sendSnmptrap }

  const fields: Record<string, unknown> = {
    'match-list': { entry: [match] },
    'enhanced-application-logging': spec.enhancedApplicationLogging ? 'yes' : 'no',
  }
  if (spec.description) fields.description = spec.description
  return fields
}

export function logForwardingUpsertSpecs(canvas: CanvasSnapshot): UpsertSpec[] {
  return extractLogForwardingSpecs(canvas)
    .filter((s) => s.name && LOG_TYPES.includes(s.logType as LogType))
    .map((s) => ({ name: s.name, fields: buildLogForwardingFields(s) }))
}

function liveMatchEntries(entry: PanoramaEntry): LiveMatchListEntry[] {
  const matches = (entry as LiveLogForwarding)['match-list']?.entry
  if (!matches) return []
  return Array.isArray(matches) ? matches : [matches]
}

export function logForwardingDriftDiffs(spec: LogForwardingSpec, entry: PanoramaEntry): DriftDiff[] {
  const diffs: DriftDiff[] = []
  const live = entry as LiveLogForwarding

  const liveEal = str(live['enhanced-application-logging']).toLowerCase() === 'yes'
  if (liveEal !== spec.enhancedApplicationLogging) {
    diffs.push({ field: `${spec.name}.enhanced-application-logging`, expected: String(spec.enhancedApplicationLogging), actual: String(liveEal), severity: 'info' })
  }

  const match = liveMatchEntries(entry).find((m) => str(m['@name']).toLowerCase() === spec.matchName.toLowerCase())
  if (!match) {
    diffs.push({ field: `${spec.name}.${spec.matchName}`, expected: 'exists', actual: 'missing', severity: 'critical' })
    return diffs
  }
  if (str(match['log-type']) !== spec.logType) {
    diffs.push({ field: `${spec.name}.log-type`, expected: spec.logType, actual: str(match['log-type']) || 'not set', severity: 'warning' })
  }
  if (spec.filter && str(match.filter) !== spec.filter) {
    diffs.push({ field: `${spec.name}.filter`, expected: spec.filter, actual: str(match.filter) || 'not set', severity: 'info' })
  }
  const liveToPanorama = str(match['send-to-panorama']).toLowerCase() === 'yes'
  if (liveToPanorama !== spec.sendToPanorama) {
    diffs.push({ field: `${spec.name}.send-to-panorama`, expected: String(spec.sendToPanorama), actual: String(liveToPanorama), severity: 'warning' })
  }
  const compareTargets = (label: string, expected: string[], live: string[] | undefined) => {
    const actual = Array.isArray(live) ? live : []
    if (!sameSet(actual, expected)) {
      diffs.push({ field: `${spec.name}.${label}`, expected: expected.join(', ') || 'none', actual: actual.join(', ') || 'none', severity: 'info' })
    }
  }
  compareTargets('send-syslog', spec.sendSyslog, match['send-syslog']?.member)
  compareTargets('send-email', spec.sendEmail, match['send-email']?.member)
  compareTargets('send-http', spec.sendHttp, match['send-http']?.member)
  compareTargets('send-snmptrap', spec.sendSnmptrap, match['send-snmptrap']?.member)
  const liveQuarantine = str(match.quarantine).toLowerCase() === 'yes'
  if (liveQuarantine !== spec.quarantine) {
    diffs.push({ field: `${spec.name}.quarantine`, expected: String(spec.quarantine), actual: String(liveQuarantine), severity: 'info' })
  }
  return diffs
}

/**
 * Validate log forwarding profiles: a name and match-list entry name are
 * required and the profile name is unique across the canvas; the log type is a
 * supported value.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const seen = new Set<string>()
  for (const spec of extractLogForwardingSpecs(ctx.canvas)) {
    const prefix = spec.sectionName
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Log forwarding profile name is required', code: 'required' })
    }
    if (!spec.matchName) {
      errors.push({ field: `${prefix}.match_name`, message: 'Match entry name is required', code: 'required' })
    }
    if (!LOG_TYPES.includes(spec.logType as LogType)) {
      errors.push({ field: `${prefix}.log_type`, message: `Unsupported log type "${spec.logType}"`, code: 'invalid_log_type' })
    }
    if (
      !spec.sendToPanorama &&
      spec.sendSyslog.length === 0 &&
      spec.sendEmail.length === 0 &&
      spec.sendHttp.length === 0 &&
      spec.sendSnmptrap.length === 0
    ) {
      warnings.push({ field: `${prefix}.send_to_panorama`, message: 'No forwarding destination is set (Panorama, syslog, email, HTTP or SNMP trap) — matching logs go nowhere', code: 'no_destination' })
    }
    if (spec.name) {
      const key = spec.name.toLowerCase()
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate log forwarding profile "${spec.name}"`, code: 'duplicate' })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
