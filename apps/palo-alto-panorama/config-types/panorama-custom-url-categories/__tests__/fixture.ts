import type { ConfigFixture } from '../../../lib/__tests__/configFixture'

/**
 * The live deny list has been edited by hand: one of the domains the canvas
 * blocks is gone, replaced by a stale entry. The category still exists, so every
 * rule referencing it still loads — it just stopped blocking what it was for.
 */
export const fixture: ConfigFixture = {
  id: 'panorama-custom-url-categories',
  resourcePath: '/Objects/CustomURLCategories',
  typeLabel: 'custom URL category(ies)',
  healthLabel: 'custom URL category',

  name: 'blocked-sites',
  item: {
    id: 'item-1',
    name: 'blocked-sites',
    fields: {
      name: 'blocked-sites',
      type: 'URL List',
      list: 'bad.example.com, worse.example.net',
      description: 'Deny list',
    },
  },
  fields: {
    type: 'URL List',
    list: { member: ['bad.example.com', 'worse.example.net'] },
    description: 'Deny list',
  },

  secondName: 'allowed-sites',
  secondItem: {
    id: 'item-2',
    name: 'allowed-sites',
    fields: { name: 'allowed-sites', type: 'Category Match', list: 'business-and-economy' },
  },
  secondFields: { type: 'Category Match', list: { member: ['business-and-economy'] } },

  liveInSync: {
    type: 'URL List',
    list: { member: ['worse.example.net', 'bad.example.com'] },
    description: 'Deny list',
  },
  livePrior: {
    type: 'URL List',
    list: { member: ['bad.example.com', 'stale.example.org'] },
    description: 'Deny list',
  },
  drifts: [{
    field: 'blocked-sites.list',
    expected: 'bad.example.com, worse.example.net',
    actual: 'bad.example.com, stale.example.org',
    severity: 'warning',
  }],

  canvasOnlyValue: 'worse.example.net',
  liveOnlyValue: 'stale.example.org',
}
