import type { ConfigFixture } from '../../../lib/__tests__/configFixture'

/**
 * The live profile still carries the rule and the same file types — with the
 * action downgraded to alert. Executables are logged on the way in and delivered
 * anyway.
 */
export const fixture: ConfigFixture = {
  id: 'panorama-file-blocking-profiles',
  resourcePath: '/Objects/FileBlockingSecurityProfiles',
  typeLabel: 'file blocking profile(s)',
  healthLabel: 'file blocking profile',

  name: 'corp-executables',
  item: {
    id: 'item-1',
    name: 'corp-executables',
    fields: {
      name: 'corp-executables',
      description: 'Executable control',
      rule_name: 'executables',
      applications: 'any',
      file_types: 'exe, dll',
      direction: 'both',
      action: 'block',
    },
  },
  fields: {
    rules: {
      entry: [
        {
          '@name': 'executables',
          applications: { member: ['any'] },
          'file-types': { member: ['exe', 'dll'] },
          direction: 'both',
          action: 'block',
        },
      ],
    },
    description: 'Executable control',
  },

  secondName: 'lab-archives',
  secondItem: {
    id: 'item-2',
    name: 'lab-archives',
    fields: { name: 'lab-archives', rule_name: 'archives', file_types: '7z', action: 'continue' },
  },
  secondFields: {
    rules: {
      entry: [
        {
          '@name': 'archives',
          applications: { member: ['any'] },
          'file-types': { member: ['7z'] },
          direction: 'both',
          action: 'continue',
        },
      ],
    },
  },

  liveInSync: {
    description: 'Executable control',
    rules: {
      entry: [
        {
          '@name': 'executables',
          applications: { member: ['any'] },
          'file-types': { member: ['dll', 'exe'] },
          direction: 'both',
          action: 'block',
        },
      ],
    },
  },
  livePrior: {
    description: 'Executable control',
    rules: {
      entry: [
        {
          '@name': 'executables',
          applications: { member: ['any'] },
          'file-types': { member: ['exe', 'dll'] },
          direction: 'both',
          action: 'alert',
        },
      ],
    },
  },
  drifts: [
    { field: 'corp-executables.action', expected: 'block', actual: 'alert', severity: 'warning' },
  ],

  canvasOnlyValue: 'block',
  liveOnlyValue: 'alert',
}
