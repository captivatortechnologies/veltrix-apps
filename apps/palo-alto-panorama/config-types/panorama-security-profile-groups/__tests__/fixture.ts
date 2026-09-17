import type { ConfigFixture } from '../../../lib/__tests__/configFixture'

/**
 * The live group still references a profile in every category — but its URL
 * filtering slot points at a permissive profile instead of the strict one. Every
 * rule that uses this group inherits the swap without any of them changing.
 */
export const fixture: ConfigFixture = {
  id: 'panorama-security-profile-groups',
  resourcePath: '/Objects/SecurityProfileGroups',
  typeLabel: 'security profile group(s)',
  healthLabel: 'security profile group',

  name: 'corp-strict',
  item: {
    id: 'item-1',
    name: 'corp-strict',
    fields: {
      name: 'corp-strict',
      virus: 'corp-av',
      spyware: 'corp-spyware',
      vulnerability: 'corp-vuln',
      url_filtering: 'corp-url-strict',
      file_blocking: 'corp-executables',
      wildfire_analysis: 'corp-wildfire',
      data_filtering: 'corp-dlp',
    },
  },
  fields: {
    virus: { member: ['corp-av'] },
    spyware: { member: ['corp-spyware'] },
    vulnerability: { member: ['corp-vuln'] },
    'url-filtering': { member: ['corp-url-strict'] },
    'file-blocking': { member: ['corp-executables'] },
    'wildfire-analysis': { member: ['corp-wildfire'] },
    'data-filtering': { member: ['corp-dlp'] },
  },

  secondName: 'lab-basic',
  secondItem: {
    id: 'item-2',
    name: 'lab-basic',
    fields: { name: 'lab-basic', virus: 'lab-av' },
  },
  secondFields: { virus: { member: ['lab-av'] } },

  liveInSync: {
    virus: { member: ['corp-av'] },
    spyware: { member: ['corp-spyware'] },
    vulnerability: { member: ['corp-vuln'] },
    'url-filtering': { member: ['corp-url-strict'] },
    'file-blocking': { member: ['corp-executables'] },
    'wildfire-analysis': { member: ['corp-wildfire'] },
    'data-filtering': { member: ['corp-dlp'] },
  },
  livePrior: {
    virus: { member: ['corp-av'] },
    spyware: { member: ['corp-spyware'] },
    vulnerability: { member: ['corp-vuln'] },
    'url-filtering': { member: ['permissive-url'] },
    'file-blocking': { member: ['corp-executables'] },
    'wildfire-analysis': { member: ['corp-wildfire'] },
    'data-filtering': { member: ['corp-dlp'] },
  },
  drifts: [
    {
      field: 'corp-strict.url-filtering',
      expected: 'corp-url-strict',
      actual: 'permissive-url',
      severity: 'warning',
    },
  ],

  canvasOnlyValue: 'corp-url-strict',
  liveOnlyValue: 'permissive-url',
}
