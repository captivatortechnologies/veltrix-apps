import type { ConfigFixture } from '../../../lib/__tests__/configFixture'

/** The agent password is write-only. The live agent points at a different
 *  collector host, which silently changes who the firewall believes is signed in. */
export const fixture: ConfigFixture = {
  id: 'user-fsso-agents',
  objectPath: '/obj/user/fsso',
  checkName: 'fmg-user-fsso',
  name: 'corp-fsso',
  writeOnlySecret: 'fsso-agent-secret-MUST-NOT-LEAK',
  item: {
    id: 'item-1',
    name: 'corp-fsso',
    fields: {
      name: 'corp-fsso',
      server: 'fsso.corp.example.com',
      port: '8000',
      password: 'fsso-agent-secret-MUST-NOT-LEAK',
      type: 'default',
      ldapServer: 'corp-ldap',
    },
  },
  body: {
    name: 'corp-fsso',
    server: 'fsso.corp.example.com',
    type: 'default',
    port: 8000,
    password: 'fsso-agent-secret-MUST-NOT-LEAK',
    'ldap-server': 'corp-ldap',
  },
  livePrior: {
    name: 'corp-fsso',
    server: 'fsso-old.corp.example.com',
    port: 8000,
    type: 'default',
    'ldap-server': 'corp-ldap',
  },
  priorSnapshot: {
    name: 'corp-fsso',
    server: 'fsso-old.corp.example.com',
    port: 8000,
    type: 'default',
    'ldap-server': 'corp-ldap',
  },
  liveInSync: {
    name: 'corp-fsso',
    server: 'fsso.corp.example.com',
    port: 8000,
    type: 'default',
    'ldap-server': 'corp-ldap',
  },
  driftField: 'corp-fsso.server',
  deploySuccess: 'Deployed 1 FSSO agent(s)',
  deployFailurePrefix: 'Some FSSO agents failed',
  rollbackPrefix: 'Rolled back FSSO agents',
}
