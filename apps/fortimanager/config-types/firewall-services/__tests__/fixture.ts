import type { ConfigFixture } from '../../../lib/__tests__/configFixture'

/** The live service is missing a TCP port range the canvas declares — a policy
 *  built on it stops matching traffic nobody changed the policy for. */
export const fixture: ConfigFixture = {
  id: 'firewall-services',
  objectPath: '/obj/firewall/service/custom',
  checkName: 'fmg-firewall-service',
  name: 'app-https',
  item: {
    id: 'item-1',
    name: 'app-https',
    fields: { name: 'app-https', protocol: 'TCP/UDP/SCTP', tcpPortrange: '8443 9443', comment: 'App HTTPS ports' },
  },
  body: {
    name: 'app-https',
    protocol: 'TCP/UDP/SCTP',
    comment: 'App HTTPS ports',
    'tcp-portrange': ['8443', '9443'],
  },
  livePrior: {
    name: 'app-https',
    protocol: 'TCP/UDP/SCTP',
    'tcp-portrange': ['8443'],
    comment: 'App HTTPS ports',
  },
  priorSnapshot: {
    name: 'app-https',
    protocol: 'TCP/UDP/SCTP',
    'tcp-portrange': ['8443'],
    comment: 'App HTTPS ports',
  },
  liveInSync: {
    name: 'app-https',
    protocol: 'TCP/UDP/SCTP',
    'tcp-portrange': ['8443', '9443'],
    comment: 'App HTTPS ports',
  },
  driftField: 'app-https.tcp-portrange',
  deploySuccess: 'Deployed 1 firewall service(s)',
  deployFailurePrefix: 'Some services failed',
  rollbackPrefix: 'Rolled back firewall services',
}
