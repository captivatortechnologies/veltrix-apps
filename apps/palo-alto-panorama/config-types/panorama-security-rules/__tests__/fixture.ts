import type { ConfigFixture } from '../../../lib/__tests__/configFixture'

/**
 * The live rule still has the name, the zones and the match criteria the canvas
 * declares — and its action has been flipped from deny to allow. Nothing about
 * the rule's presence gives that away; only the field compare does.
 */
export const fixture: ConfigFixture = {
  id: 'panorama-security-rules',
  resourcePath: '/Policies/SecurityPreRules',
  typeLabel: 'security rule(s)',
  healthLabel: 'rule',

  name: 'block-tor',
  item: {
    id: 'item-1',
    name: 'block-tor',
    fields: {
      name: 'block-tor',
      action: 'deny',
      from_zones: 'trust',
      to_zones: 'untrust',
      source: 'any',
      destination: 'any',
      application: 'tor',
      service: 'application-default',
      description: 'Block Tor',
      log_setting: 'default-forwarding',
      disabled: false,
      profile_group: 'corp-strict',
    },
  },
  fields: {
    from: { member: ['trust'] },
    to: { member: ['untrust'] },
    source: { member: ['any'] },
    destination: { member: ['any'] },
    application: { member: ['tor'] },
    service: { member: ['application-default'] },
    action: 'deny',
    disabled: 'no',
    description: 'Block Tor',
    'log-setting': 'default-forwarding',
    'profile-setting': { group: { member: ['corp-strict'] } },
  },

  secondName: 'allow-dns',
  secondItem: {
    id: 'item-2',
    name: 'allow-dns',
    fields: { name: 'allow-dns', action: 'allow', application: 'dns' },
  },
  secondFields: {
    from: { member: ['any'] },
    to: { member: ['any'] },
    source: { member: ['any'] },
    destination: { member: ['any'] },
    application: { member: ['dns'] },
    service: { member: ['application-default'] },
    action: 'allow',
    disabled: 'no',
  },

  liveInSync: {
    action: 'deny',
    from: { member: ['trust'] },
    to: { member: ['untrust'] },
    source: { member: ['any'] },
    destination: { member: ['any'] },
    application: { member: ['tor'] },
    service: { member: ['application-default'] },
    disabled: 'no',
  },
  livePrior: {
    action: 'allow',
    from: { member: ['trust'] },
    to: { member: ['untrust'] },
    source: { member: ['any'] },
    destination: { member: ['any'] },
    application: { member: ['tor'] },
    service: { member: ['application-default'] },
    disabled: 'no',
  },
  drifts: [{ field: 'block-tor.action', expected: 'deny', actual: 'allow', severity: 'warning' }],

  canvasOnlyValue: 'deny',
  liveOnlyValue: 'allow',
}
