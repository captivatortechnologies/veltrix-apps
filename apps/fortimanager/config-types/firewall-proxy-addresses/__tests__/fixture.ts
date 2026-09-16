import type { ConfigFixture } from '../../../lib/__tests__/configFixture'

/** The live object matches a different URL path than the canvas declares. */
export const fixture: ConfigFixture = {
  id: 'firewall-proxy-addresses',
  objectPath: '/obj/firewall/proxy-address',
  checkName: 'fmg-firewall-proxy-address',
  name: 'blocked-url',
  item: {
    id: 'item-1',
    name: 'blocked-url',
    fields: {
      name: 'blocked-url',
      type: 'url',
      host: 'web-hosts',
      path: '/downloads',
      comment: 'Blocked download path',
    },
  },
  body: { name: 'blocked-url', type: 'url', host: 'web-hosts', path: '/downloads', comment: 'Blocked download path' },
  livePrior: {
    name: 'blocked-url',
    type: 'url',
    host: 'web-hosts',
    path: '/uploads',
    comment: 'Blocked download path',
  },
  priorSnapshot: {
    name: 'blocked-url',
    type: 'url',
    host: 'web-hosts',
    path: '/uploads',
    comment: 'Blocked download path',
  },
  liveInSync: {
    name: 'blocked-url',
    type: 'url',
    host: 'web-hosts',
    path: '/downloads',
    comment: 'Blocked download path',
  },
  driftField: 'blocked-url.path',
  deploySuccess: 'Deployed 1 explicit-proxy address(es)',
  deployFailurePrefix: 'Some proxy addresses failed',
  rollbackPrefix: 'Rolled back explicit-proxy addresses',
}
