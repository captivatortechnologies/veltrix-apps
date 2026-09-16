import type { ConfigFixture } from '../../../lib/__tests__/configFixture'

/** The live pool ends at a different address — a NAT pool quietly widened past
 *  the range the customer owns is exactly what drift detection is for. */
export const fixture: ConfigFixture = {
  id: 'firewall-ip-pools',
  objectPath: '/obj/firewall/ippool',
  checkName: 'fmg-firewall-ippool',
  name: 'nat-pool-a',
  item: {
    id: 'item-1',
    name: 'nat-pool-a',
    fields: {
      name: 'nat-pool-a',
      type: 'overload',
      startIp: '203.0.113.10',
      endIp: '203.0.113.20',
      comment: 'Edge NAT pool',
    },
  },
  body: {
    name: 'nat-pool-a',
    type: 'overload',
    startip: '203.0.113.10',
    endip: '203.0.113.20',
    comments: 'Edge NAT pool',
  },
  livePrior: {
    name: 'nat-pool-a',
    type: 'overload',
    startip: '203.0.113.10',
    endip: '203.0.113.99',
    comments: 'Edge NAT pool',
  },
  priorSnapshot: {
    name: 'nat-pool-a',
    type: 'overload',
    startip: '203.0.113.10',
    endip: '203.0.113.99',
    comments: 'Edge NAT pool',
  },
  liveInSync: {
    name: 'nat-pool-a',
    type: 'overload',
    startip: '203.0.113.10',
    endip: '203.0.113.20',
    comments: 'Edge NAT pool',
  },
  driftField: 'nat-pool-a.endip',
  deploySuccess: 'Deployed 1 firewall IP pool(s)',
  deployFailurePrefix: 'Some IP pools failed',
  rollbackPrefix: 'Rolled back firewall IP pools',
}
