import type { ConfigFixture } from '../../../lib/__tests__/configFixture'

/**
 * The live application group has had an anonymiser added to it by hand. Any
 * rule that allows the group now allows a category the policy was written to
 * keep out.
 */
export const fixture: ConfigFixture = {
  id: 'panorama-application-groups',
  resourcePath: '/Objects/ApplicationGroups',
  typeLabel: 'application group(s)',
  healthLabel: 'application group',

  name: 'corp-saas',
  item: {
    id: 'item-1',
    name: 'corp-saas',
    fields: { name: 'corp-saas', members: 'ms-office365, slack' },
  },
  fields: { members: { member: ['ms-office365', 'slack'] } },

  secondName: 'corp-vpn',
  secondItem: {
    id: 'item-2',
    name: 'corp-vpn',
    fields: { name: 'corp-vpn', members: 'ipsec-esp' },
  },
  secondFields: { members: { member: ['ipsec-esp'] } },

  liveInSync: { members: { member: ['slack', 'ms-office365'] } },
  livePrior: { members: { member: ['ms-office365', 'psiphon'] } },
  drifts: [{
    field: 'corp-saas.members',
    expected: 'ms-office365, slack',
    actual: 'ms-office365, psiphon',
    severity: 'warning',
  }],

  canvasOnlyValue: 'slack',
  liveOnlyValue: 'psiphon',
}
