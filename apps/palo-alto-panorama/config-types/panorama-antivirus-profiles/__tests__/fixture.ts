import type { ConfigFixture } from '../../../lib/__tests__/configFixture'

/** The seven protocol decoders PAN-OS 10.x/11.x antivirus profiles carry. */
const DECODERS = ['ftp', 'http', 'http2', 'imap', 'pop3', 'smb', 'smtp'] as const

function decoders(action: string, wildfireAction: string): Array<Record<string, unknown>> {
  return DECODERS.map((name) => ({ '@name': name, action, 'wildfire-action': wildfireAction }))
}

/**
 * The live profile has been put into alert-only mode on every decoder — the
 * change an administrator makes "just for an hour" during an incident and never
 * reverts. The profile is still attached to every rule that referenced it and
 * still reports as deployed; it stopped blocking anything.
 */
export const fixture: ConfigFixture = {
  id: 'panorama-antivirus-profiles',
  resourcePath: '/Objects/AntivirusSecurityProfiles',
  typeLabel: 'antivirus profile(s)',
  healthLabel: 'antivirus profile',

  name: 'corp-av',
  item: {
    id: 'item-1',
    name: 'corp-av',
    fields: {
      name: 'corp-av',
      description: 'Corporate antivirus',
      action: 'reset-both',
      wildfire_action: 'reset-both',
    },
  },
  fields: {
    decoder: { entry: decoders('reset-both', 'reset-both') },
    description: 'Corporate antivirus',
  },

  secondName: 'lab-av',
  secondItem: {
    id: 'item-2',
    name: 'lab-av',
    fields: { name: 'lab-av', action: 'drop', wildfire_action: 'drop' },
  },
  secondFields: { decoder: { entry: decoders('drop', 'drop') } },

  liveInSync: {
    description: 'Corporate antivirus',
    decoder: { entry: decoders('reset-both', 'reset-both') },
  },
  livePrior: {
    description: 'Corporate antivirus',
    decoder: { entry: decoders('alert', 'alert') },
  },
  drifts: DECODERS.flatMap((proto) => [
    { field: `corp-av.${proto}.action`, expected: 'reset-both', actual: 'alert', severity: 'warning' as const },
    {
      field: `corp-av.${proto}.wildfire-action`,
      expected: 'reset-both',
      actual: 'alert',
      severity: 'warning' as const,
    },
  ]),

  canvasOnlyValue: 'reset-both',
  liveOnlyValue: 'alert',
}
