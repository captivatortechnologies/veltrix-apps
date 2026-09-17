import type { ConfigFixture } from '../../../lib/__tests__/configFixture'

/**
 * The live tag is still there but has been recoloured by hand — harmless on its
 * own, and the cheapest possible proof that a managed field is being compared.
 */
export const fixture: ConfigFixture = {
  id: 'panorama-tags',
  resourcePath: '/Objects/Tags',
  typeLabel: 'tag(s)',
  healthLabel: 'tag',

  name: 'veltrix-managed',
  item: {
    id: 'item-1',
    name: 'veltrix-managed',
    fields: { name: 'veltrix-managed', color: 'color5', comments: 'Managed by Veltrix' },
  },
  fields: { color: 'color5', comments: 'Managed by Veltrix' },

  secondName: 'veltrix-quarantine',
  secondItem: {
    id: 'item-2',
    name: 'veltrix-quarantine',
    fields: { name: 'veltrix-quarantine', color: 'color1' },
  },
  secondFields: { color: 'color1' },

  liveInSync: { color: 'color5', comments: 'Managed by Veltrix' },
  livePrior: { color: 'color2', comments: 'Managed by Veltrix' },
  drifts: [{ field: 'veltrix-managed.color', expected: 'color5', actual: 'color2', severity: 'info' }],

  canvasOnlyValue: 'color5',
  liveOnlyValue: 'color2',
}
