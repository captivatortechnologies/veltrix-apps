import type { ConfigFixture } from '../../../lib/__tests__/configFixture'

/** The live group has lost a member authentication source. */
export const fixture: ConfigFixture = {
  id: 'user-groups',
  objectPath: '/obj/user/group',
  checkName: 'fmg-user-group',
  name: 'vpn-users',
  item: {
    id: 'item-1',
    name: 'vpn-users',
    fields: {
      name: 'vpn-users',
      groupType: 'firewall',
      members: 'corp-ldap, corp-radius',
      authTimeout: '30',
      logicType: 'or',
    },
  },
  body: {
    name: 'vpn-users',
    'group-type': 'firewall',
    member: ['corp-ldap', 'corp-radius'],
    authtimeout: 30,
    'logic-type': 'or',
  },
  livePrior: {
    name: 'vpn-users',
    'group-type': 'firewall',
    member: [{ name: 'corp-ldap' }],
    authtimeout: 30,
    'logic-type': 'or',
  },
  priorSnapshot: {
    name: 'vpn-users',
    member: ['corp-ldap'],
    'group-type': 'firewall',
    authtimeout: 30,
    'logic-type': 'or',
  },
  liveInSync: {
    name: 'vpn-users',
    'group-type': 'firewall',
    member: ['corp-ldap', 'corp-radius'],
    authtimeout: 30,
    'logic-type': 'or',
  },
  driftField: 'vpn-users.member',
  deploySuccess: 'Deployed 1 user group(s)',
  deployFailurePrefix: 'Some user groups failed',
  rollbackPrefix: 'Rolled back user groups',
}
