// =============================================================================
// Shared types/validation for Cisco Meraki Firewalled Services.
//
// The odd one out: ICMP, web and SNMP are a FIXED, uncreatable set of
// services on every network — there is no create/delete, only
// PUT .../firewalledServices/{service}. This reuses the singleton-settings
// engine (lib/merakiSingleton.ts) by modeling the per-network settings object
// as `{ services: [...] }`; `put()` loops one PUT per declared entry and
// re-reads the canonical state afterward.
//
// NOTE: schema follows the documented Meraki Dashboard API v1
// (https://developer.cisco.com/meraki/api-v1/update-network-appliance-firewall-firewalled-service/).
// The fixed service names are documented as "ICMP", "web" and "SNMP" — only
// "web"'s lower-case form appeared in a worked example during this app's
// research; the exact casing of "ICMP"/"SNMP" is carried over from general
// Meraki documentation and is FLAGGED as not independently re-verified
// against a live API response in this app. `validate` only WARNS on an
// unrecognized service name rather than rejecting it, so a real but
// differently-cased service name is never silently blocked.
// =============================================================================

import { listFirewalledServices, updateFirewalledService } from '../../lib/merakiApi'
import type { SingletonTransport } from '../../lib/merakiSingleton'
import type { MerakiClient } from '../../lib/merakiApi'

/** The fixed service set, as documented. Advisory only — see the file-level note on casing. */
export const KNOWN_FIREWALLED_SERVICES = ['ICMP', 'web', 'SNMP'] as const
export const FIREWALLED_SERVICE_ACCESS_VALUES = ['blocked', 'restricted', 'unrestricted'] as const

export interface MerakiFirewalledService {
  service: string
  access: string
  allowedIps?: string[]
  [key: string]: unknown
}

export interface FirewalledServicesSettings {
  services: MerakiFirewalledService[]
  [key: string]: unknown
}

async function get(client: MerakiClient, networkId: string): Promise<FirewalledServicesSettings> {
  return { services: await listFirewalledServices(client, networkId) }
}

async function put(client: MerakiClient, networkId: string, settings: FirewalledServicesSettings): Promise<FirewalledServicesSettings> {
  for (const item of settings.services ?? []) {
    await updateFirewalledService(client, networkId, item.service, { access: item.access, allowedIps: item.allowedIps })
  }
  return get(client, networkId)
}

export const transport: SingletonTransport<FirewalledServicesSettings> = {
  label: 'firewalled services',
  get,
  put,
  validate(settings, field, errors, warnings) {
    if (!Array.isArray(settings.services)) {
      errors.push({ field: `${field}.services`, message: 'services must be an array.', code: 'INVALID_SERVICES' })
      return
    }
    settings.services.forEach((s, i) => {
      const itemField = `${field}.services[${i}]`
      if (!s.service || !s.access) {
        errors.push({ field: itemField, message: 'service and access are required.', code: 'REQUIRED' })
        return
      }
      if (!KNOWN_FIREWALLED_SERVICES.includes(s.service as (typeof KNOWN_FIREWALLED_SERVICES)[number])) {
        warnings.push({
          field: `${itemField}.service`,
          message: `"${s.service}" is not one of the documented services (${KNOWN_FIREWALLED_SERVICES.join(', ')}) — double-check the exact casing against your Meraki organization; Meraki will reject an unrecognized service name at deploy time.`,
          code: 'UNKNOWN_SERVICE',
        })
      }
      if (!FIREWALLED_SERVICE_ACCESS_VALUES.includes(s.access as (typeof FIREWALLED_SERVICE_ACCESS_VALUES)[number])) {
        errors.push({ field: `${itemField}.access`, message: `access must be one of ${FIREWALLED_SERVICE_ACCESS_VALUES.join(', ')}.`, code: 'INVALID_ACCESS' })
      }
      if (s.access === 'restricted' && (!Array.isArray(s.allowedIps) || s.allowedIps.length === 0)) {
        errors.push({ field: `${itemField}.allowedIps`, message: 'allowedIps is required (and must be non-empty) when access is "restricted".', code: 'REQUIRED' })
      }
    })
  },
}
