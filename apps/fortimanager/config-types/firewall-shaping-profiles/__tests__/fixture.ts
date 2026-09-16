import type { ConfigFixture } from '../../../lib/__tests__/configFixture'

/** The one configuration type whose FortiManager table is NOT keyed by `name`:
 *  a shaping profile's mkey is `profile-name`, so every delete must filter on
 *  that attribute or it removes nothing (or, worse, the wrong thing). */
export const fixture: ConfigFixture = {
  id: 'firewall-shaping-profiles',
  objectPath: '/obj/firewall/shaping-profile',
  mkey: 'profile-name',
  nameField: 'profileName',
  checkName: 'fmg-firewall-shaping-profile',
  name: 'wan-shaping',
  item: {
    id: 'item-1',
    name: 'wan-shaping',
    fields: {
      profileName: 'wan-shaping',
      type: 'policing',
      defaultClassId: 2,
      comment: 'WAN shaping profile',
      shapingEntries: '[{"id":2,"guaranteed-bandwidth-percentage":40}]',
    },
  },
  body: {
    'profile-name': 'wan-shaping',
    type: 'policing',
    'default-class-id': 2,
    comment: 'WAN shaping profile',
    'shaping-entries': [{ id: 2, 'guaranteed-bandwidth-percentage': 40 }],
  },
  livePrior: {
    'profile-name': 'wan-shaping',
    type: 'policing',
    'default-class-id': 5,
    comment: 'WAN shaping profile',
  },
  priorSnapshot: {
    'profile-name': 'wan-shaping',
    type: 'policing',
    'default-class-id': 5,
    comment: 'WAN shaping profile',
  },
  liveInSync: {
    'profile-name': 'wan-shaping',
    type: 'policing',
    'default-class-id': 2,
    comment: 'WAN shaping profile',
  },
  driftField: 'wan-shaping.default-class-id',
  deploySuccess: 'Deployed 1 firewall shaping profile(s)',
  deployFailurePrefix: 'Some shaping profiles failed',
  rollbackPrefix: 'Rolled back firewall shaping profiles',
}
