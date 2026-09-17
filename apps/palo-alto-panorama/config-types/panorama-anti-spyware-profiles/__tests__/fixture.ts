import type { ConfigFixture } from '../../../lib/__tests__/configFixture'

/**
 * The live profile still has the rule, the severities and the packet capture the
 * canvas declares — and its action has been downgraded from reset-both to alert.
 * Command-and-control traffic is logged and allowed through.
 */
export const fixture: ConfigFixture = {
  id: 'panorama-anti-spyware-profiles',
  resourcePath: '/Objects/AntiSpywareSecurityProfiles',
  typeLabel: 'anti-spyware profile(s)',
  healthLabel: 'anti-spyware profile',

  name: 'corp-spyware',
  item: {
    id: 'item-1',
    name: 'corp-spyware',
    fields: {
      name: 'corp-spyware',
      description: 'Corporate anti-spyware',
      rule_name: 'block-critical-high-medium',
      severity: 'critical, high, medium',
      action: 'reset-both',
      packet_capture: 'single-packet',
      category: 'any',
      threat_name: 'any',
    },
  },
  fields: {
    rules: {
      entry: [
        {
          '@name': 'block-critical-high-medium',
          action: { 'reset-both': {} },
          severity: { member: ['critical', 'high', 'medium'] },
          category: 'any',
          'threat-name': 'any',
          'packet-capture': 'single-packet',
        },
      ],
    },
    description: 'Corporate anti-spyware',
  },

  secondName: 'lab-spyware',
  secondItem: {
    id: 'item-2',
    name: 'lab-spyware',
    fields: { name: 'lab-spyware', action: 'drop' },
  },
  secondFields: {
    rules: {
      entry: [
        {
          '@name': 'block-critical-high-medium',
          action: { drop: {} },
          severity: { member: ['critical', 'high', 'medium'] },
          category: 'any',
          'threat-name': 'any',
          'packet-capture': 'disable',
        },
      ],
    },
  },

  liveInSync: {
    description: 'Corporate anti-spyware',
    rules: {
      entry: [
        {
          '@name': 'block-critical-high-medium',
          action: { 'reset-both': {} },
          severity: { member: ['high', 'critical', 'medium'] },
          category: 'any',
          'threat-name': 'any',
          'packet-capture': 'single-packet',
        },
      ],
    },
  },
  livePrior: {
    description: 'Corporate anti-spyware',
    rules: {
      entry: [
        {
          '@name': 'block-critical-high-medium',
          action: { alert: {} },
          severity: { member: ['critical', 'high', 'medium'] },
          category: 'any',
          'threat-name': 'any',
          'packet-capture': 'single-packet',
        },
      ],
    },
  },
  drifts: [
    { field: 'corp-spyware.action', expected: 'reset-both', actual: 'alert', severity: 'warning' },
  ],

  canvasOnlyValue: 'reset-both',
  liveOnlyValue: 'alert',
}
