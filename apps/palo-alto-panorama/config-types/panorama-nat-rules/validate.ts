import type { CanvasSnapshot, DriftDiff, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { coerceBoolean, sameSet, splitList, type PanoramaEntry, type UpsertSpec } from '../../lib/panorama'

// Panorama NAT rules live in the device-group PRE rulebase (evaluated before
// firewall-local rules). Shared pre-rules are also valid at location=shared.
export const RESOURCE_PATH = '/Policies/NATPreRules'

/** Source-translation strategies modeled here (IPv4 NAT). */
export const SRC_XLATE_TYPES = ['none', 'dynamic-ip-and-port', 'dynamic-ip', 'static-ip'] as const
export type SrcXlateType = (typeof SRC_XLATE_TYPES)[number]

/** Port range for translated destination port. */
const PORT_RE = /^\d{1,5}$/

export interface NatRuleSpec {
  sectionName: string
  name: string
  fromZones: string[]
  toZones: string[]
  source: string[]
  destination: string[]
  service: string
  toInterface: string
  srcXlateType: string
  srcTranslatedAddresses: string[]
  srcTranslationInterface: string
  srcTranslationInterfaceIp: string
  srcStaticTranslatedAddress: string
  biDirectional: boolean
  destTranslatedAddress: string
  destTranslatedPort: string
  disabled: boolean
  description: string
}

interface LiveSourceTranslation {
  'dynamic-ip-and-port'?: {
    'translated-address'?: { member?: string[] }
    'interface-address'?: { interface?: string; ip?: string }
  }
  'dynamic-ip'?: { 'translated-address'?: { member?: string[] } }
  'static-ip'?: { 'translated-address'?: string; 'bi-directional'?: string }
}

interface LiveDestinationTranslation {
  'translated-address'?: string
  'translated-port'?: string | number
}

export interface LiveNatRule extends PanoramaEntry {
  from?: { member?: string[] }
  to?: { member?: string[] }
  source?: { member?: string[] }
  destination?: { member?: string[] }
  service?: string
  'to-interface'?: string
  'source-translation'?: LiveSourceTranslation
  'destination-translation'?: LiveDestinationTranslation
  disabled?: string
  description?: string
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function orDefault(list: string[], fallback: string[]): string[] {
  return list.length > 0 ? list : fallback
}

export function extractNatRuleSpecs(canvas: CanvasSnapshot): NatRuleSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: str(fields.name),
      fromZones: splitList(fields.from_zones),
      toZones: splitList(fields.to_zones),
      source: splitList(fields.source),
      destination: splitList(fields.destination),
      service: str(fields.service) || 'any',
      toInterface: str(fields.to_interface),
      srcXlateType: str(fields.source_translation_type) || 'none',
      srcTranslatedAddresses: splitList(fields.source_translated_addresses),
      srcTranslationInterface: str(fields.source_translation_interface),
      srcTranslationInterfaceIp: str(fields.source_translation_interface_ip),
      srcStaticTranslatedAddress: str(fields.source_static_translated_address),
      biDirectional: coerceBoolean(fields.bi_directional, false),
      destTranslatedAddress: str(fields.destination_translated_address),
      destTranslatedPort: str(fields.destination_translated_port),
      disabled: coerceBoolean(fields.disabled, false),
      description: str(fields.description),
    }
  })
}

/** The effective (defaulted) match fields, shared by build + drift. */
export function effectiveMatch(spec: NatRuleSpec) {
  return {
    from: orDefault(spec.fromZones, ['any']),
    to: orDefault(spec.toZones, ['any']),
    source: orDefault(spec.source, ['any']),
    destination: orDefault(spec.destination, ['any']),
    service: spec.service || 'any',
  }
}

/** Is the chosen source-translation strategy fully specified (deployable)? */
export function srcTranslationComplete(spec: NatRuleSpec): boolean {
  switch (spec.srcXlateType) {
    case 'none':
      return true
    case 'dynamic-ip-and-port':
      return spec.srcTranslationInterface.length > 0 || spec.srcTranslatedAddresses.length > 0
    case 'dynamic-ip':
      return spec.srcTranslatedAddresses.length > 0
    case 'static-ip':
      return spec.srcStaticTranslatedAddress.length > 0
    default:
      return false
  }
}

/** Build the source-translation REST object, or null when there is none. */
export function buildSourceTranslation(spec: NatRuleSpec): Record<string, unknown> | null {
  switch (spec.srcXlateType) {
    case 'dynamic-ip-and-port': {
      if (spec.srcTranslationInterface) {
        const ifaceAddr: Record<string, unknown> = { interface: spec.srcTranslationInterface }
        if (spec.srcTranslationInterfaceIp) ifaceAddr.ip = spec.srcTranslationInterfaceIp
        return { 'dynamic-ip-and-port': { 'interface-address': ifaceAddr } }
      }
      if (spec.srcTranslatedAddresses.length > 0) {
        return { 'dynamic-ip-and-port': { 'translated-address': { member: spec.srcTranslatedAddresses } } }
      }
      return null
    }
    case 'dynamic-ip':
      if (spec.srcTranslatedAddresses.length > 0) {
        return { 'dynamic-ip': { 'translated-address': { member: spec.srcTranslatedAddresses } } }
      }
      return null
    case 'static-ip': {
      if (!spec.srcStaticTranslatedAddress) return null
      const staticIp: Record<string, unknown> = { 'translated-address': spec.srcStaticTranslatedAddress }
      if (spec.biDirectional) staticIp['bi-directional'] = 'yes'
      return { 'static-ip': staticIp }
    }
    default:
      return null
  }
}

/** Build the destination-translation REST object, or null when there is none. */
export function buildDestinationTranslation(spec: NatRuleSpec): Record<string, unknown> | null {
  if (!spec.destTranslatedAddress) return null
  const dt: Record<string, unknown> = { 'translated-address': spec.destTranslatedAddress }
  if (spec.destTranslatedPort) dt['translated-port'] = Number(spec.destTranslatedPort)
  return dt
}

/** Build the REST entry fields for a NAT pre-rule. */
export function buildNatRuleFields(spec: NatRuleSpec): Record<string, unknown> {
  const eff = effectiveMatch(spec)
  const fields: Record<string, unknown> = {
    'nat-type': 'ipv4',
    from: { member: eff.from },
    to: { member: eff.to },
    source: { member: eff.source },
    destination: { member: eff.destination },
    service: eff.service,
    disabled: spec.disabled ? 'yes' : 'no',
  }
  if (spec.toInterface) fields['to-interface'] = spec.toInterface
  if (spec.description) fields.description = spec.description
  const srcXlate = buildSourceTranslation(spec)
  if (srcXlate) fields['source-translation'] = srcXlate
  const destXlate = buildDestinationTranslation(spec)
  if (destXlate) fields['destination-translation'] = destXlate
  return fields
}

export function natRuleUpsertSpecs(canvas: CanvasSnapshot): UpsertSpec[] {
  return extractNatRuleSpecs(canvas)
    .filter((s) => s.name && SRC_XLATE_TYPES.includes(s.srcXlateType as SrcXlateType) && srcTranslationComplete(s))
    .map((s) => ({ name: s.name, fields: buildNatRuleFields(s) }))
}

// --- Drift: normalized translation summaries (order-insensitive) -------------

function sortedJoin(list: string[]): string {
  return [...list].sort().join(',')
}

export function srcXlateSummary(spec: NatRuleSpec): string {
  switch (spec.srcXlateType) {
    case 'dynamic-ip-and-port':
      if (spec.srcTranslationInterface) {
        return `dipp:iface=${spec.srcTranslationInterface}${spec.srcTranslationInterfaceIp ? `:${spec.srcTranslationInterfaceIp}` : ''}`
      }
      return `dipp:addr=${sortedJoin(spec.srcTranslatedAddresses)}`
    case 'dynamic-ip':
      return `dip:addr=${sortedJoin(spec.srcTranslatedAddresses)}`
    case 'static-ip':
      return `static:${spec.srcStaticTranslatedAddress}${spec.biDirectional ? ':bidir' : ''}`
    default:
      return 'none'
  }
}

function liveSrcXlateSummary(xlate: LiveSourceTranslation | undefined): string {
  if (!xlate) return 'none'
  if (xlate['dynamic-ip-and-port']) {
    const dipp = xlate['dynamic-ip-and-port']
    if (dipp['interface-address']) {
      const ia = dipp['interface-address']
      return `dipp:iface=${str(ia.interface)}${ia.ip ? `:${str(ia.ip)}` : ''}`
    }
    const addrs = Array.isArray(dipp['translated-address']?.member) ? (dipp['translated-address']!.member as string[]) : []
    return `dipp:addr=${sortedJoin(addrs)}`
  }
  if (xlate['dynamic-ip']) {
    const addrs = Array.isArray(xlate['dynamic-ip']['translated-address']?.member) ? (xlate['dynamic-ip']['translated-address']!.member as string[]) : []
    return `dip:addr=${sortedJoin(addrs)}`
  }
  if (xlate['static-ip']) {
    const s = xlate['static-ip']
    const bidir = str(s['bi-directional']).toLowerCase() === 'yes'
    return `static:${str(s['translated-address'])}${bidir ? ':bidir' : ''}`
  }
  return 'none'
}

export function destXlateSummary(spec: NatRuleSpec): string {
  if (!spec.destTranslatedAddress) return 'none'
  return `${spec.destTranslatedAddress}${spec.destTranslatedPort ? `:${spec.destTranslatedPort}` : ''}`
}

function liveDestXlateSummary(xlate: LiveDestinationTranslation | undefined): string {
  if (!xlate || !str(xlate['translated-address'])) return 'none'
  const port = xlate['translated-port']
  const portStr = port === undefined || port === null || port === '' ? '' : `:${String(port)}`
  return `${str(xlate['translated-address'])}${portStr}`
}

export function natRuleDriftDiffs(spec: NatRuleSpec, entry: PanoramaEntry): DriftDiff[] {
  const diffs: DriftDiff[] = []
  const live = entry as LiveNatRule
  const eff = effectiveMatch(spec)

  const compareSet = (label: string, expected: string[], liveMember: string[] | undefined) => {
    const actual = Array.isArray(liveMember) ? liveMember : []
    if (!sameSet(actual, expected)) {
      diffs.push({ field: `${spec.name}.${label}`, expected: expected.join(', '), actual: actual.join(', ') || 'none', severity: 'info' })
    }
  }
  compareSet('from', eff.from, live.from?.member)
  compareSet('to', eff.to, live.to?.member)
  compareSet('source', eff.source, live.source?.member)
  compareSet('destination', eff.destination, live.destination?.member)

  if (str(live.service) !== eff.service) {
    diffs.push({ field: `${spec.name}.service`, expected: eff.service, actual: str(live.service) || 'not set', severity: 'warning' })
  }

  const expectedSrc = srcXlateSummary(spec)
  const actualSrc = liveSrcXlateSummary(live['source-translation'])
  if (expectedSrc !== actualSrc) {
    diffs.push({ field: `${spec.name}.source-translation`, expected: expectedSrc, actual: actualSrc, severity: 'warning' })
  }

  const expectedDest = destXlateSummary(spec)
  const actualDest = liveDestXlateSummary(live['destination-translation'])
  if (expectedDest !== actualDest) {
    diffs.push({ field: `${spec.name}.destination-translation`, expected: expectedDest, actual: actualDest, severity: 'warning' })
  }

  const liveDisabled = str(live.disabled).toLowerCase() === 'yes'
  if (liveDisabled !== spec.disabled) {
    diffs.push({ field: `${spec.name}.disabled`, expected: String(spec.disabled), actual: String(liveDisabled), severity: 'info' })
  }
  return diffs
}

/**
 * Validate NAT pre-rules: a name is required and unique across the canvas; the
 * source-translation strategy is supported and fully specified for the chosen
 * type; and a translated destination port (when set) is a valid port needing a
 * translated destination address. Zones/source/destination default to "any" and
 * service to "any" when left blank.
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
  for (const spec of extractNatRuleSpecs(ctx.canvas)) {
    const prefix = spec.sectionName
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'NAT rule name is required', code: 'required' })
    }

    if (!SRC_XLATE_TYPES.includes(spec.srcXlateType as SrcXlateType)) {
      errors.push({ field: `${prefix}.source_translation_type`, message: `Unsupported source translation "${spec.srcXlateType}"`, code: 'invalid_src_translation' })
    } else if (spec.srcXlateType === 'dynamic-ip-and-port' && !srcTranslationComplete(spec)) {
      errors.push({ field: `${prefix}.source_translated_addresses`, message: 'Dynamic IP and Port needs translated addresses or a translation interface', code: 'required' })
    } else if (spec.srcXlateType === 'dynamic-ip' && !srcTranslationComplete(spec)) {
      errors.push({ field: `${prefix}.source_translated_addresses`, message: 'Dynamic IP needs at least one translated address', code: 'required' })
    } else if (spec.srcXlateType === 'static-ip' && !srcTranslationComplete(spec)) {
      errors.push({ field: `${prefix}.source_static_translated_address`, message: 'Static IP needs a translated address', code: 'required' })
    }

    if (spec.biDirectional && spec.srcXlateType !== 'static-ip') {
      warnings.push({ field: `${prefix}.bi_directional`, message: 'Bi-directional applies only to Static IP source translation — it will be ignored', code: 'ignored_bidirectional' })
    }

    if (spec.destTranslatedPort) {
      if (!PORT_RE.test(spec.destTranslatedPort) || Number(spec.destTranslatedPort) < 1 || Number(spec.destTranslatedPort) > 65535) {
        errors.push({ field: `${prefix}.destination_translated_port`, message: `Invalid translated port "${spec.destTranslatedPort}" — use 1-65535`, code: 'invalid_port' })
      }
      if (!spec.destTranslatedAddress) {
        errors.push({ field: `${prefix}.destination_translated_address`, message: 'A translated destination port needs a translated destination address', code: 'required' })
      }
    }

    if (spec.name) {
      const key = spec.name.toLowerCase()
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate NAT rule "${spec.name}"`, code: 'duplicate' })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
