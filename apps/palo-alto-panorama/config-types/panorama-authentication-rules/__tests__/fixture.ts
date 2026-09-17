import type { ConfigFixture } from '../../../lib/__tests__/configFixture'

/**
 * The live rule still matches the same traffic and still "enforces
 * authentication" — against Panorama's built-in no-challenge object. The rule is
 * present and enabled, and multi-factor authentication is off for everything it
 * covers.
 */
export const fixture: ConfigFixture = {
  id: 'panorama-authentication-rules',
  resourcePath: '/Policies/AuthenticationPreRules',
  typeLabel: 'authentication rule(s)',
  healthLabel: 'rule',

  name: 'mfa-admin-apps',
  item: {
    id: 'item-1',
    name: 'mfa-admin-apps',
    fields: {
      name: 'mfa-admin-apps',
      source_zones: 'trust',
      destination_zones: 'dmz',
      source_addresses: 'any',
      destination_addresses: '10.20.0.0/24',
      source_users: 'any',
      service: 'any',
      category: 'any',
      authentication_enforcement: 'corp-mfa',
      timeout: 60,
      log_authentication_timeout: true,
      log_setting: 'default-forwarding',
      disabled: false,
      description: 'MFA for admin apps',
    },
  },
  fields: {
    from: { member: ['trust'] },
    to: { member: ['dmz'] },
    source: { member: ['any'] },
    destination: { member: ['10.20.0.0/24'] },
    'source-user': { member: ['any'] },
    service: { member: ['any'] },
    category: { member: ['any'] },
    'authentication-enforcement': 'corp-mfa',
    timeout: 60,
    'log-authentication-timeout': 'yes',
    disabled: 'no',
    'log-setting': 'default-forwarding',
    description: 'MFA for admin apps',
  },

  secondName: 'mfa-vpn',
  secondItem: {
    id: 'item-2',
    name: 'mfa-vpn',
    fields: { name: 'mfa-vpn', authentication_enforcement: 'corp-mfa' },
  },
  secondFields: {
    from: { member: ['any'] },
    to: { member: ['any'] },
    source: { member: ['any'] },
    destination: { member: ['any'] },
    'source-user': { member: ['any'] },
    service: { member: ['any'] },
    category: { member: ['any'] },
    'authentication-enforcement': 'corp-mfa',
    timeout: 60,
    'log-authentication-timeout': 'yes',
    disabled: 'no',
  },

  liveInSync: {
    from: { member: ['trust'] },
    to: { member: ['dmz'] },
    source: { member: ['any'] },
    destination: { member: ['10.20.0.0/24'] },
    'source-user': { member: ['any'] },
    service: { member: ['any'] },
    category: { member: ['any'] },
    'authentication-enforcement': 'corp-mfa',
    timeout: 60,
    'log-authentication-timeout': 'yes',
    'log-setting': 'default-forwarding',
    disabled: 'no',
  },
  livePrior: {
    from: { member: ['trust'] },
    to: { member: ['dmz'] },
    source: { member: ['any'] },
    destination: { member: ['10.20.0.0/24'] },
    'source-user': { member: ['any'] },
    service: { member: ['any'] },
    category: { member: ['any'] },
    'authentication-enforcement': 'default-web-form',
    timeout: 60,
    'log-authentication-timeout': 'yes',
    'log-setting': 'default-forwarding',
    disabled: 'no',
  },
  drifts: [{
    field: 'mfa-admin-apps.authentication-enforcement',
    expected: 'corp-mfa',
    actual: 'default-web-form',
    severity: 'critical',
  }],

  canvasOnlyValue: 'corp-mfa',
  liveOnlyValue: 'default-web-form',
}
