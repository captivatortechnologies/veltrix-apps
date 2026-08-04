// =============================================================================
// Shared types/validation for Cisco Meraki Appliance Intrusion (IPS) settings.
//
// Singleton-settings-per-network shape — see lib/merakiSingleton.ts. The whole
// documented request object (mode / idsRulesets / protectedNetworks) is
// authored as one JSON blob (`settings`); `transport.validate` checks the
// documented enums plus the conditional requirement Meraki's own schema
// states: `protectedNetworks.includedCidr`/`excludedCidr` are REQUIRED when
// `useDefault` is false.
//
// NOTE: schema follows the documented Meraki Dashboard API v1
// (https://developer.cisco.com/meraki/api-v1/update-network-appliance-security-intrusion/).
// Verify against a live Meraki organization.
// =============================================================================

import { getIntrusionSettings, putIntrusionSettings } from '../../lib/merakiApi'
import type { SingletonTransport } from '../../lib/merakiSingleton'

export const INTRUSION_MODES = ['disabled', 'detection', 'prevention'] as const
export const INTRUSION_IDS_RULESETS = ['connectivity', 'balanced', 'security'] as const

export interface MerakiIntrusionSettings {
  mode?: string
  idsRulesets?: string
  protectedNetworks?: { useDefault?: boolean; includedCidr?: string[]; excludedCidr?: string[] }
  [key: string]: unknown
}

export const transport: SingletonTransport<MerakiIntrusionSettings> = {
  label: 'appliance intrusion settings',
  get: getIntrusionSettings,
  put: putIntrusionSettings,
  validate(settings, field, errors) {
    if (settings.mode && !INTRUSION_MODES.includes(settings.mode as (typeof INTRUSION_MODES)[number])) {
      errors.push({ field: `${field}.mode`, message: `mode must be one of ${INTRUSION_MODES.join(', ')}.`, code: 'INVALID_MODE' })
    }
    if (settings.idsRulesets && !INTRUSION_IDS_RULESETS.includes(settings.idsRulesets as (typeof INTRUSION_IDS_RULESETS)[number])) {
      errors.push({ field: `${field}.idsRulesets`, message: `idsRulesets must be one of ${INTRUSION_IDS_RULESETS.join(', ')}.`, code: 'INVALID_RULESET' })
    }
    const pn = settings.protectedNetworks
    if (pn && pn.useDefault === false) {
      if (!Array.isArray(pn.includedCidr) || pn.includedCidr.length === 0) {
        errors.push({ field: `${field}.protectedNetworks.includedCidr`, message: 'includedCidr is required (and must be non-empty) when protectedNetworks.useDefault is false.', code: 'REQUIRED' })
      }
      if (!Array.isArray(pn.excludedCidr) || pn.excludedCidr.length === 0) {
        errors.push({ field: `${field}.protectedNetworks.excludedCidr`, message: 'excludedCidr is required (and must be non-empty) when protectedNetworks.useDefault is false.', code: 'REQUIRED' })
      }
    }
  },
}
