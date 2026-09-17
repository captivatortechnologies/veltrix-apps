import type { ConfigFixture } from '../../../lib/__tests__/configFixture'

/**
 * The live PBF rule forwards the same traffic to the same next hop out of a
 * DIFFERENT egress interface. Policy-based forwarding overrides the routing
 * table, so branch traffic leaves by a path nobody chose.
 */
export const fixture: ConfigFixture = {
  id: 'panorama-pbf-rules',
  resourcePath: '/Policies/PolicyBasedForwardingPreRules',
  typeLabel: 'PBF rule(s)',
  healthLabel: 'rule',

  name: 'branch-egress',
  item: {
    id: 'item-1',
    name: 'branch-egress',
    fields: {
      name: 'branch-egress',
      from_zones: 'trust',
      source: '10.30.0.0/16',
      destination: 'any',
      application: 'any',
      service: 'any',
      action_type: 'forward',
      egress_interface: 'ethernet1/3',
      nexthop_type: 'ip',
      nexthop_value: '192.0.2.1',
      disabled: false,
      description: 'Branch break-out',
    },
  },
  fields: {
    from: { zone: { member: ['trust'] } },
    source: { member: ['10.30.0.0/16'] },
    destination: { member: ['any'] },
    application: { member: ['any'] },
    service: { member: ['any'] },
    action: { forward: { 'egress-interface': 'ethernet1/3', nexthop: { 'ip-address': '192.0.2.1' } } },
    'enforce-symmetric-return': { enabled: 'no' },
    disabled: 'no',
    description: 'Branch break-out',
  },

  secondName: 'drop-guest',
  secondItem: {
    id: 'item-2',
    name: 'drop-guest',
    fields: { name: 'drop-guest', from_zones: 'guest', action_type: 'discard' },
  },
  secondFields: {
    from: { zone: { member: ['guest'] } },
    source: { member: ['any'] },
    destination: { member: ['any'] },
    application: { member: ['any'] },
    service: { member: ['any'] },
    action: { discard: {} },
    'enforce-symmetric-return': { enabled: 'no' },
    disabled: 'no',
  },

  liveInSync: {
    from: { zone: { member: ['trust'] } },
    source: { member: ['10.30.0.0/16'] },
    destination: { member: ['any'] },
    application: { member: ['any'] },
    service: { member: ['any'] },
    action: { forward: { 'egress-interface': 'ethernet1/3', nexthop: { 'ip-address': '192.0.2.1' } } },
    'enforce-symmetric-return': { enabled: 'no' },
    disabled: 'no',
  },
  livePrior: {
    from: { zone: { member: ['trust'] } },
    source: { member: ['10.30.0.0/16'] },
    destination: { member: ['any'] },
    application: { member: ['any'] },
    service: { member: ['any'] },
    action: { forward: { 'egress-interface': 'ethernet1/7', nexthop: { 'ip-address': '192.0.2.1' } } },
    'enforce-symmetric-return': { enabled: 'no' },
    disabled: 'no',
  },
  drifts: [{
    field: 'branch-egress.action',
    expected: 'forward:iface=ethernet1/3;nexthop=ip:192.0.2.1;monitor=none',
    actual: 'forward:iface=ethernet1/7;nexthop=ip:192.0.2.1;monitor=none',
    severity: 'critical',
  }],

  canvasOnlyValue: 'ethernet1/3',
  liveOnlyValue: 'ethernet1/7',
}
