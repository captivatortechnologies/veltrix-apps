import type { ConfigFixture } from '../../../lib/__tests__/configFixture'

export const fixture: ConfigFixture = {
  id: 'firewall-schedule-groups',
  objectPath: '/obj/firewall/schedule/group',
  checkName: 'fmg-firewall-schedule-group',
  name: 'maintenance-windows',
  item: {
    id: 'item-1',
    name: 'maintenance-windows',
    fields: { name: 'maintenance-windows', members: 'change-window, business-hours' },
  },
  body: { name: 'maintenance-windows', member: ['change-window', 'business-hours'] },
  livePrior: { name: 'maintenance-windows', member: [{ name: 'change-window' }] },
  priorSnapshot: { name: 'maintenance-windows', member: ['change-window'] },
  liveInSync: { name: 'maintenance-windows', member: ['change-window', 'business-hours'] },
  driftField: 'maintenance-windows.member',
  deploySuccess: 'Deployed 1 firewall schedule group(s)',
  deployFailurePrefix: 'Some schedule groups failed',
  rollbackPrefix: 'Rolled back firewall schedule groups',
}
