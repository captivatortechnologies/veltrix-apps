import type { ConfigFixture } from '../../../lib/__tests__/configFixture'

/** The shared secret is write-only: sent on every deploy, never read back, and
 *  never a side of a diff. The live server points at a different host. */
export const fixture: ConfigFixture = {
  id: 'user-radius-servers',
  objectPath: '/obj/user/radius',
  checkName: 'fmg-user-radius',
  name: 'corp-radius',
  writeOnlySecret: 'radius-shared-secret-MUST-NOT-LEAK',
  item: {
    id: 'item-1',
    name: 'corp-radius',
    fields: {
      name: 'corp-radius',
      server: 'radius.corp.example.com',
      secret: 'radius-shared-secret-MUST-NOT-LEAK',
      authType: 'pap',
      nasIp: '10.0.0.1',
      radiusPort: '1812',
      timeout: '5',
    },
  },
  body: {
    name: 'corp-radius',
    server: 'radius.corp.example.com',
    'auth-type': 'pap',
    secret: 'radius-shared-secret-MUST-NOT-LEAK',
    'nas-ip': '10.0.0.1',
    'radius-port': 1812,
    timeout: 5,
  },
  livePrior: {
    name: 'corp-radius',
    server: 'radius-old.corp.example.com',
    'auth-type': 'pap',
    'nas-ip': '10.0.0.1',
    'radius-port': 1812,
    timeout: 5,
  },
  priorSnapshot: {
    name: 'corp-radius',
    server: 'radius-old.corp.example.com',
    'auth-type': 'pap',
    'nas-ip': '10.0.0.1',
    'radius-port': 1812,
    timeout: 5,
  },
  liveInSync: {
    name: 'corp-radius',
    server: 'radius.corp.example.com',
    'auth-type': 'pap',
    'nas-ip': '10.0.0.1',
    'radius-port': 1812,
    timeout: 5,
  },
  driftField: 'corp-radius.server',
  deploySuccess: 'Deployed 1 RADIUS server(s)',
  deployFailurePrefix: 'Some RADIUS servers failed',
  rollbackPrefix: 'Rolled back RADIUS servers',
}
