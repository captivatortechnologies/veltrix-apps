import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- F5 XC Healthcheck API constraints ---------------------------------------
// https://docs.cloud.f5.com/docs-v2/api/healthcheck
//
// GET/POST       /config/namespaces/{namespace}/healthchecks         - list / create
// GET/PUT/DELETE /config/namespaces/{namespace}/healthchecks/{name}  - read / update / delete
//
// spec is a oneof of exactly one probe type: http_health_check |
// tcp_health_check | udp_icmp_health_check (dns_health_check and the
// dns_proxy_* variants are marked (Deprecated) upstream and omitted here),
// plus interval/timeout/healthy_threshold/unhealthy_threshold (all required)
// and an optional jitter_percent.

const NAME_PATTERN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/
const MAX_NAME_LENGTH = 63

export type HealthCheckType = 'http' | 'tcp' | 'udp_icmp'

export interface HealthCheckSpec {
  sectionName: string
  name: string
  description?: string
  disable: boolean
  checkType: HealthCheckType
  httpPath?: string
  httpExpectedStatusCodes?: string
  httpExpectedResponse?: string
  httpUseOriginServerName: boolean
  httpHostHeader?: string
  httpUseHttp2: boolean
  tcpSendPayload?: string
  tcpExpectedResponse?: string
  interval: number
  timeout: number
  healthyThreshold: number
  unhealthyThreshold: number
  jitterPercent?: number
}

/** Shape of a healthcheck spec returned by GET .../healthchecks/{name}. */
export interface LiveHealthCheckSpec {
  http_health_check?: {
    path?: string
    expected_status_codes?: string
    expected_response?: string
    host_header?: string
    use_origin_server_name?: boolean
    use_http2?: boolean
  }
  tcp_health_check?: { send_payload?: string; expected_response?: string }
  udp_icmp_health_check?: boolean
  interval?: number
  timeout?: number
  healthy_threshold?: number
  unhealthy_threshold?: number
  jitter_percent?: number
  [key: string]: unknown
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value)
  return undefined
}

function toText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** Each canvas item describes one F5 XC health check. */
export function extractHealthCheckSpecs(canvas: CanvasSnapshot): HealthCheckSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const checkType: HealthCheckType =
      fields.checkType === 'tcp' || fields.checkType === 'udp_icmp' ? fields.checkType : 'http'

    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      description: toText(fields.description),
      disable: fields.disable === true,
      checkType,
      httpPath: toText(fields.httpPath),
      httpExpectedStatusCodes: toText(fields.httpExpectedStatusCodes),
      httpExpectedResponse: toText(fields.httpExpectedResponse),
      httpUseOriginServerName: fields.httpUseOriginServerName !== false,
      httpHostHeader: toText(fields.httpHostHeader),
      httpUseHttp2: fields.httpUseHttp2 === true,
      tcpSendPayload: toText(fields.tcpSendPayload),
      tcpExpectedResponse: toText(fields.tcpExpectedResponse),
      interval: toNumber(fields.interval) ?? 15,
      timeout: toNumber(fields.timeout) ?? 3,
      healthyThreshold: toNumber(fields.healthyThreshold) ?? 2,
      unhealthyThreshold: toNumber(fields.unhealthyThreshold) ?? 2,
      jitterPercent: toNumber(fields.jitterPercent),
    }
  })
}

/**
 * Validate health check configurations against the F5 XC Healthcheck API.
 * Static only:
 *   - name is required, DNS-1035 (lowercase alphanumeric + hyphen), <= 63
 *     chars, and unique within the canvas
 *   - an HTTP check requires a path
 *   - interval/timeout/healthy/unhealthy thresholds must be positive integers
 *   - jitterPercent, when set, is 0-100
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractHealthCheckSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Health check name is required', code: 'required' })
      continue
    }
    if (!NAME_PATTERN.test(spec.name) || spec.name.length > MAX_NAME_LENGTH) {
      errors.push({
        field: `${prefix}.name`,
        message: 'Health check name must be a DNS-1035 label: lowercase alphanumeric and hyphens, starting with a letter, 63 characters or fewer',
        code: 'invalid_name',
      })
    }
    const key = spec.name.toLowerCase()
    if (seenNames.has(key)) {
      errors.push({
        field: `${prefix}.name`,
        message: `Duplicate health check "${spec.name}" - each health check may only be declared once per canvas`,
        code: 'duplicate_name',
      })
    }
    seenNames.add(key)

    if (spec.checkType === 'http' && !spec.httpPath) {
      errors.push({
        field: `${prefix}.httpPath`,
        message: 'HTTP Path is required for an HTTP health check',
        code: 'required',
      })
    }

    for (const [field, value] of [
      ['interval', spec.interval],
      ['timeout', spec.timeout],
      ['healthyThreshold', spec.healthyThreshold],
      ['unhealthyThreshold', spec.unhealthyThreshold],
    ] as const) {
      if (!Number.isInteger(value) || value < 1) {
        errors.push({
          field: `${prefix}.${field}`,
          message: `${field} must be a positive integer`,
          code: 'invalid_number',
        })
      }
    }

    if (spec.jitterPercent !== undefined && (spec.jitterPercent < 0 || spec.jitterPercent > 100)) {
      errors.push({
        field: `${prefix}.jitterPercent`,
        message: 'jitterPercent must be between 0 and 100',
        code: 'out_of_range',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
