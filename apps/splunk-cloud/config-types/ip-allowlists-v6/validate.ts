import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { splitList } from '../../lib/acs'
import { isValidIpv6Cidr } from '../../lib/cidr'

// --- ACS IPv6 allow list constraints ----------------------------------------
//
// ACS manages IPv6 allow lists on a SEPARATE endpoint from IPv4 —
// /adminconfig/v2/access/{feature}/ipallowlists-v6 — with the same seven
// features as the v4 type (search-api, hec, s2s, search-ui, idm-ui, idm-api,
// acs). This is a distinct resource, not a variant of the v4 one: Splunk's own
// `terraform-provider-scp` models it as its own resource (`scp_ip_v6_allowlists`),
// with two quirks not shared by v4:
//   - the ENTIRE resource cannot be deleted via ACS (only individual subnets)
//   - a reconcile that would remove every live subnet in one request is
//     rejected — at least one pre-existing subnet must remain until a
//     follow-up call finishes the removal (see deploy.ts)
// Docs: help.splunk.com …/configure-ip-allow-lists-for-splunk-cloud-platform
//   (#Configure_IP_allow_lists_for_IPv6); github.com/splunk/terraform-provider-scp
//   docs/resources/ipv6_allowlists.md

/** Features that support IP allow lists via ACS (same set as IPv4). */
export const ALLOWLIST_FEATURES = [
  'search-api',
  'hec',
  's2s',
  'search-ui',
  'idm-ui',
  'idm-api',
  'acs',
] as const
export type AllowlistFeature = (typeof ALLOWLIST_FEATURES)[number]

/**
 * ACS does not publish an explicit maximum subnet count for the v6 endpoint in
 * the sources reviewed (unlike v4's documented 200/feature) — a very large list
 * warns rather than errors, so a real limit encountered at deploy time surfaces
 * from ACS itself rather than being silently rejected on a guess.
 */
export const LARGE_SUBNET_LIST_WARNING_THRESHOLD = 200

/** Normalize a subnet from an ACS response (strips list markers/whitespace). */
export function normalizeSubnet(value: string): string {
  return value.replace(/^[\s:]+/, '').trim()
}

// --- Spec extraction shared by deploy / rollback / healthCheck / drift ------

export interface AllowlistV6Spec {
  sectionName: string
  feature: string
  subnets: string[]
  removeUndeclared: boolean
}

/** Each canvas section describes the IPv6 allow list for one feature. */
export function extractAllowlistV6Specs(canvas: CanvasSnapshot): AllowlistV6Spec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      feature: typeof fields.feature === 'string' ? fields.feature.trim() : '',
      subnets: splitList(fields.subnets).map(normalizeSubnet),
      removeUndeclared: fields.removeUndeclared === true,
    }
  })
}

// --- Validate handler --------------------------------------------------------

/**
 * Validate IPv6 IP allow list configurations against ACS constraints:
 * supported feature names, IPv6 CIDR notation, and safety rails against
 * overly-broad subnets or ACS lockout.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const seenFeatures = new Set<string>()

  for (const section of sections) {
    const fields = section.fields || {}
    const prefix = section.name

    // Feature
    const feature = fields.feature as string | undefined
    if (!feature || typeof feature !== 'string' || feature.trim() === '') {
      errors.push({ field: `${prefix}.feature`, message: 'Feature is required', code: 'required' })
    } else {
      const trimmed = feature.trim()
      if (!(ALLOWLIST_FEATURES as readonly string[]).includes(trimmed)) {
        errors.push({
          field: `${prefix}.feature`,
          message: `"${trimmed}" is not a supported feature — use one of: ${ALLOWLIST_FEATURES.join(', ')}`,
          code: 'invalid_feature',
        })
      }
      if (seenFeatures.has(trimmed)) {
        errors.push({
          field: `${prefix}.feature`,
          message: `Duplicate feature "${trimmed}" — declare each feature's IPv6 allow list in a single section`,
          code: 'duplicate_feature',
        })
      }
      seenFeatures.add(trimmed)

      // Lockout protection: removing subnets from the acs feature can cut off
      // this app's own access (and yours) — same rationale as the v4 type.
      if (trimmed === 'acs' && fields.removeUndeclared === true) {
        warnings.push({
          field: `${prefix}.removeUndeclared`,
          message:
            'Removing undeclared subnets from the "acs" allow list can lock you (and this app) out of the ACS API — this app will skip removals for the acs feature',
          code: 'acs_lockout_risk',
        })
      }
    }

    // Subnets
    const subnets = splitList(fields.subnets)
    if (subnets.length === 0) {
      errors.push({
        field: `${prefix}.subnets`,
        message: 'At least one IPv6 subnet in CIDR notation is required',
        code: 'required',
      })
      continue
    }
    if (subnets.length > LARGE_SUBNET_LIST_WARNING_THRESHOLD) {
      warnings.push({
        field: `${prefix}.subnets`,
        message: `${subnets.length} subnets declared — ACS does not publish an explicit IPv6 limit, but this is a large list; a stack-side rejection surfaces at deploy time`,
        code: 'large_subnet_list',
      })
    }

    const seenSubnets = new Set<string>()
    for (const subnet of subnets) {
      if (subnet.includes('.') && !subnet.includes(':')) {
        errors.push({
          field: `${prefix}.subnets`,
          message: `"${subnet}" — IPv4 subnets are not supported by this type (manage them with the "IP Allow Lists" configuration type)`,
          code: 'invalid_cidr',
        })
        continue
      }
      if (!isValidIpv6Cidr(subnet)) {
        errors.push({
          field: `${prefix}.subnets`,
          message: `"${subnet}" is not valid IPv6 CIDR notation (e.g. 2001:db8::/32; use /128 for a single host)`,
          code: 'invalid_cidr',
        })
        continue
      }
      if (subnet === '::/0') {
        errors.push({
          field: `${prefix}.subnets`,
          message: '::/0 would allow the entire IPv6 internet — declare specific subnets instead',
          code: 'open_to_world',
        })
        continue
      }
      // IPv6 allocations are far larger than IPv4's — a /32 is already an
      // ISP-scale RIR allocation, so the broad-range threshold sits there
      // rather than at IPv4's /8.
      const prefixLen = Number(subnet.split('/')[1])
      if (prefixLen < 32) {
        warnings.push({
          field: `${prefix}.subnets`,
          message: `"${subnet}" is a very broad range (/${prefixLen}) — confirm this is intentional`,
          code: 'broad_subnet',
        })
      }
      if (seenSubnets.has(subnet)) {
        warnings.push({
          field: `${prefix}.subnets`,
          message: `Duplicate subnet "${subnet}"`,
          code: 'duplicate_subnet',
        })
      }
      seenSubnets.add(subnet)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
