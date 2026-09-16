import type { ConfigFixture } from '../../../lib/__tests__/configFixture'

/** The live object differs from the canvas in its SUBNET, so a deploy that
 *  recorded the desired body instead of the live one fails the rollback test. */
export const fixture: ConfigFixture = {
  id: 'firewall-addresses',
  objectPath: '/obj/firewall/address',
  checkName: 'fmg-firewall-address',
  name: 'dmz-servers',
  item: {
    id: 'item-1',
    name: 'dmz-servers',
    fields: { name: 'dmz-servers', type: 'ipmask', subnetCidr: '10.0.100.0/24', comment: 'DMZ server range' },
  },
  body: {
    name: 'dmz-servers',
    type: 'ipmask',
    comment: 'DMZ server range',
    subnet: ['10.0.100.0', '255.255.255.0'],
  },
  livePrior: {
    name: 'dmz-servers',
    type: 'ipmask',
    subnet: ['10.0.99.0', '255.255.255.0'],
    comment: 'DMZ server range',
  },
  priorSnapshot: {
    name: 'dmz-servers',
    type: 'ipmask',
    subnet: ['10.0.99.0', '255.255.255.0'],
    comment: 'DMZ server range',
  },
  liveInSync: {
    name: 'dmz-servers',
    type: 'ipmask',
    subnet: ['10.0.100.0', '255.255.255.0'],
    comment: 'DMZ server range',
  },
  driftField: 'dmz-servers.subnet',
  deploySuccess: 'Deployed 1 firewall address(es)',
  deployFailurePrefix: 'Some addresses failed',
  rollbackPrefix: 'Rolled back firewall addresses',
}
