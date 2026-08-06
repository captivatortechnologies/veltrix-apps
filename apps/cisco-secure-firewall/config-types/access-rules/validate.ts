import type { CanvasSnapshot, DriftDiff, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { splitList, type FmcObject } from '../../lib/fmc'
import type { ObjectRef } from '../../lib/fmcRefs'

export const ACCESS_RULE_ACTIONS = [
  'ALLOW',
  'TRUST',
  'BLOCK',
  'MONITOR',
  'BLOCK_RESET',
  'BLOCK_INTERACTIVE',
  'BLOCK_RESET_INTERACTIVE',
] as const
export type AccessRuleAction = (typeof ACCESS_RULE_ACTIONS)[number]

export const ACCESS_RULE_SECTIONS = ['default', 'mandatory'] as const
export type AccessRuleSection = (typeof ACCESS_RULE_SECTIONS)[number]

/** Build the per-policy accessrules path. Verified against gen/definitions/access_rule.yaml `rest_endpoint`. */
export function accessRulesPath(policyId: string): string {
  return `/policy/accesspolicies/${policyId}/accessrules`
}

export interface AccessRuleSpec {
  sectionName: string
  policyName: string
  name: string
  action: string
  enabled: boolean
  ruleSection: string
  sourceZones: string[]
  destinationZones: string[]
  sourceNetworks: string[]
  destinationNetworks: string[]
  sourcePorts: string[]
  destinationPorts: string[]
  logBegin: boolean
  logEnd: boolean
  sendEventsToFmc: boolean
  description: string
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function coerceBool(value: unknown, def: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return def
}

export function extractAccessRuleSpecs(canvas: CanvasSnapshot): AccessRuleSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      policyName: str(fields.policy_name),
      name: str(fields.name),
      action: str(fields.action) || 'ALLOW',
      enabled: coerceBool(fields.enabled, true),
      ruleSection: str(fields.section) || 'mandatory',
      sourceZones: splitList(fields.source_zones),
      destinationZones: splitList(fields.destination_zones),
      sourceNetworks: splitList(fields.source_networks),
      destinationNetworks: splitList(fields.destination_networks),
      sourcePorts: splitList(fields.source_ports),
      destinationPorts: splitList(fields.destination_ports),
      logBegin: coerceBool(fields.log_begin, false),
      logEnd: coerceBool(fields.log_end, false),
      sendEventsToFmc: coerceBool(fields.send_events_to_fmc, false),
      description: str(fields.description),
    }
  })
}

/** Every reference field's resolved objects, gathered by deploy.ts/driftDetect.ts before building the FMC body. */
export interface ResolvedAccessRuleRefs {
  sourceZones: ObjectRef[]
  destinationZones: ObjectRef[]
  sourceNetworks: ObjectRef[]
  destinationNetworks: ObjectRef[]
  sourcePorts: ObjectRef[]
  destinationPorts: ObjectRef[]
}

function refObjectList(refs: ObjectRef[]): { objects: Array<{ id: string; type: string }> } | undefined {
  return refs.length > 0 ? { objects: refs.map((r) => ({ id: r.id, type: r.type })) } : undefined
}

/**
 * Build the FMC accessrule body. Each match condition is OMITTED entirely
 * when its reference list is empty - FMC treats an absent condition as "any",
 * exactly what a blank canvas field means here (verified against
 * access_rule.yaml's sourceZones/sourceNetworks/sourcePorts `data_path`
 * nesting: `{fieldName}: {objects: [...]}`).
 */
export function buildAccessRuleFields(spec: AccessRuleSpec, refs: ResolvedAccessRuleRefs): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    action: spec.action,
    enabled: spec.enabled,
    metadata: { section: spec.ruleSection },
    logBegin: spec.logBegin,
    logEnd: spec.logEnd,
    sendEventsToFMC: spec.sendEventsToFmc,
  }
  const sourceZones = refObjectList(refs.sourceZones)
  if (sourceZones) fields.sourceZones = sourceZones
  const destinationZones = refObjectList(refs.destinationZones)
  if (destinationZones) fields.destinationZones = destinationZones
  const sourceNetworks = refObjectList(refs.sourceNetworks)
  if (sourceNetworks) fields.sourceNetworks = sourceNetworks
  const destinationNetworks = refObjectList(refs.destinationNetworks)
  if (destinationNetworks) fields.destinationNetworks = destinationNetworks
  const sourcePorts = refObjectList(refs.sourcePorts)
  if (sourcePorts) fields.sourcePorts = sourcePorts
  const destinationPorts = refObjectList(refs.destinationPorts)
  if (destinationPorts) fields.destinationPorts = destinationPorts
  if (spec.description) fields.description = spec.description
  return fields
}

function liveRefIds(live: FmcObject, key: string): string[] {
  const value = live[key] as { objects?: Array<{ id?: string }> } | undefined
  const objects = Array.isArray(value?.objects) ? (value?.objects as Array<{ id?: string }>) : []
  return objects.map((o) => o.id).filter((id): id is string => typeof id === 'string').sort()
}

function compareRefSet(diffs: DriftDiff[], ruleName: string, field: string, expected: ObjectRef[], live: FmcObject, liveKey: string): void {
  const expectedIds = expected.map((r) => r.id).sort()
  const liveIds = liveRefIds(live, liveKey)
  if (JSON.stringify(expectedIds) !== JSON.stringify(liveIds)) {
    diffs.push({ field: `${ruleName}.${field}`, expected: `${expectedIds.length} object(s)`, actual: `${liveIds.length} object(s)`, severity: 'info' })
  }
}

/** Compare a declared rule (with its resolved refs) against FMC's live rule body. */
export function accessRuleDriftDiffs(spec: AccessRuleSpec, refs: ResolvedAccessRuleRefs, live: FmcObject): DriftDiff[] {
  const diffs: DriftDiff[] = []
  const liveAction = typeof live.action === 'string' ? live.action : ''
  if (liveAction && liveAction !== spec.action) {
    diffs.push({ field: `${spec.name}.action`, expected: spec.action, actual: liveAction, severity: 'critical' })
  }
  if (typeof live.enabled === 'boolean' && live.enabled !== spec.enabled) {
    diffs.push({ field: `${spec.name}.enabled`, expected: String(spec.enabled), actual: String(live.enabled), severity: 'warning' })
  }
  if (typeof live.logBegin === 'boolean' && live.logBegin !== spec.logBegin) {
    diffs.push({ field: `${spec.name}.log_begin`, expected: String(spec.logBegin), actual: String(live.logBegin), severity: 'info' })
  }
  if (typeof live.logEnd === 'boolean' && live.logEnd !== spec.logEnd) {
    diffs.push({ field: `${spec.name}.log_end`, expected: String(spec.logEnd), actual: String(live.logEnd), severity: 'info' })
  }
  compareRefSet(diffs, spec.name, 'source_zones', refs.sourceZones, live, 'sourceZones')
  compareRefSet(diffs, spec.name, 'destination_zones', refs.destinationZones, live, 'destinationZones')
  compareRefSet(diffs, spec.name, 'source_networks', refs.sourceNetworks, live, 'sourceNetworks')
  compareRefSet(diffs, spec.name, 'destination_networks', refs.destinationNetworks, live, 'destinationNetworks')
  compareRefSet(diffs, spec.name, 'source_ports', refs.sourcePorts, live, 'sourcePorts')
  compareRefSet(diffs, spec.name, 'destination_ports', refs.destinationPorts, live, 'destinationPorts')
  return diffs
}

/**
 * Validate access rules: a policy name, rule name and supported action are
 * required; MONITOR enforces FMC's own logging requirements (verified against
 * access_rule.yaml's `log_connection_begin`/`log_connection_end`/
 * `send_events_to_fmc` descriptions); rule names are unique WITHIN a policy
 * (not globally - the same rule name may exist in two different policies).
 *
 * Rule names are not restricted to the object-name character pattern used
 * elsewhere in this app - the FMC schema documents no such constraint for
 * Access Rule names, so this app does not invent one.
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
  for (const spec of extractAccessRuleSpecs(ctx.canvas)) {
    const prefix = spec.sectionName

    if (!spec.policyName) {
      errors.push({ field: `${prefix}.policy_name`, message: 'Access Control Policy name is required', code: 'required' })
    }
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Rule name is required', code: 'required' })
    }
    if (!ACCESS_RULE_ACTIONS.includes(spec.action as AccessRuleAction)) {
      errors.push({ field: `${prefix}.action`, message: `Unsupported action "${spec.action}"`, code: 'invalid_action' })
    }
    if (!ACCESS_RULE_SECTIONS.includes(spec.ruleSection as AccessRuleSection)) {
      errors.push({ field: `${prefix}.section`, message: `Unsupported section "${spec.ruleSection}"`, code: 'invalid_section' })
    }

    if (spec.action === 'MONITOR') {
      if (spec.logBegin) {
        errors.push({ field: `${prefix}.log_begin`, message: 'A Monitor rule requires "Log at Connection Begin" to be off', code: 'invalid_monitor_logging' })
      }
      if (!spec.logEnd) {
        errors.push({ field: `${prefix}.log_end`, message: 'A Monitor rule requires "Log at Connection End" to be on', code: 'invalid_monitor_logging' })
      }
      if (!spec.sendEventsToFmc) {
        errors.push({ field: `${prefix}.send_events_to_fmc`, message: 'A Monitor rule requires "Send Events to FMC" to be on', code: 'invalid_monitor_logging' })
      }
    }

    if (spec.policyName && spec.name) {
      const key = `${spec.policyName.toLowerCase()}::${spec.name.toLowerCase()}`
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate rule "${spec.name}" in policy "${spec.policyName}"`, code: 'duplicate' })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
