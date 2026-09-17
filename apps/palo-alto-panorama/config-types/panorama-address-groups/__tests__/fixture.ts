import type { ConfigFixture } from '../../../lib/__tests__/configFixture'

/**
 * The live group has had a member swapped by hand: the host the canvas declares
 * is gone and a legacy one is in its place. Every rule that matches on the group
 * still matches — just not the machines the operator thinks.
 */
export const fixture: ConfigFixture = {
  id: 'panorama-address-groups',
  resourcePath: '/Objects/AddressGroups',
  typeLabel: 'address group(s)',
  healthLabel: 'address group',

  name: 'web-tier',
  item: {
    id: 'item-1',
    name: 'web-tier',
    fields: { name: 'web-tier', group_type: 'static', members: 'web-1, web-2' },
  },
  fields: { static: { member: ['web-1', 'web-2'] } },

  secondName: 'db-tier',
  secondItem: {
    id: 'item-2',
    name: 'db-tier',
    fields: { name: 'db-tier', group_type: 'dynamic', dynamic_filter: "'db' and 'prod'" },
  },
  secondFields: { dynamic: { filter: "'db' and 'prod'" } },

  liveInSync: { static: { member: ['web-2', 'web-1'] } },
  livePrior: { static: { member: ['web-1', 'legacy-web-9'] } },
  drifts: [{
    field: 'web-tier.members',
    expected: 'web-1, web-2',
    actual: 'web-1, legacy-web-9',
    severity: 'warning',
  }],

  canvasOnlyValue: 'web-2',
  liveOnlyValue: 'legacy-web-9',
}
