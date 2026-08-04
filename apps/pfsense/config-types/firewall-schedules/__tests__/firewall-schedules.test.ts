import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { specFromItem, extractSpecs, isValidHourRange, scheduleKey, toScheduleBody, snapshotSchedule, usesRecurringDays, MAX_NAME_LENGTH, MAX_DESCRIPTION_LENGTH } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `item-${i}`, name: `sched-${i}`, fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const validWeekday = { name: 'business_hours', descr: 'Weekday business hours', position: [1, 2, 3, 4, 5], hour: '08:00-17:00' }
const validDated = { name: 'holiday_2026', month: [12], day: [25], hour: '00:00-23:59' }

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate requires a name', async () => {
  const res = await validate(ctxOf([{ ...validWeekday, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a name over the 31-character limit', async () => {
  const res = await validate(ctxOf([{ ...validWeekday, name: 'a'.repeat(MAX_NAME_LENGTH + 1) }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'NAME_TOO_LONG'))
})

test('validate rejects a duplicate name', async () => {
  const res = await validate(ctxOf([validWeekday, validWeekday]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'DUPLICATE_NAME'))
})

test('validate accepts a well-formed recurring-weekday schedule', async () => {
  const res = await validate(ctxOf([validWeekday]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate accepts a well-formed specific-date schedule', async () => {
  const res = await validate(ctxOf([validDated]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects an out-of-range day-of-week position', async () => {
  const res = await validate(ctxOf([{ ...validWeekday, position: [8] }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_POSITION'))
})

test('validate warns when month/day are set alongside position', async () => {
  const res = await validate(ctxOf([{ ...validWeekday, month: [1], day: [1] }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'MONTH_DAY_IGNORED'))
})

test('validate requires either position or both month and day', async () => {
  const res = await validate(ctxOf([{ name: 'x', hour: '08:00-17:00' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_DATE_SPEC'))
})

test('validate rejects mismatched month/day counts', async () => {
  const res = await validate(ctxOf([{ name: 'x', month: [1, 2], day: [1], hour: '08:00-17:00' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'MONTH_DAY_COUNT_MISMATCH'))
})

test('validate rejects a day that does not exist in its month', async () => {
  const res = await validate(ctxOf([{ name: 'x', month: [4], day: [31], hour: '08:00-17:00' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_DAY_FOR_MONTH'))
})

test('validate treats Feb 29 as valid regardless of leap year (matches pfSense\'s own hardcoded table)', async () => {
  const res = await validate(ctxOf([{ name: 'x', month: [2], day: [29], hour: '08:00-17:00' }]))
  assert.equal(res.valid, true)
})

test('validate requires an hour and rejects a malformed one', async () => {
  const empty = await validate(ctxOf([{ ...validWeekday, hour: '' }]))
  assert.ok(empty.errors.some((e) => e.code === 'EMPTY_HOUR'))

  const malformed = await validate(ctxOf([{ ...validWeekday, hour: '8am-5pm' }]))
  assert.ok(malformed.errors.some((e) => e.code === 'INVALID_HOUR'))

  const badMinutes = await validate(ctxOf([{ ...validWeekday, hour: '08:05-17:00' }]))
  assert.ok(badMinutes.errors.some((e) => e.code === 'INVALID_HOUR'))

  const backwards = await validate(ctxOf([{ ...validWeekday, hour: '17:00-08:00' }]))
  assert.ok(backwards.errors.some((e) => e.code === 'INVALID_HOUR'))
})

test('validate rejects a description over the limit', async () => {
  const res = await validate(ctxOf([{ ...validWeekday, descr: 'a'.repeat(MAX_DESCRIPTION_LENGTH + 1) }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'DESCRIPTION_TOO_LONG'))
})

test('isValidHourRange accepts the supported minute set and rejects others', () => {
  assert.equal(isValidHourRange('08:00-17:00'), true)
  assert.equal(isValidHourRange('08:15-17:45'), true)
  assert.equal(isValidHourRange('0:59-1:59'), true)
  assert.equal(isValidHourRange('08:05-17:00'), false)
  assert.equal(isValidHourRange('not-a-range'), false)
})

test('scheduleKey is case-sensitive (no folding)', () => {
  assert.notEqual(scheduleKey('Business_Hours'), scheduleKey('business_hours'))
})

test('usesRecurringDays reflects whether position has values', () => {
  assert.equal(usesRecurringDays(specFromItem({ id: 'i', name: 'x', fields: validWeekday })), true)
  assert.equal(usesRecurringDays(specFromItem({ id: 'i', name: 'x', fields: validDated })), false)
})

test('extractSpecs maps every item', () => {
  const specs = extractSpecs(toItems([validWeekday, validDated]))
  assert.equal(specs.length, 2)
})

test('toScheduleBody embeds exactly one timerange entry, position-only when recurring', () => {
  const spec = specFromItem({ id: 'i', name: 'x', fields: validWeekday })
  const body = toScheduleBody(spec)
  assert.equal(body.timerange.length, 1)
  assert.deepEqual(body.timerange[0].position, [1, 2, 3, 4, 5])
  assert.equal('month' in body.timerange[0], false)
})

test('toScheduleBody embeds month/day when not recurring', () => {
  const spec = specFromItem({ id: 'i', name: 'x', fields: validDated })
  const body = toScheduleBody(spec)
  assert.equal(body.timerange[0].position, null)
  assert.deepEqual(body.timerange[0].month, [12])
  assert.deepEqual(body.timerange[0].day, [25])
})

test('snapshotSchedule never includes id', () => {
  const snap = snapshotSchedule({ id: 8, name: 'business_hours', descr: 'x', timerange: [{ position: [1], hour: '08:00-17:00' }] }) as Record<string, unknown>
  assert.equal('id' in snap, false)
  assert.equal(snap.name, 'business_hours')
})
