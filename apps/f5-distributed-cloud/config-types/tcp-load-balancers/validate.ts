import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { splitList, type F5xcRef } from '../../lib/f5xc'

// --- F5 XC TCP Loadbalancer API constraints ------------------------------------
// https://docs.cloud.f5.com/docs-v2/api/views-tcp-loadbalancer
//
// GET/POST       /config/namespaces/{namespace}/tcp_loadbalancers         - list / create
// GET/PUT/DELETE /config/namespaces/{namespace}/tcp_loadbalancers/{name}  - read / update / delete

const NAME_PATTERN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/
const MAX_NAME_LENGTH = 63

export type ListenPortMode = 'listen_port' | 'port_ranges'
export type AdvertiseMode = 'do_not_advertise' | 'advertise_on_public_default_vip'
export type TcpTlsMode = 'tcp' | 'tls_tcp_auto_cert'
export type LoadBalancingAlgorithm = 'round_robin' | 'random' | 'least_active' | 'source_ip_stickiness'
export type ServicePoliciesMode = 'no_service_policies' | 'service_policies_from_namespace' | 'active_service_policies'
export type SniMode = 'no_sni' | 'default_lb_with_sni' | 'sni'

export interface TcpLoadBalancerSpec {
  sectionName: string
  name: string
  description?: string
  disable: boolean
  domains: string[]
  listenPortMode: ListenPortMode
  listenPort?: number
  portRanges?: string
  advertiseMode: AdvertiseMode
  retractCluster: boolean
  tlsMode: TcpTlsMode
  originPools: string[]
  loadBalancingAlgorithm: LoadBalancingAlgorithm
  servicePoliciesMode: ServicePoliciesMode
  activeServicePolicies: string[]
  sniMode: SniMode
  sniValue?: string
  idleTimeoutMs?: number
}

/** Shape of a tcp_loadbalancer spec returned by GET .../tcp_loadbalancers/{name}. */
export interface LiveTcpLoadBalancerSpec {
  domains?: string[]
  listen_port?: number
  port_ranges?: string
  do_not_advertise?: boolean
  advertise_on_public_default_vip?: boolean
  do_not_retract_cluster?: boolean
  retract_cluster?: boolean
  tcp?: boolean
  tls_tcp_auto_cert?: Record<string, unknown>
  origin_pools_weights?: Array<{ pool?: F5xcRef }>
  hash_policy_choice_round_robin?: boolean
  hash_policy_choice_random?: boolean
  hash_policy_choice_least_active?: boolean
  hash_policy_choice_source_ip_stickiness?: boolean
  no_service_policies?: boolean
  service_policies_from_namespace?: boolean
  active_service_policies?: { policies?: F5xcRef[] }
  no_sni?: boolean
  default_lb_with_sni?: boolean
  sni?: { sni?: string }
  idle_timeout?: number
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

/** Each canvas item describes one F5 XC TCP load balancer. */
export function extractTcpLoadBalancerSpecs(canvas: CanvasSnapshot): TcpLoadBalancerSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const listenPortMode: ListenPortMode = fields.listenPortMode === 'port_ranges' ? 'port_ranges' : 'listen_port'
    const advertiseMode: AdvertiseMode =
      fields.advertiseMode === 'advertise_on_public_default_vip' ? 'advertise_on_public_default_vip' : 'do_not_advertise'
    const tlsMode: TcpTlsMode = fields.tlsMode === 'tls_tcp_auto_cert' ? 'tls_tcp_auto_cert' : 'tcp'
    const loadBalancingAlgorithm: LoadBalancingAlgorithm = (
      ['random', 'least_active', 'source_ip_stickiness'] as string[]
    ).includes(fields.loadBalancingAlgorithm as string)
      ? (fields.loadBalancingAlgorithm as LoadBalancingAlgorithm)
      : 'round_robin'
    const servicePoliciesMode: ServicePoliciesMode = (
      ['service_policies_from_namespace', 'active_service_policies'] as string[]
    ).includes(fields.servicePoliciesMode as string)
      ? (fields.servicePoliciesMode as ServicePoliciesMode)
      : 'no_service_policies'
    const sniMode: SniMode = (['default_lb_with_sni', 'sni'] as string[]).includes(fields.sniMode as string)
      ? (fields.sniMode as SniMode)
      : 'no_sni'

    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      description: toText(fields.description),
      disable: fields.disable === true,
      domains: splitList(fields.domains),
      listenPortMode,
      listenPort: toNumber(fields.listenPort),
      portRanges: toText(fields.portRanges),
      advertiseMode,
      retractCluster: fields.retractCluster === true,
      tlsMode,
      originPools: Array.isArray(fields.originPools)
        ? fields.originPools.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
        : [],
      loadBalancingAlgorithm,
      servicePoliciesMode,
      activeServicePolicies: Array.isArray(fields.activeServicePolicies)
        ? fields.activeServicePolicies.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
        : [],
      sniMode,
      sniValue: toText(fields.sniValue),
      idleTimeoutMs: toNumber(fields.idleTimeoutMs),
    }
  })
}

/**
 * Validate TCP load balancer configurations against the F5 XC API. Static
 * only:
 *   - name is required, DNS-1035, <= 63 chars, and unique within the canvas
 *   - listenPort is required when listenPortMode is "listen_port"; portRanges when "port_ranges"
 *   - at least one origin pool is required
 *   - activeServicePolicies is required when servicePoliciesMode is "active_service_policies"
 *   - sniValue is required when sniMode is "sni"
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractTcpLoadBalancerSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'TCP Load Balancer name is required', code: 'required' })
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
        message: `Duplicate TCP Load Balancer "${spec.name}" - each load balancer may only be declared once per canvas`,
        code: 'duplicate_name',
      })
    }
    seenNames.add(key)

    if (spec.listenPortMode === 'listen_port' && (spec.listenPort === undefined || spec.listenPort < 1 || spec.listenPort > 65535)) {
      errors.push({
        field: `${prefix}.listenPort`,
        message: 'Port Number (1-65535) is required when Listen Port is set to Single Port',
        code: 'required',
      })
    }
    if (spec.listenPortMode === 'port_ranges' && !spec.portRanges) {
      errors.push({
        field: `${prefix}.portRanges`,
        message: 'Port Ranges is required when Listen Port is set to Port Range(s)',
        code: 'required',
      })
    }

    if (spec.originPools.length === 0) {
      errors.push({ field: `${prefix}.originPools`, message: 'At least one Origin Pool is required', code: 'required' })
    }

    if (spec.servicePoliciesMode === 'active_service_policies' && spec.activeServicePolicies.length === 0) {
      errors.push({
        field: `${prefix}.activeServicePolicies`,
        message: 'At least one Attached Service Policy is required when Service Policies is set to Specific Policies',
        code: 'required',
      })
    }

    if (spec.sniMode === 'sni' && !spec.sniValue) {
      errors.push({
        field: `${prefix}.sniValue`,
        message: 'SNI Value is required when Server Name Indication is set to Specific SNI Value',
        code: 'required',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
