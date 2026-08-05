import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import {
  asObject,
  barracudaErrorMessage,
  readBool,
  readJsonArray,
  readString,
  readStringList,
  type BarracudaWaasClient,
} from '../../lib/barracudaWaf'

// --- Barracuda WAF-as-a-Service IP Reputation constraints --------------------
//
// Application-wide singleton, a dedicated GET/PATCH/PUT sub-resource of the
// Application: /applications/{appName}/ip_reputation/. Every field name below
// (enabled, blocked_countries, block_tor_nodes, block_anonymous_proxies,
// block_satellite_providers, block_unclassified_ips, block_ssh_attack_sources,
// block_datacenter_ip, block_public_proxy, block_http_attack_sources,
// block_fake_crawler, geoip_enable_logging, check_registered_country,
// apply_policy_at, exceptions[].{allow,ip,netmask,comment}) is confirmed
// directly against the live API schema (api.waas.barracudanetworks.com/v4/
// swagger/, schema IpReputationResponseSchema / ExceptionSchema).

export interface IpReputationException {
  allow: boolean
  ip: string
  netmask: string
  comment: string
}

export interface IpReputationSpec {
  enabled: boolean
  applyPolicyAt: string
  blockTorNodes: boolean
  blockAnonymousProxies: boolean
  blockSatelliteProviders: boolean
  blockUnclassifiedIps: boolean
  blockSshAttackSources: boolean
  blockDatacenterIp: boolean
  blockPublicProxy: boolean
  blockHttpAttackSources: boolean
  blockFakeCrawler: boolean
  blockedCountries: string[]
  checkRegisteredCountry: boolean
  geoipEnableLogging: boolean
  exceptions: IpReputationException[]
  exceptionsError: string | null
}

/** The singleton item's fields, or field defaults when no item is declared. */
export function extractIpReputationSpec(canvas: CanvasSnapshot): IpReputationSpec {
  const fields = (canvas.sections ?? [])[0]?.fields ?? {}
  const { items, error } = readJsonArray<Record<string, unknown>>(fields.exceptions_json)
  const exceptions: IpReputationException[] = items.map((e) => ({
    allow: readBool(e.allow, true),
    ip: readString(e.ip),
    netmask: readString(e.netmask) || '255.255.255.255',
    comment: readString(e.comment),
  }))

  return {
    enabled: readBool(fields.enabled, false),
    applyPolicyAt: readString(fields.apply_policy_at) || 'Network Layer',
    blockTorNodes: readBool(fields.block_tor_nodes, false),
    blockAnonymousProxies: readBool(fields.block_anonymous_proxies, false),
    blockSatelliteProviders: readBool(fields.block_satellite_providers, false),
    blockUnclassifiedIps: readBool(fields.block_unclassified_ips, false),
    blockSshAttackSources: readBool(fields.block_ssh_attack_sources, false),
    blockDatacenterIp: readBool(fields.block_datacenter_ip, false),
    blockPublicProxy: readBool(fields.block_public_proxy, false),
    blockHttpAttackSources: readBool(fields.block_http_attack_sources, false),
    blockFakeCrawler: readBool(fields.block_fake_crawler, false),
    blockedCountries: readStringList(fields.blocked_countries),
    checkRegisteredCountry: readBool(fields.check_registered_country, false),
    geoipEnableLogging: readBool(fields.geoip_enable_logging, false),
    exceptions,
    exceptionsError: error,
  }
}

export interface LiveIpReputation {
  enabled?: boolean
  apply_policy_at?: string
  block_tor_nodes?: boolean
  block_anonymous_proxies?: boolean
  block_satellite_providers?: boolean
  block_unclassified_ips?: boolean
  block_ssh_attack_sources?: boolean
  block_datacenter_ip?: boolean
  block_public_proxy?: boolean
  block_http_attack_sources?: boolean
  block_fake_crawler?: boolean
  blocked_countries?: string[]
  check_registered_country?: boolean
  geoip_enable_logging?: boolean
  exceptions?: Array<{ allow?: boolean; ip?: string; netmask?: string; comment?: string }>
}

/** Read the Application's current IP Reputation object; throws on a non-OK response. */
export async function getIpReputation(client: BarracudaWaasClient, appName: string): Promise<LiveIpReputation> {
  const res = await client.request('GET', `${client.appPath(appName)}/ip_reputation/`)
  if (!res.ok) throw new Error(`Failed to read IP Reputation: ${barracudaErrorMessage(res)}`)
  return asObject(res.body) as LiveIpReputation
}

/** Build the PUT/PATCH body from a declared spec. */
export function buildIpReputationBody(spec: IpReputationSpec): LiveIpReputation {
  return {
    enabled: spec.enabled,
    apply_policy_at: spec.applyPolicyAt,
    block_tor_nodes: spec.blockTorNodes,
    block_anonymous_proxies: spec.blockAnonymousProxies,
    block_satellite_providers: spec.blockSatelliteProviders,
    block_unclassified_ips: spec.blockUnclassifiedIps,
    block_ssh_attack_sources: spec.blockSshAttackSources,
    block_datacenter_ip: spec.blockDatacenterIp,
    block_public_proxy: spec.blockPublicProxy,
    block_http_attack_sources: spec.blockHttpAttackSources,
    block_fake_crawler: spec.blockFakeCrawler,
    blocked_countries: spec.blockedCountries,
    check_registered_country: spec.checkRegisteredCountry,
    geoip_enable_logging: spec.geoipEnableLogging,
    exceptions: spec.exceptions.map((e) => ({ allow: e.allow, ip: e.ip, netmask: e.netmask, comment: e.comment })),
  }
}

// --- Validate handler ---------------------------------------------------------

const CIDR_OR_IP_RE = /^(\d{1,3}\.){3}\d{1,3}$/

/**
 * Validate the IP Reputation singleton: at most one declared item; the
 * exceptions JSON must parse; each exception needs an IP and (allow is
 * required); blocked country codes are warned when they don't look like a
 * 2-letter ISO code.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Add the IP Reputation item', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }
  if (sections.length > 1) {
    errors.push({ field: 'sections', message: 'IP Reputation is a singleton — declare it only once per canvas', code: 'singleton' })
  }

  const spec = extractIpReputationSpec(ctx.canvas)
  const prefix = sections[0].name

  if (spec.exceptionsError) {
    errors.push({ field: `${prefix}.exceptions_json`, message: `Exceptions ${spec.exceptionsError}`, code: 'invalid_json' })
  } else {
    spec.exceptions.forEach((exc, i) => {
      if (!exc.ip || !CIDR_OR_IP_RE.test(exc.ip)) {
        errors.push({ field: `${prefix}.exceptions_json[${i}].ip`, message: `Exception ${i} needs a valid IPv4 address (got "${exc.ip}")`, code: 'invalid_ip' })
      }
      if (!exc.netmask || !CIDR_OR_IP_RE.test(exc.netmask)) {
        errors.push({ field: `${prefix}.exceptions_json[${i}].netmask`, message: `Exception ${i} needs a valid IPv4 netmask (got "${exc.netmask}")`, code: 'invalid_netmask' })
      }
    })
  }

  for (const code of spec.blockedCountries) {
    if (!/^[A-Za-z]{2}$/.test(code)) {
      warnings.push({ field: `${prefix}.blocked_countries`, message: `"${code}" does not look like a 2-letter ISO country code`, code: 'country_format' })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
