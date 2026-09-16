import type { ConfigFixture } from '../../../lib/__tests__/configFixture'

export const fixture: ConfigFixture = {
  id: 'firewall-proxy-address-groups',
  objectPath: '/obj/firewall/proxy-addrgrp',
  checkName: 'fmg-firewall-proxy-addrgrp',
  name: 'proxy-src-group',
  item: {
    id: 'item-1',
    name: 'proxy-src-group',
    fields: {
      name: 'proxy-src-group',
      type: 'src',
      members: 'blocked-url, allowed-url',
      comment: 'Proxy source set',
    },
  },
  body: {
    name: 'proxy-src-group',
    type: 'src',
    member: ['blocked-url', 'allowed-url'],
    comment: 'Proxy source set',
  },
  livePrior: {
    name: 'proxy-src-group',
    type: 'src',
    member: [{ name: 'blocked-url' }],
    comment: 'Proxy source set',
  },
  priorSnapshot: {
    name: 'proxy-src-group',
    member: ['blocked-url'],
    type: 'src',
    comment: 'Proxy source set',
  },
  liveInSync: {
    name: 'proxy-src-group',
    type: 'src',
    member: ['blocked-url', 'allowed-url'],
    comment: 'Proxy source set',
  },
  driftField: 'proxy-src-group.member',
  deploySuccess: 'Deployed 1 explicit-proxy address group(s)',
  deployFailurePrefix: 'Some proxy address groups failed',
  rollbackPrefix: 'Rolled back explicit-proxy address groups',
}
