import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cronMatches, nextCronRun, parseCron } from '../schedule/cron'

const at = (iso: string) => new Date(iso)

test('parseCron expands lists, ranges, steps and folds Sunday=7 onto 0', () => {
  const f = parseCron('*/15 9-17 1,15 */3 7')
  assert.deepEqual([...f.minute], [0, 15, 30, 45])
  assert.deepEqual([...f.hour], [9, 10, 11, 12, 13, 14, 15, 16, 17])
  assert.deepEqual([...f.dayOfMonth], [1, 15])
  assert.deepEqual([...f.month], [1, 4, 7, 10])
  assert.deepEqual([...f.dayOfWeek], [0])
  assert.throws(() => parseCron('* * *'), /Invalid cron/)
})

test('cronMatches evaluates in UTC', () => {
  assert.equal(cronMatches('30 6 * * *', at('2026-11-09T06:30:00Z')), true)
  assert.equal(cronMatches('30 6 * * *', at('2026-11-09T06:31:00Z')), false)
  assert.equal(cronMatches('0 0 * * 1-5', at('2026-11-09T00:00:00Z')), true)
  assert.equal(cronMatches('0 0 * * 1-5', at('2026-11-08T00:00:00Z')), false)
})

test('day-of-month and day-of-week are OR-ed only when both are restricted', () => {
  assert.equal(cronMatches('0 0 15 * 1', at('2026-11-15T00:00:00Z')), true)
  assert.equal(cronMatches('0 0 15 * 1', at('2026-11-09T00:00:00Z')), true)
  assert.equal(cronMatches('0 0 15 * 1', at('2026-11-10T00:00:00Z')), false)
  assert.equal(cronMatches('0 0 15 * *', at('2026-11-09T00:00:00Z')), false)
})

test('nextCronRun is strictly after the reference minute and skips whole days and months', () => {
  assert.equal(nextCronRun('*/5 * * * *', at('2026-11-09T06:30:00Z')).toISOString(), '2026-11-09T06:35:00.000Z')
  assert.equal(nextCronRun('*/5 * * * *', at('2026-11-09T06:30:59Z')).toISOString(), '2026-11-09T06:35:00.000Z')
  assert.equal(nextCronRun('0 6 * * 1', at('2026-11-09T06:00:00Z')).toISOString(), '2026-11-16T06:00:00.000Z')
  assert.equal(nextCronRun('0 0 29 2 *', at('2026-01-01T00:00:00Z')).toISOString(), '2028-02-29T00:00:00.000Z')
  assert.equal(nextCronRun('0 12 1 1 *', at('2026-11-09T06:00:00Z')).toISOString(), '2027-01-01T12:00:00.000Z')
})

test('nextCronRun gives up on an expression that can never fire', () => {
  assert.throws(() => nextCronRun('0 0 31 2 *', at('2026-01-01T00:00:00Z')), /never fires/)
})
