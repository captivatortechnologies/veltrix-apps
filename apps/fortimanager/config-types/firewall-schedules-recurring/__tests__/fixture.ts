import type { ConfigFixture } from '../../../lib/__tests__/configFixture'

export const fixture: ConfigFixture = {
  id: 'firewall-schedules-recurring',
  objectPath: '/obj/firewall/schedule/recurring',
  checkName: 'fmg-firewall-schedule-recurring',
  name: 'business-hours',
  item: {
    id: 'item-1',
    name: 'business-hours',
    fields: { name: 'business-hours', days: 'monday, tuesday', start: '08:00', end: '18:00' },
  },
  body: { name: 'business-hours', day: ['monday', 'tuesday'], start: '08:00', end: '18:00' },
  livePrior: { name: 'business-hours', day: ['monday'], start: '08:00', end: '18:00' },
  priorSnapshot: { name: 'business-hours', day: ['monday'], start: '08:00', end: '18:00' },
  liveInSync: { name: 'business-hours', day: ['monday', 'tuesday'], start: '08:00', end: '18:00' },
  driftField: 'business-hours.day',
  deploySuccess: 'Deployed 1 recurring schedule(s)',
  deployFailurePrefix: 'Some recurring schedules failed',
  rollbackPrefix: 'Rolled back recurring schedules',
}
