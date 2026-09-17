import type { ConfigFixture } from '../../../lib/__tests__/configFixture'

/**
 * The live service still has the name the rules reference but answers on a
 * cleartext port — the rule that was meant to allow TLS now allows HTTP.
 */
export const fixture: ConfigFixture = {
  id: 'panorama-service-objects',
  resourcePath: '/Objects/Services',
  typeLabel: 'service object(s)',
  healthLabel: 'service',

  name: 'app-tls',
  item: {
    id: 'item-1',
    name: 'app-tls',
    fields: { name: 'app-tls', protocol: 'tcp', port: '8443', description: 'App TLS' },
  },
  fields: { protocol: { tcp: { port: '8443' } }, description: 'App TLS' },

  secondName: 'syslog-udp',
  secondItem: {
    id: 'item-2',
    name: 'syslog-udp',
    fields: { name: 'syslog-udp', protocol: 'udp', port: '514' },
  },
  secondFields: { protocol: { udp: { port: '514' } } },

  liveInSync: { protocol: { tcp: { port: '8443' } }, description: 'App TLS' },
  livePrior: { protocol: { tcp: { port: '8080' } }, description: 'App TLS' },
  drifts: [{ field: 'app-tls.tcp.port', expected: '8443', actual: '8080', severity: 'warning' }],

  canvasOnlyValue: '8443',
  liveOnlyValue: '8080',
}
