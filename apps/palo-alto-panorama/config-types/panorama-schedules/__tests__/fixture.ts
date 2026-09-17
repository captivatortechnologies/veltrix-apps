import type { ConfigFixture } from '../../../lib/__tests__/configFixture'

/**
 * The live schedule has been widened from an overnight window to the working
 * day. Any rule gated on it is now in force when the canvas says it should not
 * be — a schedule is an access-control decision, not a convenience.
 */
export const fixture: ConfigFixture = {
  id: 'panorama-schedules',
  resourcePath: '/Objects/Schedules',
  typeLabel: 'schedule(s)',
  healthLabel: 'schedule',

  name: 'maintenance-window',
  item: {
    id: 'item-1',
    name: 'maintenance-window',
    fields: { name: 'maintenance-window', schedule_kind: 'daily', daily_ranges: '01:00-03:00' },
  },
  fields: { 'schedule-type': { recurring: { daily: { member: ['01:00-03:00'] } } } },

  secondName: 'weekend-window',
  secondItem: {
    id: 'item-2',
    name: 'weekend-window',
    fields: {
      name: 'weekend-window',
      schedule_kind: 'weekly',
      weekly_ranges: { saturday: '00:00-06:00' },
    },
  },
  secondFields: {
    'schedule-type': { recurring: { weekly: { saturday: { member: ['00:00-06:00'] } } } },
  },

  liveInSync: { 'schedule-type': { recurring: { daily: { member: ['01:00-03:00'] } } } },
  livePrior: { 'schedule-type': { recurring: { daily: { member: ['09:00-17:00'] } } } },
  drifts: [{
    field: 'maintenance-window.schedule-type',
    expected: 'daily:01:00-03:00',
    actual: 'daily:09:00-17:00',
    severity: 'warning',
  }],

  canvasOnlyValue: '01:00-03:00',
  liveOnlyValue: '09:00-17:00',
}
