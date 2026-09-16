import type { ConfigFixture } from '../../../lib/__tests__/configFixture'

/** The live sensor only MONITORS botnet connections where the canvas blocks
 *  them — the detection stays green while the control no longer enforces. */
export const fixture: ConfigFixture = {
  id: 'ips-sensors',
  objectPath: '/obj/ips/sensor',
  checkName: 'fmg-ips-sensor',
  name: 'edge-ips',
  item: {
    id: 'item-1',
    name: 'edge-ips',
    fields: {
      name: 'edge-ips',
      comment: 'Edge IPS sensor',
      blockMaliciousUrl: true,
      extendedLog: false,
      scanBotnetConnections: 'block',
      entries: '[{"id":1,"severity":["high","critical"],"status":"enable","action":"block"}]',
    },
  },
  body: {
    name: 'edge-ips',
    'block-malicious-url': 'enable',
    'extended-log': 'disable',
    'scan-botnet-connections': 'block',
    comment: 'Edge IPS sensor',
    entries: [{ id: 1, severity: ['high', 'critical'], status: 'enable', action: 'block' }],
  },
  livePrior: {
    name: 'edge-ips',
    comment: 'Edge IPS sensor',
    'block-malicious-url': 'enable',
    'extended-log': 'disable',
    'scan-botnet-connections': 'monitor',
  },
  priorSnapshot: {
    name: 'edge-ips',
    comment: 'Edge IPS sensor',
    'block-malicious-url': 'enable',
    'extended-log': 'disable',
    'scan-botnet-connections': 'monitor',
  },
  liveInSync: {
    name: 'edge-ips',
    comment: 'Edge IPS sensor',
    'block-malicious-url': 'enable',
    'extended-log': 'disable',
    'scan-botnet-connections': 'block',
  },
  driftField: 'edge-ips.scan-botnet-connections',
  deploySuccess: 'Deployed 1 IPS sensor(s)',
  deployFailurePrefix: 'Some IPS sensors failed',
  rollbackPrefix: 'Rolled back IPS sensors',
}
