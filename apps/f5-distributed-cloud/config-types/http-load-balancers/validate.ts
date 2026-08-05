import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { splitList, type F5xcRef } from '../../lib/f5xc'

// --- F5 XC HTTP Loadbalancer API constraints -----------------------------------
// https://docs.cloud.f5.com/docs-v2/api/views-http-loadbalancer
//
// GET/POST       /config/namespaces/{namespace}/http_loadbalancers         - list / create
// GET/PUT/DELETE /config/namespaces/{namespace}/http_loadbalancers/{name}  - read / update / delete

const NAME_PATTERN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/
const MAX_NAME_LENGTH = 63

export type HttpTlsMode = 'http' | 'https_auto_cert'
export type LbAlgorithm = 'round_robin' | 'least_active' | 'random' | 'source_ip_stickiness'
export type WafMode = 'disable_waf' | 'app_firewall'
export type MaliciousUserDetectionMode = 'disable_malicious_user_detection' | 'enable_malicious_user_detection'
export type RateLimitMode = 'disable_rate_limit' | 'rate_limit'
export type RateLimitUnit = 'SECOND' | 'MINUTE' | 'HOUR'
export type ServicePoliciesMode = 'no_service_policies' | 'service_policies_from_namespace' | 'active_service_policies'
export type AdvertiseMode = 'do_not_advertise' | 'advertise_on_public_default_vip'

export interface SimpleRoute {
  path?: { path?: string; prefix?: string; regex?: string }
  origin_pools?: Array<{ pool?: F5xcRef; weight?: number }>
  http_method?: string
}

export interface HttpLoadBalancerSpec {
  sectionName: string
  name: string
  description?: string
  disable: boolean
  domains: string[]
  tlsMode: HttpTlsMode
  httpPort?: number
  httpsPort?: number
  httpRedirect: boolean
  defaultRoutePools: string[]
  loadBalancingAlgorithm: LbAlgorithm
  routesJson: string
  wafMode: WafMode
  appFirewallName?: string
  maliciousUserDetectionMode: MaliciousUserDetectionMode
  maliciousUserMitigationName?: string
  rateLimitMode: RateLimitMode
  rateLimitThreshold?: number
  rateLimitUnit: RateLimitUnit
  corsEnabled: boolean
  corsAllowOrigin: string[]
  corsAllowMethods: string[]
  corsAllowHeaders: string[]
  corsAllowCredentials: boolean
  corsMaxAge?: number
  servicePoliciesMode: ServicePoliciesMode
  activeServicePolicies: string[]
  advertiseMode: AdvertiseMode
}

/** Shape of an http_loadbalancer spec returned by GET .../http_loadbalancers/{name}. */
export interface LiveHttpLoadBalancerSpec {
  domains?: string[]
  http?: Record<string, unknown>
  https_auto_cert?: Record<string, unknown>
  default_route_pools?: Array<{ pool?: F5xcRef }>
  routes?: Array<{ simple_route?: SimpleRoute }>
  round_robin?: boolean
  least_active?: boolean
  random?: boolean
  source_ip_stickiness?: boolean
  app_firewall?: F5xcRef
  disable_waf?: boolean
  disable_malicious_user_detection?: boolean
  enable_malicious_user_detection?: boolean
  malicious_user_mitigation?: F5xcRef
  disable_rate_limit?: boolean
  rate_limit?: Record<string, unknown>
  cors_policy?: Record<string, unknown>
  no_service_policies?: boolean
  service_policies_from_namespace?: boolean
  active_service_policies?: { policies?: F5xcRef[] }
  do_not_advertise?: boolean
  advertise_on_public_default_vip?: boolean
  [key: string]: unknown
}

function toText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value)
  return undefined
}

/** Each canvas item describes one F5 XC HTTP load balancer. */
export function extractHttpLoadBalancerSpecs(canvas: CanvasSnapshot): HttpLoadBalancerSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const tlsMode: HttpTlsMode = fields.tlsMode === 'http' ? 'http' : 'https_auto_cert'
    const loadBalancingAlgorithm: LbAlgorithm = (
      ['least_active', 'random', 'source_ip_stickiness'] as string[]
    ).includes(fields.loadBalancingAlgorithm as string)
      ? (fields.loadBalancingAlgorithm as LbAlgorithm)
      : 'round_robin'
    const wafMode: WafMode = fields.wafMode === 'app_firewall' ? 'app_firewall' : 'disable_waf'
    const maliciousUserDetectionMode: MaliciousUserDetectionMode =
      fields.maliciousUserDetectionMode === 'enable_malicious_user_detection'
        ? 'enable_malicious_user_detection'
        : 'disable_malicious_user_detection'
    const rateLimitMode: RateLimitMode = fields.rateLimitMode === 'rate_limit' ? 'rate_limit' : 'disable_rate_limit'
    const rateLimitUnit: RateLimitUnit = (['SECOND', 'HOUR'] as string[]).includes(fields.rateLimitUnit as string)
      ? (fields.rateLimitUnit as RateLimitUnit)
      : 'MINUTE'
    const servicePoliciesMode: ServicePoliciesMode = (
      ['service_policies_from_namespace', 'active_service_policies'] as string[]
    ).includes(fields.servicePoliciesMode as string)
      ? (fields.servicePoliciesMode as ServicePoliciesMode)
      : 'no_service_policies'
    const advertiseMode: AdvertiseMode =
      fields.advertiseMode === 'advertise_on_public_default_vip' ? 'advertise_on_public_default_vip' : 'do_not_advertise'

    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      description: toText(fields.description),
      disable: fields.disable === true,
      domains: splitList(fields.domains),
      tlsMode,
      httpPort: toNumber(fields.httpPort),
      httpsPort: toNumber(fields.httpsPort),
      httpRedirect: fields.httpRedirect !== false,
      defaultRoutePools: Array.isArray(fields.defaultRoutePools)
        ? fields.defaultRoutePools.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
        : [],
      loadBalancingAlgorithm,
      routesJson: typeof fields.routesJson === 'string' ? fields.routesJson : '',
      wafMode,
      appFirewallName: toText(fields.appFirewallName),
      maliciousUserDetectionMode,
      maliciousUserMitigationName: toText(fields.maliciousUserMitigationName),
      rateLimitMode,
      rateLimitThreshold: toNumber(fields.rateLimitThreshold),
      rateLimitUnit,
      corsEnabled: fields.corsEnabled === true,
      corsAllowOrigin: splitList(fields.corsAllowOrigin),
      corsAllowMethods: splitList(fields.corsAllowMethods),
      corsAllowHeaders: splitList(fields.corsAllowHeaders),
      corsAllowCredentials: fields.corsAllowCredentials === true,
      corsMaxAge: toNumber(fields.corsMaxAge),
      servicePoliciesMode,
      activeServicePolicies: Array.isArray(fields.activeServicePolicies)
        ? fields.activeServicePolicies.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
        : [],
      advertiseMode,
    }
  })
}

/** Parse routesJson; blank is valid (no explicit routes); invalid JSON/shape returns null. */
export function parseRoutesJson(json: string): SimpleRoute[] | null {
  if (!json.trim()) return []
  try {
    const parsed = JSON.parse(json)
    if (!Array.isArray(parsed)) return null
    if (
      !parsed.every(
        (route) =>
          route &&
          typeof route === 'object' &&
          route.path &&
          typeof route.path === 'object' &&
          Array.isArray(route.origin_pools) &&
          route.origin_pools.length > 0,
      )
    ) {
      return null
    }
    return parsed as SimpleRoute[]
  } catch {
    return null
  }
}

/**
 * Validate HTTP load balancer configurations against the F5 XC API. Static
 * only:
 *   - name is required, DNS-1035, <= 63 chars, and unique within the canvas
 *   - domains is required
 *   - at least one Default Route Pool is required
 *   - appFirewallName is required when wafMode is "app_firewall"
 *   - rateLimitThreshold is required when rateLimitMode is "rate_limit"
 *   - activeServicePolicies is required when servicePoliciesMode is "active_service_policies"
 *   - routesJson, when non-blank, must parse to an array of { path, origin_pools }
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractHttpLoadBalancerSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'HTTP Load Balancer name is required', code: 'required' })
      continue
    }
    if (!NAME_PATTERN.test(spec.name) || spec.name.length > MAX_NAME_LENGTH) {
      errors.push({
        field: `${prefix}.name`,
        message: 'Name must be a DNS-1035 label: lowercase alphanumeric and hyphens, starting with a letter, 63 characters or fewer',
        code: 'invalid_name',
      })
    }
    const key = spec.name.toLowerCase()
    if (seenNames.has(key)) {
      errors.push({
        field: `${prefix}.name`,
        message: `Duplicate HTTP Load Balancer "${spec.name}" - each load balancer may only be declared once per canvas`,
        code: 'duplicate_name',
      })
    }
    seenNames.add(key)

    if (spec.domains.length === 0) {
      errors.push({ field: `${prefix}.domains`, message: 'At least one domain is required', code: 'required' })
    }

    if (spec.defaultRoutePools.length === 0) {
      errors.push({
        field: `${prefix}.defaultRoutePools`,
        message: 'At least one Default Route Pool is required',
        code: 'required',
      })
    }

    if (spec.wafMode === 'app_firewall' && !spec.appFirewallName) {
      errors.push({
        field: `${prefix}.appFirewallName`,
        message: 'App Firewall Policy is required when App Firewall is set to Attach a Policy',
        code: 'required',
      })
    }

    if (spec.rateLimitMode === 'rate_limit' && (spec.rateLimitThreshold === undefined || spec.rateLimitThreshold < 1)) {
      errors.push({
        field: `${prefix}.rateLimitThreshold`,
        message: 'Requests Allowed is required when Rate Limiting is enabled',
        code: 'required',
      })
    }

    if (spec.servicePoliciesMode === 'active_service_policies' && spec.activeServicePolicies.length === 0) {
      errors.push({
        field: `${prefix}.activeServicePolicies`,
        message: 'At least one Attached Service Policy is required when Service Policies is set to Specific Policies',
        code: 'required',
      })
    }

    if (parseRoutesJson(spec.routesJson) === null) {
      errors.push({
        field: `${prefix}.routesJson`,
        message: 'Routes must be a JSON array of { path: {...}, origin_pools: [{ pool: {...} }] } (or blank)',
        code: 'invalid_json',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
