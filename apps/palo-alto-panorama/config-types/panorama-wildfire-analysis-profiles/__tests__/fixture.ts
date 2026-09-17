import type { ConfigFixture } from '../../../lib/__tests__/configFixture'

/**
 * The live profile still forwards everything for analysis — to a private-cloud
 * appliance instead of the public WildFire cloud the canvas declares. Samples
 * keep being submitted; the verdicts come from somewhere else.
 */
export const fixture: ConfigFixture = {
  id: 'panorama-wildfire-analysis-profiles',
  resourcePath: '/Objects/WildFireAnalysisSecurityProfiles',
  typeLabel: 'WildFire analysis profile(s)',
  healthLabel: 'WildFire analysis profile',

  name: 'corp-wildfire',
  item: {
    id: 'item-1',
    name: 'corp-wildfire',
    fields: {
      name: 'corp-wildfire',
      rule_name: 'forward-all',
      application: 'any',
      file_type: 'any',
      direction: 'both',
      analysis: 'public-cloud',
    },
  },
  fields: {
    rules: {
      entry: [
        {
          '@name': 'forward-all',
          application: { member: ['any'] },
          'file-type': { member: ['any'] },
          direction: 'both',
          analysis: 'public-cloud',
        },
      ],
    },
  },

  secondName: 'lab-wildfire',
  secondItem: {
    id: 'item-2',
    name: 'lab-wildfire',
    fields: { name: 'lab-wildfire', rule_name: 'uploads-only', direction: 'upload' },
  },
  secondFields: {
    rules: {
      entry: [
        {
          '@name': 'uploads-only',
          application: { member: ['any'] },
          'file-type': { member: ['any'] },
          direction: 'upload',
          analysis: 'public-cloud',
        },
      ],
    },
  },

  liveInSync: {
    rules: {
      entry: [
        {
          '@name': 'forward-all',
          application: { member: ['any'] },
          'file-type': { member: ['any'] },
          direction: 'both',
          analysis: 'public-cloud',
        },
      ],
    },
  },
  livePrior: {
    rules: {
      entry: [
        {
          '@name': 'forward-all',
          application: { member: ['any'] },
          'file-type': { member: ['any'] },
          direction: 'both',
          analysis: 'private-cloud',
        },
      ],
    },
  },
  drifts: [
    {
      field: 'corp-wildfire.analysis',
      expected: 'public-cloud',
      actual: 'private-cloud',
      severity: 'warning',
    },
  ],

  canvasOnlyValue: 'public-cloud',
  liveOnlyValue: 'private-cloud',
}
