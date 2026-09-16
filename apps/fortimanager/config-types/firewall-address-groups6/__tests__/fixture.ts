import type { ConfigFixture } from '../../../lib/__tests__/configFixture'

export const fixture: ConfigFixture = {
  id: 'firewall-address-groups6',
  objectPath: '/obj/firewall/addrgrp6',
  checkName: 'fmg-firewall-addrgrp6',
  name: 'internal-nets6',
  item: {
    id: 'item-1',
    name: 'internal-nets6',
    fields: { name: 'internal-nets6', members: 'net6-a, net6-b', comment: 'Internal IPv6 networks' },
  },
  body: { name: 'internal-nets6', member: ['net6-a', 'net6-b'], comment: 'Internal IPv6 networks' },
  livePrior: { name: 'internal-nets6', member: [{ name: 'net6-a' }], comment: 'Internal IPv6 networks' },
  priorSnapshot: { name: 'internal-nets6', member: ['net6-a'], comment: 'Internal IPv6 networks' },
  liveInSync: { name: 'internal-nets6', member: ['net6-a', 'net6-b'], comment: 'Internal IPv6 networks' },
  driftField: 'internal-nets6.member',
  deploySuccess: 'Deployed 1 firewall IPv6 address group(s)',
  deployFailurePrefix: 'Some IPv6 address groups failed',
  rollbackPrefix: 'Rolled back firewall IPv6 address groups',
}
