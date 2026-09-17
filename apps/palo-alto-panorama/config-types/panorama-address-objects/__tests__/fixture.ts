import type { ConfigFixture } from '../../../lib/__tests__/configFixture'

/**
 * The live address object still carries the name every security rule references,
 * but points at a different subnet than the canvas declares — the rules stayed
 * where they were and the traffic they match quietly moved.
 */
export const fixture: ConfigFixture = {
  id: 'panorama-address-objects',
  resourcePath: '/Objects/Addresses',
  typeLabel: 'address object(s)',
  healthLabel: 'address',

  name: 'web-1',
  item: {
    id: 'item-1',
    name: 'web-1',
    fields: {
      name: 'web-1',
      type: 'ip-netmask',
      value: '10.10.0.0/24',
      description: 'Web tier',
      tags: 'veltrix-managed',
    },
  },
  fields: {
    'ip-netmask': '10.10.0.0/24',
    description: 'Web tier',
    tag: { member: ['veltrix-managed'] },
  },

  secondName: 'db-1',
  secondItem: {
    id: 'item-2',
    name: 'db-1',
    fields: { name: 'db-1', type: 'fqdn', value: 'db.example.com' },
  },
  secondFields: { fqdn: 'db.example.com' },

  liveInSync: { 'ip-netmask': '10.10.0.0/24', description: 'Web tier', tag: { member: ['veltrix-managed'] } },
  livePrior: { 'ip-netmask': '10.10.99.0/24', description: 'Web tier', tag: { member: ['veltrix-managed'] } },
  drifts: [{
    field: 'web-1.ip-netmask',
    expected: '10.10.0.0/24',
    actual: '10.10.99.0/24',
    severity: 'warning',
  }],

  canvasOnlyValue: '10.10.0.0/24',
  liveOnlyValue: '10.10.99.0/24',
}
