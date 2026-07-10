import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { splitList } from '../../lib/acs'

// --- ACS IP allow list constraints (see README for documentation sources) ---

/** Features that support IP allow lists via ACS. */
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

/** ACS caps each feature's allow list at 200 subnets (AWS and GCP). */
export const MAX_SUBNETS_PER_FEATURE = 200

const CIDR_V4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/

/** Validate an IPv4 CIDR (octets 0–255, prefix 0–32). */
export function isValidIpv4Cidr(value: string): boolean {
  const match = CIDR_V4_RE.exec(value)
  if (!match) return false
  const octets = match.slice(1, 5).map(Number)
  const prefix = Number(match[5])
  return octets.every((o) => o >= 0 && o <= 255) && prefix >= 0 && prefix <= 32
}

/** Normalize a subnet from an ACS response (strips list markers/whitespace). */
export function normalizeSubnet(value: string): string {
  return value.replace(/^[\s:]+/, '').trim()
}

// --- Spec extraction shared by deploy / rollback / healthCheck / drift ------

export interface AllowlistSpec {
  sectionName: string
  feature: string
  subnets: string[]
  removeUndeclared: boolean
}

/** Each canvas section describes the allow list for one feature. */
export function extractAllowlistSpecs(canvas: CanvasSnapshot): AllowlistSpec[] {
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
 * Validate IP allow list configurations against ACS constraints: supported
 * feature names, IPv4 CIDR notation, subnet count limits, and safety rails
 * against overly-broad subnets or ACS lockout.
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
          message: `Duplicate feature "${trimmed}" — declare each feature's allow list in a single section`,
          code: 'duplicate_feature',
        })
      }
      seenFeatures.add(trimmed)

      // Lockout protection: removing subnets from the acs feature can cut off
      // this app's own access (and yours).
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
        message: 'At least one subnet in CIDR notation is required',
        code: 'required',
      })
      continue
    }
    if (subnets.length > MAX_SUBNETS_PER_FEATURE) {
      errors.push({
        field: `${prefix}.subnets`,
        message: `ACS allows at most ${MAX_SUBNETS_PER_FEATURE} subnets per feature (got ${subnets.length})`,
        code: 'subnet_limit',
      })
    }

    const seenSubnets = new Set<string>()
    for (const subnet of subnets) {
      if (subnet.includes(':')) {
        errors.push({
          field: `${prefix}.subnets`,
          message: `"${subnet}" — IPv6 subnets are not supported by this app version (manage ipallowlists-v6 directly via ACS)`,
          code: 'invalid_cidr',
        })
        continue
      }
      if (!isValidIpv4Cidr(subnet)) {
        errors.push({
          field: `${prefix}.subnets`,
          message: `"${subnet}" is not valid IPv4 CIDR notation (e.g. 203.0.113.0/24; use /32 for a single host)`,
          code: 'invalid_cidr',
        })
        continue
      }
      if (subnet === '0.0.0.0/0') {
        errors.push({
          field: `${prefix}.subnets`,
          message: '0.0.0.0/0 would allow the entire internet — declare specific subnets instead',
          code: 'open_to_world',
        })
        continue
      }
      const cidrPrefix = Number(subnet.split('/')[1])
      if (cidrPrefix < 8) {
        warnings.push({
          field: `${prefix}.subnets`,
          message: `"${subnet}" is a very broad range (/${cidrPrefix}) — confirm this is intentional`,
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
