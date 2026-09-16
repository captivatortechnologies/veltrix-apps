import type { ConfigFixture } from '../../../lib/__tests__/configFixture'

export const fixture: ConfigFixture = {
  id: 'firewall-ippools6',
  objectPath: '/obj/firewall/ippool6',
  checkName: 'fmg-firewall-ippool6',
  name: 'nat6-pool-a',
  item: {
    id: 'item-1',
    name: 'nat6-pool-a',
    fields: {
      name: 'nat6-pool-a',
      startIp: '2001:db8:200::10',
      endIp: '2001:db8:200::20',
      comment: 'Edge IPv6 NAT pool',
    },
  },
  body: {
    name: 'nat6-pool-a',
    startip: '2001:db8:200::10',
    endip: '2001:db8:200::20',
    comments: 'Edge IPv6 NAT pool',
  },
  livePrior: {
    name: 'nat6-pool-a',
    startip: '2001:db8:200::10',
    endip: '2001:db8:200::99',
    comments: 'Edge IPv6 NAT pool',
  },
  priorSnapshot: {
    name: 'nat6-pool-a',
    startip: '2001:db8:200::10',
    endip: '2001:db8:200::99',
    comments: 'Edge IPv6 NAT pool',
  },
  liveInSync: {
    name: 'nat6-pool-a',
    startip: '2001:db8:200::10',
    endip: '2001:db8:200::20',
    comments: 'Edge IPv6 NAT pool',
  },
  driftField: 'nat6-pool-a.endip',
  deploySuccess: 'Deployed 1 firewall IPv6 pool(s)',
  deployFailurePrefix: 'Some IPv6 pools failed',
  rollbackPrefix: 'Rolled back firewall IPv6 pools',
}
