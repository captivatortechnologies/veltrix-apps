import type { ConfigFixture } from '../../../lib/__tests__/configFixture'

/** The live object differs from the canvas in its PREFIX, so a deploy that
 *  recorded the desired body instead of the live one fails the rollback test. */
export const fixture: ConfigFixture = {
  id: 'firewall-addresses6',
  objectPath: '/obj/firewall/address6',
  checkName: 'fmg-firewall-address6',
  name: 'dc-prefix',
  item: {
    id: 'item-1',
    name: 'dc-prefix',
    fields: { name: 'dc-prefix', type: 'ipprefix', ip6: '2001:db8:100::/64', comment: 'IPv6 datacentre prefix' },
  },
  body: { name: 'dc-prefix', type: 'ipprefix', comment: 'IPv6 datacentre prefix', ip6: '2001:db8:100::/64' },
  livePrior: { name: 'dc-prefix', type: 'ipprefix', ip6: '2001:db8:999::/64', comment: 'IPv6 datacentre prefix' },
  priorSnapshot: { name: 'dc-prefix', type: 'ipprefix', ip6: '2001:db8:999::/64', comment: 'IPv6 datacentre prefix' },
  liveInSync: { name: 'dc-prefix', type: 'ipprefix', ip6: '2001:db8:100::/64', comment: 'IPv6 datacentre prefix' },
  driftField: 'dc-prefix.ip6',
  deploySuccess: 'Deployed 1 IPv6 address(es)',
  deployFailurePrefix: 'Some IPv6 addresses failed',
  rollbackPrefix: 'Rolled back IPv6 addresses',
}
