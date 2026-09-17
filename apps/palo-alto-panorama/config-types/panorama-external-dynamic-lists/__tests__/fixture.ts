import type { ConfigFixture } from '../../../lib/__tests__/configFixture'

/**
 * The live EDL keeps its name and its schedule but has been repointed at a
 * different feed. Panorama will keep fetching, on time, from somewhere nobody
 * approved — the exact case drift detection exists to catch.
 */
export const fixture: ConfigFixture = {
  id: 'panorama-external-dynamic-lists',
  resourcePath: '/Objects/ExternalDynamicLists',
  typeLabel: 'external dynamic list(s)',
  healthLabel: 'external dynamic list',

  name: 'threat-ips',
  item: {
    id: 'item-1',
    name: 'threat-ips',
    fields: {
      name: 'threat-ips',
      type: 'ip',
      source_url: 'https://feeds.example.com/bad-ips.txt',
      recurring: 'hourly',
      description: 'Threat feed',
    },
  },
  fields: {
    type: {
      ip: {
        url: 'https://feeds.example.com/bad-ips.txt',
        recurring: { hourly: {} },
        description: 'Threat feed',
      },
    },
  },

  secondName: 'bad-domains',
  secondItem: {
    id: 'item-2',
    name: 'bad-domains',
    fields: {
      name: 'bad-domains',
      type: 'domain',
      source_url: 'https://feeds.example.com/bad-domains.txt',
      recurring: 'daily',
      recurring_at: '02',
    },
  },
  secondFields: {
    type: {
      domain: {
        url: 'https://feeds.example.com/bad-domains.txt',
        recurring: { daily: { at: '02' } },
        'expand-domain': 'no',
      },
    },
  },

  liveInSync: {
    type: {
      ip: {
        url: 'https://feeds.example.com/bad-ips.txt',
        recurring: { hourly: {} },
        description: 'Threat feed',
      },
    },
  },
  livePrior: {
    type: {
      ip: {
        url: 'https://attacker.example.net/list.txt',
        recurring: { hourly: {} },
        description: 'Threat feed',
      },
    },
  },
  drifts: [{
    field: 'threat-ips.url',
    expected: 'https://feeds.example.com/bad-ips.txt',
    actual: 'https://attacker.example.net/list.txt',
    severity: 'critical',
  }],

  canvasOnlyValue: 'feeds.example.com/bad-ips.txt',
  liveOnlyValue: 'attacker.example.net',
}
