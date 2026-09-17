import type { ConfigFixture } from '../../../lib/__tests__/configFixture'

/**
 * The live NAT rule still matches the same traffic on the same interface, but
 * translates it behind a different public address. Everything downstream that
 * allow-lists the egress IP — partners, cloud tenants, the customer's own
 * geo-fencing — silently stops recognising this estate.
 */
export const fixture: ConfigFixture = {
  id: 'panorama-nat-rules',
  resourcePath: '/Policies/NATPreRules',
  typeLabel: 'NAT rule(s)',
  healthLabel: 'NAT rule',

  name: 'outbound-nat',
  item: {
    id: 'item-1',
    name: 'outbound-nat',
    fields: {
      name: 'outbound-nat',
      from_zones: 'trust',
      to_zones: 'untrust',
      source: '10.0.0.0/8',
      destination: 'any',
      service: 'any',
      to_interface: 'ethernet1/1',
      source_translation_type: 'dynamic-ip-and-port',
      source_translation_interface: 'ethernet1/1',
      source_translation_interface_ip: '203.0.113.10',
      disabled: false,
      description: 'Outbound PAT',
    },
  },
  fields: {
    'nat-type': 'ipv4',
    from: { member: ['trust'] },
    to: { member: ['untrust'] },
    source: { member: ['10.0.0.0/8'] },
    destination: { member: ['any'] },
    service: 'any',
    disabled: 'no',
    'to-interface': 'ethernet1/1',
    description: 'Outbound PAT',
    'source-translation': {
      'dynamic-ip-and-port': { 'interface-address': { interface: 'ethernet1/1', ip: '203.0.113.10' } },
    },
  },

  secondName: 'inbound-web',
  secondItem: {
    id: 'item-2',
    name: 'inbound-web',
    fields: {
      name: 'inbound-web',
      from_zones: 'untrust',
      to_zones: 'dmz',
      destination: '198.51.100.20',
      service: 'service-https',
      destination_translated_address: '10.20.0.5',
      destination_translated_port: '8443',
    },
  },
  secondFields: {
    'nat-type': 'ipv4',
    from: { member: ['untrust'] },
    to: { member: ['dmz'] },
    source: { member: ['any'] },
    destination: { member: ['198.51.100.20'] },
    service: 'service-https',
    disabled: 'no',
    'destination-translation': { 'translated-address': '10.20.0.5', 'translated-port': 8443 },
  },

  liveInSync: {
    from: { member: ['trust'] },
    to: { member: ['untrust'] },
    source: { member: ['10.0.0.0/8'] },
    destination: { member: ['any'] },
    service: 'any',
    'source-translation': {
      'dynamic-ip-and-port': { 'interface-address': { interface: 'ethernet1/1', ip: '203.0.113.10' } },
    },
    disabled: 'no',
  },
  livePrior: {
    from: { member: ['trust'] },
    to: { member: ['untrust'] },
    source: { member: ['10.0.0.0/8'] },
    destination: { member: ['any'] },
    service: 'any',
    'source-translation': {
      'dynamic-ip-and-port': { 'interface-address': { interface: 'ethernet1/1', ip: '192.0.2.77' } },
    },
    disabled: 'no',
  },
  drifts: [{
    field: 'outbound-nat.source-translation',
    expected: 'dipp:iface=ethernet1/1:203.0.113.10',
    actual: 'dipp:iface=ethernet1/1:192.0.2.77',
    severity: 'warning',
  }],

  canvasOnlyValue: '203.0.113.10',
  liveOnlyValue: '192.0.2.77',
}
