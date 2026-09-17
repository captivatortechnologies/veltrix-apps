import type { ConfigFixture } from '../../../lib/__tests__/configFixture'

/**
 * The live profile still forwards, still matches the same log type and still
 * reaches Panorama — but its syslog target has been repointed at a
 * decommissioned collector. The rules keep logging into a SIEM that is not
 * listening, which nothing else in the estate surfaces.
 */
export const fixture: ConfigFixture = {
  id: 'panorama-log-forwarding-profiles',
  resourcePath: '/Objects/LogForwardingProfiles',
  typeLabel: 'log forwarding profile(s)',
  healthLabel: 'log forwarding profile',

  name: 'corp-logging',
  item: {
    id: 'item-1',
    name: 'corp-logging',
    fields: {
      name: 'corp-logging',
      description: 'Corporate log forwarding',
      enhanced_application_logging: true,
      match_name: 'default',
      log_type: 'traffic',
      filter: 'All Logs',
      send_to_panorama: true,
      send_syslog: 'siem-collector',
      quarantine: false,
    },
  },
  fields: {
    'match-list': {
      entry: [
        {
          '@name': 'default',
          'log-type': 'traffic',
          'send-to-panorama': 'yes',
          quarantine: 'no',
          filter: 'All Logs',
          'send-syslog': { member: ['siem-collector'] },
        },
      ],
    },
    'enhanced-application-logging': 'yes',
    description: 'Corporate log forwarding',
  },

  secondName: 'threat-logging',
  secondItem: {
    id: 'item-2',
    name: 'threat-logging',
    fields: { name: 'threat-logging', log_type: 'threat' },
  },
  secondFields: {
    'match-list': {
      entry: [
        { '@name': 'default', 'log-type': 'threat', 'send-to-panorama': 'yes', quarantine: 'no' },
      ],
    },
    'enhanced-application-logging': 'no',
  },

  liveInSync: {
    description: 'Corporate log forwarding',
    'enhanced-application-logging': 'yes',
    'match-list': {
      entry: [
        {
          '@name': 'default',
          'log-type': 'traffic',
          filter: 'All Logs',
          'send-to-panorama': 'yes',
          'send-syslog': { member: ['siem-collector'] },
          quarantine: 'no',
        },
      ],
    },
  },
  livePrior: {
    description: 'Corporate log forwarding',
    'enhanced-application-logging': 'yes',
    'match-list': {
      entry: [
        {
          '@name': 'default',
          'log-type': 'traffic',
          filter: 'All Logs',
          'send-to-panorama': 'yes',
          'send-syslog': { member: ['retired-collector'] },
          quarantine: 'no',
        },
      ],
    },
  },
  drifts: [
    {
      field: 'corp-logging.send-syslog',
      expected: 'siem-collector',
      actual: 'retired-collector',
      severity: 'info',
    },
  ],

  canvasOnlyValue: 'siem-collector',
  liveOnlyValue: 'retired-collector',
}
