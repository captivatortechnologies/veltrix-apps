import type { ConfigFixture } from '../../../lib/__tests__/configFixture'

/**
 * The live profile still blocks a category — just not the same one. Phishing has
 * been taken out of the block bucket and an unrelated category put in its place,
 * so the profile looks configured and enforced while the category it was written
 * for goes through.
 */
export const fixture: ConfigFixture = {
  id: 'panorama-url-filtering-profiles',
  resourcePath: '/Objects/URLFilteringSecurityProfiles',
  typeLabel: 'URL filtering profile(s)',
  healthLabel: 'URL filtering profile',

  name: 'corp-url-strict',
  item: {
    id: 'item-1',
    name: 'corp-url-strict',
    fields: {
      name: 'corp-url-strict',
      description: 'Corporate URL filtering',
      block: 'malware, phishing',
      alert: 'unknown',
      allow: 'business-and-economy',
      safe_search_enforcement: true,
      log_container_page_only: true,
    },
  },
  fields: {
    block: { member: ['malware', 'phishing'] },
    alert: { member: ['unknown'] },
    allow: { member: ['business-and-economy'] },
    'safe-search-enforcement': 'yes',
    'log-container-page-only': 'yes',
    description: 'Corporate URL filtering',
  },

  secondName: 'lab-url',
  secondItem: {
    id: 'item-2',
    name: 'lab-url',
    fields: { name: 'lab-url', alert: 'unknown' },
  },
  secondFields: {
    alert: { member: ['unknown'] },
    'safe-search-enforcement': 'no',
    'log-container-page-only': 'yes',
  },

  liveInSync: {
    block: { member: ['phishing', 'malware'] },
    alert: { member: ['unknown'] },
    allow: { member: ['business-and-economy'] },
    'safe-search-enforcement': 'yes',
    'log-container-page-only': 'yes',
    description: 'Corporate URL filtering',
  },
  livePrior: {
    block: { member: ['malware', 'questionable'] },
    alert: { member: ['unknown'] },
    allow: { member: ['business-and-economy'] },
    'safe-search-enforcement': 'yes',
    'log-container-page-only': 'yes',
    description: 'Corporate URL filtering',
  },
  drifts: [
    {
      field: 'corp-url-strict.block',
      expected: 'malware, phishing',
      actual: 'malware, questionable',
      severity: 'warning',
    },
  ],

  canvasOnlyValue: 'phishing',
  liveOnlyValue: 'questionable',
}
