import type { ConfigFixture } from '../../../lib/__tests__/configFixture'

/**
 * The live rule still decrypts, on the same zones, with the same profile — but
 * its type has been changed from outbound TLS interception to SSH proxying. The
 * rule is present, enabled and "decrypt"; HTTPS simply stopped being inspected.
 */
export const fixture: ConfigFixture = {
  id: 'panorama-decryption-rules',
  resourcePath: '/Policies/DecryptionPreRules',
  typeLabel: 'decryption rule(s)',
  healthLabel: 'rule',

  name: 'decrypt-outbound',
  item: {
    id: 'item-1',
    name: 'decrypt-outbound',
    fields: {
      name: 'decrypt-outbound',
      from_zones: 'trust',
      to_zones: 'untrust',
      source: 'any',
      destination: 'any',
      category: 'any',
      service: 'any',
      type: 'ssl-forward-proxy',
      action: 'decrypt',
      profile: 'corp-decryption-profile',
      log_setting: 'default-forwarding',
      log_success: false,
      log_fail: true,
      disabled: false,
      description: 'Outbound TLS inspection',
    },
  },
  fields: {
    from: { member: ['trust'] },
    to: { member: ['untrust'] },
    source: { member: ['any'] },
    destination: { member: ['any'] },
    category: { member: ['any'] },
    service: { member: ['any'] },
    type: { 'ssl-forward-proxy': {} },
    action: 'decrypt',
    'log-success': 'no',
    'log-fail': 'yes',
    disabled: 'no',
    profile: 'corp-decryption-profile',
    'log-setting': 'default-forwarding',
    description: 'Outbound TLS inspection',
  },

  secondName: 'no-decrypt-finance',
  secondItem: {
    id: 'item-2',
    name: 'no-decrypt-finance',
    fields: { name: 'no-decrypt-finance', category: 'financial-services', action: 'no-decrypt' },
  },
  secondFields: {
    from: { member: ['any'] },
    to: { member: ['any'] },
    source: { member: ['any'] },
    destination: { member: ['any'] },
    category: { member: ['financial-services'] },
    service: { member: ['any'] },
    type: { 'ssl-forward-proxy': {} },
    action: 'no-decrypt',
    'log-success': 'no',
    'log-fail': 'yes',
    disabled: 'no',
  },

  liveInSync: {
    from: { member: ['trust'] },
    to: { member: ['untrust'] },
    source: { member: ['any'] },
    destination: { member: ['any'] },
    category: { member: ['any'] },
    service: { member: ['any'] },
    type: { 'ssl-forward-proxy': {} },
    action: 'decrypt',
    profile: 'corp-decryption-profile',
    'log-setting': 'default-forwarding',
    disabled: 'no',
  },
  livePrior: {
    from: { member: ['trust'] },
    to: { member: ['untrust'] },
    source: { member: ['any'] },
    destination: { member: ['any'] },
    category: { member: ['any'] },
    service: { member: ['any'] },
    type: { 'ssh-proxy': {} },
    action: 'decrypt',
    profile: 'corp-decryption-profile',
    'log-setting': 'default-forwarding',
    disabled: 'no',
  },
  drifts: [{
    field: 'decrypt-outbound.type',
    expected: 'ssl-forward-proxy',
    actual: 'ssh-proxy',
    severity: 'warning',
  }],

  canvasOnlyValue: 'ssl-forward-proxy',
  liveOnlyValue: 'ssh-proxy',
}
