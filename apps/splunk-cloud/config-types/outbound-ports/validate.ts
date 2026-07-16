import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { splitList } from '../../lib/acs'
import { coercePort, isValidIpv4Cidr, isValidPort, normalizeSubnet, cidrPrefix } from '../../lib/cidr'

// --- Outbound port constraints (ACS access/outbound-ports) -------------------
//
// ACS manages outbound connectivity rules: for a given source port the stack is
// permitted to open outbound connections to the listed destination subnets.
// Docs: /adminconfig/v2/access/outbound-ports (IPv4). IPv6 uses the separate
// access/outbound-ports-v6 endpoint, which this app version does not manage.

/** A generous per-port destination-subnet cap (ACS does not publish a hard limit). */
export const MAX_SUBNETS_PER_PORT = 200

export interface OutboundPortSpec {
  sectionName: string
  port: number | null
  subnets: string[]
  removeUndeclared: boolean
  reason: string
}

/** Each canvas section describes the destination subnets allowed for one port. */
export function extractOutboundPortSpecs(canvas: CanvasSnapshot): OutboundPortSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      port: coercePort(fields.port),
      subnets: splitList(fields.subnets).map(normalizeSubnet),
      removeUndeclared: fields.removeUndeclared === true,
      reason: typeof fields.reason === 'string' ? fields.reason.trim() : '',
    }
  })
}

/**
 * Validate outbound port rules against ACS constraints: a valid TCP/UDP port,
 * IPv4 CIDR destination subnets, per-port subnet limits, and safety warnings for
 * overly-broad egress destinations.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const seenPorts = new Set<number>()

  for (const section of sections) {
    const fields = section.fields || {}
    const prefix = section.name

    // Port
    const port = coercePort(fields.port)
    if (port === null) {
      errors.push({ field: `${prefix}.port`, message: 'Port is required', code: 'required' })
    } else if (!isValidPort(port)) {
      errors.push({
        field: `${prefix}.port`,
        message: `"${port}" is not a valid port — use an integer 1–65535`,
        code: 'invalid_port',
      })
    } else {
      if (seenPorts.has(port)) {
        errors.push({
          field: `${prefix}.port`,
          message: `Duplicate port "${port}" — declare each port's destinations in a single section`,
          code: 'duplicate_port',
        })
      }
      seenPorts.add(port)
    }

    // Destination subnets
    const subnets = splitList(fields.subnets)
    if (subnets.length === 0) {
      errors.push({
        field: `${prefix}.subnets`,
        message: 'At least one destination subnet in CIDR notation is required',
        code: 'required',
      })
      continue
    }
    if (subnets.length > MAX_SUBNETS_PER_PORT) {
      errors.push({
        field: `${prefix}.subnets`,
        message: `At most ${MAX_SUBNETS_PER_PORT} destination subnets per port (got ${subnets.length})`,
        code: 'subnet_limit',
      })
    }

    const seenSubnets = new Set<string>()
    for (const subnet of subnets) {
      if (subnet.includes(':')) {
        errors.push({
          field: `${prefix}.subnets`,
          message: `"${subnet}" — IPv6 destinations are not supported by this app version (manage outbound-ports-v6 directly via ACS)`,
          code: 'invalid_cidr',
        })
        continue
      }
      if (!isValidIpv4Cidr(subnet)) {
        errors.push({
          field: `${prefix}.subnets`,
          message: `"${subnet}" is not valid IPv4 CIDR notation (e.g. 34.226.34.80/32)`,
          code: 'invalid_cidr',
        })
        continue
      }
      // Egress to anywhere is valid but broad — warn rather than block.
      if (subnet === '0.0.0.0/0') {
        warnings.push({
          field: `${prefix}.subnets`,
          message: '0.0.0.0/0 permits outbound connections to the entire internet — scope to specific destinations if possible',
          code: 'open_egress',
        })
      } else {
        const p = cidrPrefix(subnet)
        if (p !== null && p < 8) {
          warnings.push({
            field: `${prefix}.subnets`,
            message: `"${subnet}" is a very broad destination range (/${p}) — confirm this is intentional`,
            code: 'broad_egress',
          })
        }
      }
      if (seenSubnets.has(subnet)) {
        warnings.push({
          field: `${prefix}.subnets`,
          message: `Duplicate destination subnet "${subnet}"`,
          code: 'duplicate_subnet',
        })
      }
      seenSubnets.add(subnet)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
