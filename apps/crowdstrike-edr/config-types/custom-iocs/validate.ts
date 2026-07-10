import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { coerceBoolean, splitList } from '../../lib/falcon'

// --- IOC Management API constraints ------------------------------------------

export const IOC_TYPES = ['sha256', 'md5', 'domain', 'ipv4', 'ipv6'] as const
export type IocType = (typeof IOC_TYPES)[number]

export const IOC_ACTIONS = ['detect', 'prevent', 'no_action', 'allow'] as const
export type IocAction = (typeof IOC_ACTIONS)[number]

export const IOC_SEVERITIES = ['informational', 'low', 'medium', 'high', 'critical'] as const
export type IocSeverity = (typeof IOC_SEVERITIES)[number]

export const IOC_PLATFORMS = ['windows', 'mac', 'linux'] as const

/** Actions that block/permit execution are only valid for file hashes. */
export const HASH_ONLY_ACTIONS: readonly IocAction[] = ['prevent', 'allow']

const SHA256_RE = /^[a-f0-9]{64}$/
const MD5_RE = /^[a-f0-9]{32}$/
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/
const IPV6_RE = /^(([0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|([0-9a-f]{1,4}:){1,7}:|([0-9a-f]{1,4}:){1,6}:[0-9a-f]{1,4}|([0-9a-f]{1,4}:){1,5}(:[0-9a-f]{1,4}){1,2}|([0-9a-f]{1,4}:){1,4}(:[0-9a-f]{1,4}){1,3}|([0-9a-f]{1,4}:){1,3}(:[0-9a-f]{1,4}){1,4}|([0-9a-f]{1,4}:){1,2}(:[0-9a-f]{1,4}){1,5}|[0-9a-f]{1,4}:((:[0-9a-f]{1,4}){1,6})|:((:[0-9a-f]{1,4}){1,7}|:))$/
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/

// --- Spec extraction shared by deploy / rollback / healthCheck / drift -------

export interface IocSpec {
  sectionName: string
  type: string
  value: string
  action: string
  severity: string
  platforms: string[]
  appliedGlobally: boolean
  hostGroups: string[]
  expiration?: string
  description?: string
  tags: string[]
}

/** Shape of an indicator returned by GET /iocs/entities/indicators/v1. */
export interface LiveIndicator {
  id?: string
  type?: string
  value?: string
  action?: string
  severity?: string
  platforms?: string[]
  applied_globally?: boolean
  host_groups?: string[]
  expiration?: string
  description?: string
  tags?: string[]
}

/** Each canvas section describes one custom IOC. */
export function extractIocSpecs(canvas: CanvasSnapshot): IocSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const type = typeof fields.type === 'string' ? fields.type.trim().toLowerCase() : ''
    let value = typeof fields.value === 'string' ? fields.value.trim() : ''
    // The type/value pair is the indicator's identity in deploy-time lookups
    // and drift comparisons — normalize casing so they are stable. IP values
    // are included: Falcon stores IPv6 lowercased.
    if (type !== 'ipv4') value = value.toLowerCase()

    const expiration = typeof fields.expiration === 'string' ? fields.expiration.trim() : ''

    return {
      sectionName: section.name,
      type,
      value,
      action: typeof fields.action === 'string' ? fields.action.trim() : 'detect',
      severity: typeof fields.severity === 'string' ? fields.severity.trim() : 'medium',
      platforms: splitList(fields.platforms).map((p) => p.toLowerCase()),
      appliedGlobally: coerceBoolean(fields.appliedGlobally, true),
      hostGroups: splitList(fields.hostGroups),
      expiration: expiration.length > 0 ? normalizeExpiration(expiration) : undefined,
      description:
        typeof fields.description === 'string' && fields.description.trim()
          ? fields.description.trim()
          : undefined,
      tags: splitList(fields.tags),
    }
  })
}

/** Accept date-only or seconds-precision input; the API wants full ISO-8601 UTC. */
export function normalizeExpiration(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T00:00:00Z`
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(value)) {
    return value.length === 16 ? `${value}:00Z` : `${value}Z`
  }
  return value
}

/**
 * Only fully-qualified UTC timestamps pass validation — anything else would
 * be parsed in the server's local timezone and sent ambiguously to the API.
 */
export const EXPIRATION_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/

export function isValidIocValue(type: string, value: string): boolean {
  switch (type) {
    case 'sha256':
      return SHA256_RE.test(value)
    case 'md5':
      return MD5_RE.test(value)
    case 'ipv4':
      return IPV4_RE.test(value) && value.split('.').every((octet) => Number(octet) <= 255)
    case 'ipv6':
      return IPV6_RE.test(value.toLowerCase())
    case 'domain':
      return DOMAIN_RE.test(value)
    default:
      return false
  }
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate custom IOC configurations against IOC Management API constraints:
 * value format per indicator type, hash-only actions, platform names,
 * host group targeting, and expiration timestamps.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractIocSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // type
    if (!spec.type) {
      errors.push({ field: `${prefix}.type`, message: 'Indicator type is required', code: 'required' })
    } else if (!(IOC_TYPES as readonly string[]).includes(spec.type)) {
      errors.push({
        field: `${prefix}.type`,
        message: `Indicator type must be one of: ${IOC_TYPES.join(', ')}`,
        code: 'invalid_type',
      })
    }

    // value
    if (!spec.value) {
      errors.push({ field: `${prefix}.value`, message: 'Indicator value is required', code: 'required' })
    } else if (spec.type && (IOC_TYPES as readonly string[]).includes(spec.type)) {
      if (!isValidIocValue(spec.type, spec.value)) {
        errors.push({
          field: `${prefix}.value`,
          message: valueFormatMessage(spec.type),
          code: 'invalid_format',
        })
      }
      const key = `${spec.type}:${spec.value}`
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.value`,
          message: `Duplicate indicator "${spec.value}" (${spec.type}) — each indicator may only be declared once per canvas`,
          code: 'duplicate_indicator',
        })
      }
      seen.add(key)
    }

    // action
    if (!(IOC_ACTIONS as readonly string[]).includes(spec.action)) {
      errors.push({
        field: `${prefix}.action`,
        message: `Action must be one of: ${IOC_ACTIONS.join(', ')}`,
        code: 'invalid_action',
      })
    } else if (
      (HASH_ONLY_ACTIONS as readonly string[]).includes(spec.action) &&
      spec.type !== 'sha256' &&
      spec.type !== 'md5'
    ) {
      errors.push({
        field: `${prefix}.action`,
        message: `Action "${spec.action}" is only valid for file hash indicators (sha256, md5)`,
        code: 'action_type_conflict',
      })
    }

    // severity
    if (!(IOC_SEVERITIES as readonly string[]).includes(spec.severity)) {
      errors.push({
        field: `${prefix}.severity`,
        message: `Severity must be one of: ${IOC_SEVERITIES.join(', ')}`,
        code: 'invalid_severity',
      })
    } else if (spec.action === 'allow' || spec.action === 'no_action') {
      // Severity drives alerting, which these actions never do.
      if (spec.severity !== 'informational') {
        warnings.push({
          field: `${prefix}.severity`,
          message: `Severity is ignored for "${spec.action}" indicators`,
          code: 'severity_ignored',
        })
      }
    }

    // platforms
    if (spec.platforms.length === 0) {
      errors.push({
        field: `${prefix}.platforms`,
        message: `At least one platform is required: ${IOC_PLATFORMS.join(', ')}`,
        code: 'required',
      })
    } else {
      for (const platform of spec.platforms) {
        if (!(IOC_PLATFORMS as readonly string[]).includes(platform)) {
          errors.push({
            field: `${prefix}.platforms`,
            message: `Unknown platform "${platform}" — allowed: ${IOC_PLATFORMS.join(', ')}`,
            code: 'invalid_platform',
          })
        }
      }
    }

    // host group targeting
    if (!spec.appliedGlobally && spec.hostGroups.length === 0) {
      errors.push({
        field: `${prefix}.hostGroups`,
        message: 'Host group IDs are required when the indicator is not applied globally',
        code: 'required',
      })
    }
    if (spec.appliedGlobally && spec.hostGroups.length > 0) {
      warnings.push({
        field: `${prefix}.hostGroups`,
        message: 'Host groups are ignored while "Apply Globally" is checked',
        code: 'host_groups_ignored',
      })
    }

    // expiration
    if (spec.expiration !== undefined) {
      if (!EXPIRATION_UTC_RE.test(spec.expiration)) {
        errors.push({
          field: `${prefix}.expiration`,
          message:
            'Expiration must be an ISO-8601 UTC timestamp ending in Z, e.g. 2026-12-31T00:00:00Z',
          code: 'invalid_format',
        })
      } else if (Date.parse(spec.expiration) <= Date.now()) {
        errors.push({
          field: `${prefix}.expiration`,
          message: 'Expiration is in the past — an expired indicator never matches',
          code: 'expired',
        })
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}

function valueFormatMessage(type: string): string {
  switch (type) {
    case 'sha256':
      return 'SHA-256 value must be 64 hexadecimal characters'
    case 'md5':
      return 'MD5 value must be 32 hexadecimal characters'
    case 'ipv4':
      return 'IPv4 value must be a dotted-quad address, e.g. 203.0.113.10'
    case 'ipv6':
      return 'IPv6 value must be a valid colon-separated address'
    case 'domain':
      return 'Domain value must be a valid DNS name, e.g. malicious.example.com'
    default:
      return 'Invalid indicator value'
  }
}
