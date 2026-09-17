import type { ConfigFixture } from '../../../lib/__tests__/configFixture'

/**
 * The live profile still has a rule, still has thresholds and still logs — but
 * it is watching a different data pattern than the canvas declares. The profile
 * reports as deployed and the data it was written to catch leaves unexamined.
 */
export const fixture: ConfigFixture = {
  id: 'panorama-data-filtering-profiles',
  resourcePath: '/Objects/DataFilteringSecurityProfiles',
  typeLabel: 'data filtering profile(s)',
  healthLabel: 'data filtering profile',

  name: 'corp-dlp',
  item: {
    id: 'item-1',
    name: 'corp-dlp',
    fields: {
      name: 'corp-dlp',
      description: 'Corporate data filtering',
      data_capture: false,
      rule_name: 'default',
      data_object: 'credit-card-pattern',
      direction: 'both',
      application: 'any',
      file_type: 'any',
      alert_threshold: 10,
      block_threshold: 20,
      log_severity: 'medium',
    },
  },
  fields: {
    rules: {
      entry: [
        {
          '@name': 'default',
          'data-object': 'credit-card-pattern',
          direction: 'both',
          application: { member: ['any'] },
          'file-type': { member: ['any'] },
          'alert-threshold': 10,
          'block-threshold': 20,
          'log-severity': 'medium',
        },
      ],
    },
    'data-capture': 'no',
    description: 'Corporate data filtering',
  },

  secondName: 'lab-dlp',
  secondItem: {
    id: 'item-2',
    name: 'lab-dlp',
    fields: { name: 'lab-dlp', data_object: 'national-id-pattern', direction: 'upload' },
  },
  secondFields: {
    rules: {
      entry: [
        {
          '@name': 'default',
          'data-object': 'national-id-pattern',
          direction: 'upload',
          application: { member: ['any'] },
          'file-type': { member: ['any'] },
          'alert-threshold': 10,
          'block-threshold': 20,
          'log-severity': 'medium',
        },
      ],
    },
    'data-capture': 'no',
  },

  liveInSync: {
    description: 'Corporate data filtering',
    'data-capture': 'no',
    rules: {
      entry: [
        {
          '@name': 'default',
          'data-object': 'credit-card-pattern',
          direction: 'both',
          application: { member: ['any'] },
          'file-type': { member: ['any'] },
          'alert-threshold': 10,
          'block-threshold': 20,
          'log-severity': 'medium',
        },
      ],
    },
  },
  livePrior: {
    description: 'Corporate data filtering',
    'data-capture': 'no',
    rules: {
      entry: [
        {
          '@name': 'default',
          'data-object': 'legacy-keyword-pattern',
          direction: 'both',
          application: { member: ['any'] },
          'file-type': { member: ['any'] },
          'alert-threshold': 10,
          'block-threshold': 20,
          'log-severity': 'medium',
        },
      ],
    },
  },
  drifts: [
    {
      field: 'corp-dlp.data-object',
      expected: 'credit-card-pattern',
      actual: 'legacy-keyword-pattern',
      severity: 'critical',
    },
  ],

  canvasOnlyValue: 'credit-card-pattern',
  liveOnlyValue: 'legacy-keyword-pattern',
}
