import type { ConfigFixture } from '../../../lib/__tests__/configFixture'

/**
 * The live service group has had a legacy cleartext service added to it by hand.
 * Every rule that matches the group now permits a protocol nobody approved.
 */
export const fixture: ConfigFixture = {
  id: 'panorama-service-groups',
  resourcePath: '/Objects/ServiceGroups',
  typeLabel: 'service group(s)',
  healthLabel: 'service group',

  name: 'app-services',
  item: {
    id: 'item-1',
    name: 'app-services',
    fields: { name: 'app-services', members: 'app-tls, syslog-udp' },
  },
  fields: { members: { member: ['app-tls', 'syslog-udp'] } },

  secondName: 'mgmt-services',
  secondItem: {
    id: 'item-2',
    name: 'mgmt-services',
    fields: { name: 'mgmt-services', members: 'service-https' },
  },
  secondFields: { members: { member: ['service-https'] } },

  liveInSync: { members: { member: ['syslog-udp', 'app-tls'] } },
  livePrior: { members: { member: ['app-tls', 'legacy-telnet'] } },
  drifts: [{
    field: 'app-services.members',
    expected: 'app-tls, syslog-udp',
    actual: 'app-tls, legacy-telnet',
    severity: 'warning',
  }],

  canvasOnlyValue: 'syslog-udp',
  liveOnlyValue: 'legacy-telnet',
}
