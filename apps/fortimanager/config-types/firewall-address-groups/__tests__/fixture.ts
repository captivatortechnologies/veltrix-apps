import type { ConfigFixture } from '../../../lib/__tests__/configFixture'

/** The live group is MISSING a member, and returns its members in the
 *  `{ name }` object form a `get` uses — both of which the handlers normalise. */
export const fixture: ConfigFixture = {
  id: 'firewall-address-groups',
  objectPath: '/obj/firewall/addrgrp',
  checkName: 'fmg-firewall-addrgrp',
  name: 'internal-nets',
  item: {
    id: 'item-1',
    name: 'internal-nets',
    fields: { name: 'internal-nets', members: 'net-a, net-b', comment: 'Internal networks' },
  },
  body: { name: 'internal-nets', member: ['net-a', 'net-b'], comment: 'Internal networks' },
  livePrior: { name: 'internal-nets', member: [{ name: 'net-a' }], comment: 'Internal networks' },
  priorSnapshot: { name: 'internal-nets', member: ['net-a'], comment: 'Internal networks' },
  liveInSync: { name: 'internal-nets', member: ['net-a', 'net-b'], comment: 'Internal networks' },
  driftField: 'internal-nets.member',
  deploySuccess: 'Deployed 1 firewall address group(s)',
  deployFailurePrefix: 'Some address groups failed',
  rollbackPrefix: 'Rolled back firewall address groups',
}
