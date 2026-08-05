import type { CanvasSnapshot, DriftDiff, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { coerceBoolean, sameSet, splitList, type PanoramaEntry, type UpsertSpec } from '../../lib/panorama'

// Policy-Based Forwarding rules (/Policies/PolicyBasedForwardingPreRules) — the
// device-group PRE rulebase decides the egress interface/next hop for matching
// traffic instead of the routing table. Cited: PAN-OS REST API "Policies"
// category; class PolicyBasedForwardingRules in pypanrestv2
// (github.com/mrzepa/pypanrestv2, Policies.py) resolves to REST path
// "<class>".split('Rules')[0] + rulebase + "Rules" (the same convention this
// app's panorama-security-rules / panorama-nat-rules already use) =>
// PolicyBasedForwardingPreRules; and terraform-provider-panos
// panos_pbf_policy_rules (rules[].{from.zone,source_addresses,destination_
// addresses,applications,services,schedule,action.{forward,discard,
// forward_to_vsys,no_pbf},enforce_symmetric_return}).
//
// Modeled: zone-based "from" match (the common case — interface-based "from"
// is not represented); forward/discard/forward-to-vsys/no-pbf actions with the
// forward action's egress interface, next hop (IP or FQDN) and path-monitor;
// and symmetric return with its eligible next-hop address list. Per-device
// targeting, tags and active/active HA device binding are not represented
// (consistent with panorama-security-rules / panorama-nat-rules).
export const RESOURCE_PATH = '/Policies/PolicyBasedForwardingPreRules'

export const ACTION_TYPES = ['forward', 'discard', 'no_pbf', 'forward_to_vsys'] as const
export type ActionType = (typeof ACTION_TYPES)[number]

export const NEXTHOP_TYPES = ['none', 'ip', 'fqdn'] as const
export type NexthopType = (typeof NEXTHOP_TYPES)[number]

/** Terraform/canvas nexthop kind -> PAN-OS REST element name. */
const NEXTHOP_ELEMENT: Record<Exclude<NexthopType, 'none'>, string> = { ip: 'ip-address', fqdn: 'fqdn' }

export interface PbfRuleSpec {
  sectionName: string
  name: string
  fromZones: string[]
  source: string[]
  destination: string[]
  application: string[]
  service: string[]
  schedule: string
  actionType: string
  egressInterface: string
  nexthopType: string
  nexthopValue: string
  monitorIp: string
  monitorProfile: string
  monitorDisableIfUnreachable: boolean
  forwardToVsys: string
  enforceSymmetricReturn: boolean
  symmetricReturnAddresses: string[]
  disabled: boolean
  description: string
}

interface LiveForwardAction {
  'egress-interface'?: string
  nexthop?: { 'ip-address'?: string; fqdn?: string }
  monitor?: { 'ip-address'?: string; profile?: string; 'disable-if-unreachable'?: string }
}

interface LiveAction {
  forward?: LiveForwardAction
  discard?: Record<string, never>
  'no-pbf'?: Record<string, never>
  'forward-to-vsys'?: string
}

interface LiveEnforceSymmetricReturn {
  enabled?: string
  'nexthop-address-list'?: { entry?: Array<{ '@name'?: string }> | { '@name'?: string } }
}

export interface LivePbfRule extends PanoramaEntry {
  from?: { zone?: { member?: string[] } }
  source?: { member?: string[] }
  destination?: { member?: string[] }
  application?: { member?: string[] }
  service?: { member?: string[] }
  schedule?: string
  action?: LiveAction
  'enforce-symmetric-return'?: LiveEnforceSymmetricReturn
  disabled?: string
  description?: string
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function orDefault(list: string[], fallback: string[]): string[] {
  return list.length > 0 ? list : fallback
}

export function extractPbfRuleSpecs(canvas: CanvasSnapshot): PbfRuleSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: str(fields.name),
      fromZones: splitList(fields.from_zones),
      source: splitList(fields.source),
      destination: splitList(fields.destination),
      application: splitList(fields.application),
      service: splitList(fields.service),
      schedule: str(fields.schedule),
      actionType: str(fields.action_type) || 'forward',
      egressInterface: str(fields.egress_interface),
      nexthopType: str(fields.nexthop_type) || 'none',
      nexthopValue: str(fields.nexthop_value),
      monitorIp: str(fields.monitor_ip),
      monitorProfile: str(fields.monitor_profile),
      monitorDisableIfUnreachable: coerceBoolean(fields.monitor_disable_if_unreachable, false),
      forwardToVsys: str(fields.forward_to_vsys),
      enforceSymmetricReturn: coerceBoolean(fields.enforce_symmetric_return, false),
      symmetricReturnAddresses: splitList(fields.symmetric_return_addresses),
      disabled: coerceBoolean(fields.disabled, false),
      description: str(fields.description),
    }
  })
}

/** The effective (defaulted) match fields, shared by build + drift. */
export function effectiveMatch(spec: PbfRuleSpec) {
  return {
    fromZones: orDefault(spec.fromZones, ['any']),
    source: orDefault(spec.source, ['any']),
    destination: orDefault(spec.destination, ['any']),
    application: orDefault(spec.application, ['any']),
    service: orDefault(spec.service, ['any']),
  }
}

/** Build the REST `action` choice element. */
export function buildPbfAction(spec: PbfRuleSpec): Record<string, unknown> {
  switch (spec.actionType) {
    case 'discard':
      return { discard: {} }
    case 'no_pbf':
      return { 'no-pbf': {} }
    case 'forward_to_vsys':
      return { 'forward-to-vsys': spec.forwardToVsys }
    case 'forward':
    default: {
      const forward: Record<string, unknown> = {}
      if (spec.egressInterface) forward['egress-interface'] = spec.egressInterface
      if (spec.nexthopType !== 'none' && spec.nexthopValue) {
        forward.nexthop = { [NEXTHOP_ELEMENT[spec.nexthopType as Exclude<NexthopType, 'none'>]]: spec.nexthopValue }
      }
      if (spec.monitorIp || spec.monitorProfile || spec.monitorDisableIfUnreachable) {
        const monitor: Record<string, unknown> = {}
        if (spec.monitorIp) monitor['ip-address'] = spec.monitorIp
        if (spec.monitorProfile) monitor.profile = spec.monitorProfile
        monitor['disable-if-unreachable'] = spec.monitorDisableIfUnreachable ? 'yes' : 'no'
        forward.monitor = monitor
      }
      return { forward }
    }
  }
}

/** Build the REST `enforce-symmetric-return` element. */
export function buildEnforceSymmetricReturn(spec: PbfRuleSpec): Record<string, unknown> {
  const value: Record<string, unknown> = { enabled: spec.enforceSymmetricReturn ? 'yes' : 'no' }
  if (spec.enforceSymmetricReturn && spec.symmetricReturnAddresses.length > 0) {
    value['nexthop-address-list'] = { entry: spec.symmetricReturnAddresses.map((name) => ({ '@name': name })) }
  }
  return value
}

/** Build the REST entry fields for a PBF pre-rule. */
export function buildPbfRuleFields(spec: PbfRuleSpec): Record<string, unknown> {
  const eff = effectiveMatch(spec)
  const fields: Record<string, unknown> = {
    from: { zone: { member: eff.fromZones } },
    source: { member: eff.source },
    destination: { member: eff.destination },
    application: { member: eff.application },
    service: { member: eff.service },
    action: buildPbfAction(spec),
    'enforce-symmetric-return': buildEnforceSymmetricReturn(spec),
    disabled: spec.disabled ? 'yes' : 'no',
  }
  if (spec.schedule) fields.schedule = spec.schedule
  if (spec.description) fields.description = spec.description
  return fields
}

export function pbfRuleUpsertSpecs(canvas: CanvasSnapshot): UpsertSpec[] {
  return extractPbfRuleSpecs(canvas)
    .filter((s) => s.name && ACTION_TYPES.includes(s.actionType as ActionType))
    .map((s) => ({ name: s.name, fields: buildPbfRuleFields(s) }))
}

function actionSummary(action: Record<string, unknown>): string {
  if ('discard' in action) return 'discard'
  if ('no-pbf' in action) return 'no_pbf'
  if ('forward-to-vsys' in action) return `forward_to_vsys:${str(action['forward-to-vsys'] as string)}`
  const forward = (action.forward ?? {}) as LiveForwardAction
  const nexthop = forward.nexthop
    ? nexthopSummary(forward.nexthop)
    : 'none'
  const monitor = forward.monitor
    ? `${str(forward.monitor['ip-address'])}|${str(forward.monitor.profile)}|${str(forward.monitor['disable-if-unreachable'])}`
    : 'none'
  return `forward:iface=${str(forward['egress-interface'])};nexthop=${nexthop};monitor=${monitor}`
}

function nexthopSummary(nexthop: { 'ip-address'?: string; fqdn?: string }): string {
  if (nexthop['ip-address']) return `ip:${str(nexthop['ip-address'])}`
  if (nexthop.fqdn) return `fqdn:${str(nexthop.fqdn)}`
  return 'none'
}

export function pbfRuleDriftDiffs(spec: PbfRuleSpec, entry: PanoramaEntry): DriftDiff[] {
  const diffs: DriftDiff[] = []
  const live = entry as LivePbfRule
  const eff = effectiveMatch(spec)

  const compareSet = (label: string, expected: string[], liveMember: string[] | undefined) => {
    const actual = Array.isArray(liveMember) ? liveMember : []
    if (!sameSet(actual, expected)) {
      diffs.push({ field: `${spec.name}.${label}`, expected: expected.join(', '), actual: actual.join(', ') || 'none', severity: 'info' })
    }
  }
  compareSet('from.zone', eff.fromZones, live.from?.zone?.member)
  compareSet('source', eff.source, live.source?.member)
  compareSet('destination', eff.destination, live.destination?.member)
  compareSet('application', eff.application, live.application?.member)
  compareSet('service', eff.service, live.service?.member)

  if (spec.schedule && str(live.schedule) !== spec.schedule) {
    diffs.push({ field: `${spec.name}.schedule`, expected: spec.schedule, actual: str(live.schedule) || 'not set', severity: 'info' })
  }

  const expectedAction = actionSummary(buildPbfAction(spec))
  const actualAction = actionSummary((live.action ?? {}) as Record<string, unknown>)
  if (expectedAction !== actualAction) {
    diffs.push({ field: `${spec.name}.action`, expected: expectedAction, actual: actualAction, severity: 'critical' })
  }

  const liveEsr = live['enforce-symmetric-return']
  const liveEsrEnabled = str(liveEsr?.enabled).toLowerCase() === 'yes'
  if (liveEsrEnabled !== spec.enforceSymmetricReturn) {
    diffs.push({ field: `${spec.name}.enforce-symmetric-return`, expected: String(spec.enforceSymmetricReturn), actual: String(liveEsrEnabled), severity: 'warning' })
  } else if (spec.enforceSymmetricReturn) {
    const rawEntries = liveEsr?.['nexthop-address-list']?.entry
    const entries = Array.isArray(rawEntries) ? rawEntries : rawEntries ? [rawEntries] : []
    const liveAddrs = entries.map((e) => str(e?.['@name'])).filter(Boolean)
    if (!sameSet(liveAddrs, spec.symmetricReturnAddresses)) {
      diffs.push({
        field: `${spec.name}.enforce-symmetric-return.nexthop-address-list`,
        expected: spec.symmetricReturnAddresses.join(', ') || 'none',
        actual: liveAddrs.join(', ') || 'none',
        severity: 'info',
      })
    }
  }

  const liveDisabled = str(live.disabled).toLowerCase() === 'yes'
  if (liveDisabled !== spec.disabled) {
    diffs.push({ field: `${spec.name}.disabled`, expected: String(spec.disabled), actual: String(liveDisabled), severity: 'info' })
  }
  return diffs
}

/**
 * Validate PBF rules: a name is required and unique across the canvas; the
 * action type and next-hop type are supported values; a forward action needs
 * an egress interface (and a next-hop value when a next-hop type is chosen);
 * and a forward-to-vsys action needs the target vsys name.
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
  for (const spec of extractPbfRuleSpecs(ctx.canvas)) {
    const prefix = spec.sectionName
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'PBF rule name is required', code: 'required' })
    }
    if (!ACTION_TYPES.includes(spec.actionType as ActionType)) {
      errors.push({ field: `${prefix}.action_type`, message: `Unsupported action "${spec.actionType}"`, code: 'invalid_action' })
    } else if (spec.actionType === 'forward') {
      if (!spec.egressInterface) {
        errors.push({ field: `${prefix}.egress_interface`, message: 'Forward action needs an egress interface', code: 'required' })
      }
      if (!NEXTHOP_TYPES.includes(spec.nexthopType as NexthopType)) {
        errors.push({ field: `${prefix}.nexthop_type`, message: `Unsupported next-hop type "${spec.nexthopType}"`, code: 'invalid_nexthop_type' })
      } else if (spec.nexthopType !== 'none' && !spec.nexthopValue) {
        errors.push({ field: `${prefix}.nexthop_value`, message: 'A next-hop type needs a next-hop value', code: 'required' })
      }
    } else if (spec.actionType === 'forward_to_vsys' && !spec.forwardToVsys) {
      errors.push({ field: `${prefix}.forward_to_vsys`, message: 'Forward-to-vsys action needs the target vsys name', code: 'required' })
    }
    if (spec.enforceSymmetricReturn && spec.symmetricReturnAddresses.length === 0) {
      warnings.push({ field: `${prefix}.symmetric_return_addresses`, message: 'Symmetric return is enabled with no eligible next-hop addresses listed', code: 'empty_return_list' })
    }
    if (spec.name) {
      const key = spec.name.toLowerCase()
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate PBF rule "${spec.name}"`, code: 'duplicate' })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
