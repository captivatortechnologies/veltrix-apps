import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { coerceBoolean } from '../../lib/falcon'

// --- Firewall Rule Group API constraints (fwmgr service) ----------------------
//
// Firewall rule groups live on the /fwmgr/ service, NOT the /policy/ family, so
// they are managed with direct FalconClient calls (no policy adapter). Rules are
// embedded in and managed through the group, mirroring custom-ioa-rule-groups.

/** platform is lowercase in the fwmgr rule-group API and immutable after creation. */
export const FIREWALL_RG_PLATFORMS = ['windows', 'mac', 'linux'] as const

/** Rule action values accepted by the firewall rule API. */
export const FIREWALL_ACTIONS = ['ALLOW', 'DENY'] as const

/** Rule direction values accepted by the firewall rule API. */
export const FIREWALL_DIRECTIONS = ['IN', 'OUT', 'BOTH'] as const

/**
 * Friendly protocol name → the numeric IANA string the fwmgr API stores.
 * ICMP is accepted as an alias for ICMPV4; ANY maps to the "*" wildcard.
 */
export const FIREWALL_PROTOCOL_WIRE: Record<string, string> = {
  TCP: '6',
  UDP: '17',
  ICMP: '1',
  ICMPV4: '1',
  ICMPV6: '58',
  IGMP: '2',
  'IP-IN-IP': '4',
  GRE: '47',
  ESP: '50',
  'IPV6 ENCAPSULATION': '41',
  ANY: '*',
}

/** Address family friendly values; ANY is stored as "NONE" by the API. */
export const FIREWALL_ADDRESS_FAMILIES = ['IP4', 'IP6', 'ANY'] as const

export const MAX_RULE_GROUP_NAME_LENGTH = 255

/** Map a friendly address family to the wire value the fwmgr API expects. */
export function addressFamilyWire(family: string): string {
  return family === 'ANY' ? 'NONE' : family
}

// --- Spec extraction shared by deploy / rollback / healthCheck / drift -------

/** A single port range as the fwmgr API expects it (end 0 means "single port = start"). */
export interface FirewallPortRange {
  start: number
  end: number
}

/** A single address entry as the fwmgr API expects it. */
export interface FirewallAddress {
  address: string
  netmask: number
}

/** One firewall rule, normalized to the values the fwmgr API stores. */
export interface FirewallRuleSpec {
  name: string
  description?: string
  enabled: boolean
  log: boolean
  monitor: boolean
  action: string
  direction: string
  /** Friendly protocol name (uppercased) — kept for messages. */
  protocol: string
  /** Numeric IANA protocol string the API stores. */
  protocolWire: string
  /** Wire address family: IP4 | IP6 | NONE. */
  addressFamily: string
  localPorts: FirewallPortRange[]
  remotePorts: FirewallPortRange[]
  localAddresses: FirewallAddress[]
  remoteAddresses: FirewallAddress[]
  icmpType?: string
  icmpCode?: string
  networkLocation: string
}

export interface FirewallRuleGroupSpec {
  sectionName: string
  name: string
  platform: string
  description?: string
  enabled: boolean
  rulesRaw?: string
}

/** Shape of a rule embedded in a group returned by GET /fwmgr/entities/rule-groups/v1. */
export interface LiveFirewallRule {
  id?: string
  name?: string
  description?: string
  enabled?: boolean
  action?: string
  direction?: string
  protocol?: string
  address_family?: string
  local_port?: FirewallPortRange[]
  remote_port?: FirewallPortRange[]
  local_address?: FirewallAddress[]
  remote_address?: FirewallAddress[]
  icmp?: { icmp_type?: string; icmp_code?: string }
  fields?: Array<{ name?: string; type?: string; value?: string; values?: string[] }>
  version?: number
  [key: string]: unknown
}

/** Shape of a rule group returned by GET /fwmgr/entities/rule-groups/v1. */
export interface LiveFirewallRuleGroup {
  id?: string
  name?: string
  description?: string
  platform?: string
  enabled?: boolean
  rules?: LiveFirewallRule[]
  /** Optimistic-concurrency token echoed back on every diff PATCH. */
  tracking?: string
  version?: number
  /** Last modifier recorded by Falcon — used for drift attribution. */
  modified_by?: string
  modified_on?: string
  modified_timestamp?: string
  // Index signature keeps this compatible with attachDriftActor's structural read.
  [key: string]: unknown
}

/** Each canvas section describes one firewall rule group. */
export function extractRuleGroupSpecs(canvas: CanvasSnapshot): FirewallRuleGroupSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const rawPlatform =
      typeof fields.platform === 'string' ? fields.platform.trim().toLowerCase() : 'windows'
    const platform =
      (FIREWALL_RG_PLATFORMS as readonly string[]).find((p) => p === rawPlatform) ?? rawPlatform

    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      platform,
      description:
        typeof fields.description === 'string' && fields.description.trim()
          ? fields.description.trim()
          : undefined,
      enabled: coerceBoolean(fields.enabled, false),
      rulesRaw:
        typeof fields.rules === 'string' && fields.rules.trim() ? fields.rules.trim() : undefined,
    }
  })
}

/** Parse one port-range entry (a bare number is a single port). */
function parsePort(entry: unknown): FirewallPortRange | string {
  if (typeof entry === 'number') {
    if (!Number.isInteger(entry) || entry < 1 || entry > 65535) return 'port must be an integer 1-65535'
    return { start: entry, end: 0 }
  }
  if (typeof entry === 'object' && entry !== null && !Array.isArray(entry)) {
    const { start, end } = entry as { start?: unknown; end?: unknown }
    if (!Number.isInteger(start) || (start as number) < 1 || (start as number) > 65535) {
      return '"start" must be an integer 1-65535'
    }
    const endNum = end === undefined ? 0 : end
    if (!Number.isInteger(endNum) || (endNum as number) < 0 || (endNum as number) > 65535) {
      return '"end" must be an integer 0-65535 (0 = single port)'
    }
    return { start: start as number, end: endNum as number }
  }
  return 'port must be a number or a {start, end} object'
}

/** Parse one address entry ({address, netmask?}). */
function parseAddress(entry: unknown): FirewallAddress | string {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    return 'address must be a {address, netmask} object'
  }
  const { address, netmask } = entry as { address?: unknown; netmask?: unknown }
  if (typeof address !== 'string' || !address.trim()) return '"address" must be a non-empty string'
  const maskNum = netmask === undefined ? 0 : netmask
  if (!Number.isInteger(maskNum) || (maskNum as number) < 0 || (maskNum as number) > 128) {
    return '"netmask" must be an integer 0-128'
  }
  return { address: address.trim(), netmask: maskNum as number }
}

/**
 * Parse and structurally validate the rules JSON. Each entry needs a unique
 * name, an action (ALLOW/DENY), a direction (IN/OUT/BOTH), and a known protocol.
 * Ports, addresses, ICMP type/code, and network location are optional.
 */
export function parseFirewallRules(raw: string | undefined): {
  rules: FirewallRuleSpec[]
  errors: string[]
} {
  if (!raw) return { rules: [], errors: [] }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return {
      rules: [],
      errors: [`Rules is not valid JSON: ${error instanceof Error ? error.message : 'parse error'}`],
    }
  }

  if (!Array.isArray(parsed)) {
    return { rules: [], errors: ['Rules must be a JSON array of rule objects'] }
  }

  const rules: FirewallRuleSpec[] = []
  const errors: string[] = []
  const seenNames = new Set<string>()

  parsed.forEach((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      errors.push(`Rule #${index + 1}: must be an object`)
      return
    }
    const e = entry as Record<string, unknown>

    const name = typeof e.name === 'string' ? e.name.trim() : ''
    if (!name) {
      errors.push(`Rule #${index + 1}: "name" must be a non-empty string`)
      return
    }
    if (seenNames.has(name.toLowerCase())) {
      errors.push(`Rule "${name}": declared more than once`)
      return
    }
    seenNames.add(name.toLowerCase())

    const action = typeof e.action === 'string' ? e.action.trim().toUpperCase() : ''
    if (!(FIREWALL_ACTIONS as readonly string[]).includes(action)) {
      errors.push(`Rule "${name}": "action" must be one of ${FIREWALL_ACTIONS.join(', ')}`)
      return
    }

    const direction = typeof e.direction === 'string' ? e.direction.trim().toUpperCase() : ''
    if (!(FIREWALL_DIRECTIONS as readonly string[]).includes(direction)) {
      errors.push(`Rule "${name}": "direction" must be one of ${FIREWALL_DIRECTIONS.join(', ')}`)
      return
    }

    const protocol = typeof e.protocol === 'string' ? e.protocol.trim().toUpperCase() : ''
    if (!Object.prototype.hasOwnProperty.call(FIREWALL_PROTOCOL_WIRE, protocol)) {
      errors.push(
        `Rule "${name}": "protocol" must be one of ${Object.keys(FIREWALL_PROTOCOL_WIRE).join(', ')}`,
      )
      return
    }

    const rawFamily =
      typeof e.addressFamily === 'string' && e.addressFamily.trim()
        ? e.addressFamily.trim().toUpperCase()
        : 'ANY'
    if (!(FIREWALL_ADDRESS_FAMILIES as readonly string[]).includes(rawFamily)) {
      errors.push(`Rule "${name}": "addressFamily" must be one of ${FIREWALL_ADDRESS_FAMILIES.join(', ')}`)
      return
    }

    const localPorts = collectRanges(e.localPorts, name, 'localPorts', errors)
    const remotePorts = collectRanges(e.remotePorts, name, 'remotePorts', errors)
    const localAddresses = collectAddresses(e.localAddresses, name, 'localAddresses', errors)
    const remoteAddresses = collectAddresses(e.remoteAddresses, name, 'remoteAddresses', errors)
    if (localPorts === null || remotePorts === null || localAddresses === null || remoteAddresses === null) {
      return
    }

    rules.push({
      name,
      description:
        typeof e.description === 'string' && e.description.trim() ? e.description.trim() : undefined,
      enabled: coerceBoolean(e.enabled, true),
      log: coerceBoolean(e.log, false),
      monitor: coerceBoolean(e.monitor, false),
      action,
      direction,
      protocol,
      protocolWire: FIREWALL_PROTOCOL_WIRE[protocol],
      addressFamily: addressFamilyWire(rawFamily),
      localPorts,
      remotePorts,
      localAddresses,
      remoteAddresses,
      icmpType: typeof e.icmpType === 'string' && e.icmpType.trim() ? e.icmpType.trim() : undefined,
      icmpCode: typeof e.icmpCode === 'string' && e.icmpCode.trim() ? e.icmpCode.trim() : undefined,
      networkLocation:
        typeof e.networkLocation === 'string' && e.networkLocation.trim()
          ? e.networkLocation.trim()
          : 'ANY',
    })
  })

  return { rules, errors }
}

/** Parse a port-range array; pushes messages and returns null on any error. */
function collectRanges(
  value: unknown,
  ruleName: string,
  field: string,
  errors: string[],
): FirewallPortRange[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    errors.push(`Rule "${ruleName}": "${field}" must be an array`)
    return null
  }
  const out: FirewallPortRange[] = []
  for (const entry of value) {
    const parsed = parsePort(entry)
    if (typeof parsed === 'string') {
      errors.push(`Rule "${ruleName}": ${field} — ${parsed}`)
      return null
    }
    out.push(parsed)
  }
  return out
}

/** Parse an address array; pushes messages and returns null on any error. */
function collectAddresses(
  value: unknown,
  ruleName: string,
  field: string,
  errors: string[],
): FirewallAddress[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    errors.push(`Rule "${ruleName}": "${field}" must be an array`)
    return null
  }
  const out: FirewallAddress[] = []
  for (const entry of value) {
    const parsed = parseAddress(entry)
    if (typeof parsed === 'string') {
      errors.push(`Rule "${ruleName}": ${field} — ${parsed}`)
      return null
    }
    out.push(parsed)
  }
  return out
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate firewall rule group configurations against the fwmgr rule-group API
 * constraints: naming, platform, and the embedded rules model (action,
 * direction, protocol, address family, ports, addresses).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractRuleGroupSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Rule group name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_RULE_GROUP_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `Rule group name must be ${MAX_RULE_GROUP_NAME_LENGTH} characters or fewer`,
          code: 'max_length',
        })
      }
      const key = `${spec.platform}:${spec.name.toLowerCase()}`
      if (seenNames.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate rule group "${spec.name}" for platform ${spec.platform} — each group may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seenNames.add(key)
    }

    // platform — lowercase, immutable after creation
    if (!(FIREWALL_RG_PLATFORMS as readonly string[]).includes(spec.platform)) {
      errors.push({
        field: `${prefix}.platform`,
        message: `Platform must be one of: ${FIREWALL_RG_PLATFORMS.join(', ')}`,
        code: 'invalid_platform',
      })
    }

    // rules JSON
    const { rules, errors: ruleErrors } = parseFirewallRules(spec.rulesRaw)
    for (const message of ruleErrors) {
      errors.push({ field: `${prefix}.rules`, message, code: 'invalid_rules' })
    }

    // an enabled group with no rules enforces nothing
    if (spec.enabled && ruleErrors.length === 0 && rules.length === 0) {
      warnings.push({
        field: `${prefix}.rules`,
        message: 'Rule group is enabled but declares no rules — it will not enforce anything',
        code: 'no_rules',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
