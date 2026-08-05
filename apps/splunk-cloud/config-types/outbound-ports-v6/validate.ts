import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { splitList } from '../../lib/acs'
import { coercePort, isValidIpv6Cidr, isValidPort, normalizeSubnet } from '../../lib/cidr'

// --- IPv6 outbound port constraints (ACS access/outbound-ports-v6) ----------
//
// A SEPARATE ACS endpoint from the IPv4 "Outbound Ports" type — for a given
// source port the stack is permitted to open outbound IPv6 connections to the
// listed destination subnets. Docs: help.splunk.com …/configure-outbound-
// ports-for-splunk-cloud-platform (the IPv6 section: GET/POST
// access/outbound-ports-v6, GET/DELETE access/outbound-ports-v6/{port}; same
// body shape as v4, "one unique port per outbound port request").

/** ACS does not publish a hard limit; a generous per-port destination cap. */
export const LARGE_SUBNET_LIST_WARNING_THRESHOLD = 200

export interface OutboundPortV6Spec {
  sectionName: string
  port: number | null
  subnets: string[]
  removeUndeclared: boolean
  reason: string
}

/** Each canvas section describes the IPv6 destination subnets allowed for one port. */
export function extractOutboundPortV6Specs(canvas: CanvasSnapshot): OutboundPortV6Spec[] {
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
 * Validate IPv6 outbound port rules against ACS constraints: a valid TCP/UDP
 * port, IPv6 CIDR destination subnets, and safety warnings for overly-broad
 * egress destinations.
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
          message: `Duplicate port "${port}" — declare each port's IPv6 destinations in a single section`,
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
        message: 'At least one destination IPv6 subnet in CIDR notation is required',
        code: 'required',
      })
      continue
    }
    if (subnets.length > LARGE_SUBNET_LIST_WARNING_THRESHOLD) {
      warnings.push({
        field: `${prefix}.subnets`,
        message: `${subnets.length} destination subnets declared — ACS does not publish an explicit IPv6 limit, but this is a large list`,
        code: 'large_subnet_list',
      })
    }

    const seenSubnets = new Set<string>()
    for (const subnet of subnets) {
      if (subnet.includes('.') && !subnet.includes(':')) {
        errors.push({
          field: `${prefix}.subnets`,
          message: `"${subnet}" — IPv4 destinations are not supported by this type (manage them with the "Outbound Ports" configuration type)`,
          code: 'invalid_cidr',
        })
        continue
      }
      if (!isValidIpv6Cidr(subnet)) {
        errors.push({
          field: `${prefix}.subnets`,
          message: `"${subnet}" is not valid IPv6 CIDR notation (e.g. 2001:db8::/32)`,
          code: 'invalid_cidr',
        })
        continue
      }
      if (subnet === '::/0') {
        warnings.push({
          field: `${prefix}.subnets`,
          message: '::/0 permits outbound connections to the entire IPv6 internet — scope to specific destinations if possible',
          code: 'open_egress',
        })
      } else {
        const p = Number(subnet.split('/')[1])
        if (p < 32) {
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
