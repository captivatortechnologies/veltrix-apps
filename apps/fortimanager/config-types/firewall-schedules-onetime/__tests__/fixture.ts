import type { ConfigFixture } from '../../../lib/__tests__/configFixture'

/** The live window closes four hours later than the canvas declares — a change
 *  window silently extended is a policy that stays open longer than approved. */
export const fixture: ConfigFixture = {
  id: 'firewall-schedules-onetime',
  objectPath: '/obj/firewall/schedule/onetime',
  checkName: 'fmg-firewall-schedule-onetime',
  name: 'change-window',
  item: {
    id: 'item-1',
    name: 'change-window',
    fields: { name: 'change-window', start: '22:00 2026/03/01', end: '02:00 2026/03/02' },
  },
  body: { name: 'change-window', start: '22:00 2026/03/01', end: '02:00 2026/03/02' },
  livePrior: { name: 'change-window', start: '22:00 2026/03/01', end: '06:00 2026/03/02' },
  priorSnapshot: { name: 'change-window', start: '22:00 2026/03/01', end: '06:00 2026/03/02' },
  liveInSync: { name: 'change-window', start: '22:00 2026/03/01', end: '02:00 2026/03/02' },
  driftField: 'change-window.end',
  deploySuccess: 'Deployed 1 one-time schedule(s)',
  deployFailurePrefix: 'Some one-time schedules failed',
  rollbackPrefix: 'Rolled back one-time schedules',
}
