import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'
import {
  buildGetSchedulesCommand,
  buildCreateScheduleCommand,
  buildModifyScheduleCommand,
  buildDeleteScheduleCommand,
  parseSchedules,
  parseGmpStatus,
  parseCreatedId,
} from '../../../lib/greenboneApi'
import { buildScheduleInput, findScheduleByName, icalKeys, normalizeIcal, looksLikeIcalendar } from '../_shared'

// The deploy/rollback/health/drift handlers talk to gvmd over a live TLS socket,
// which cannot be mocked here (house convention). These tests exercise the pure,
// network-free seams: validate.ts and the GMP XML command assembly + response
// parsing in lib/greenboneApi.ts, plus the _shared iCalendar helpers.

const ICAL = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'DTSTART:20260101T020000Z', 'RRULE:FREQ=WEEKLY;BYDAY=SU', 'END:VEVENT', 'END:VCALENDAR'].join('\n')

// --- validate ---------------------------------------------------------------

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}
const good = { name: 'Weekly', icalendar: ICAL, timezone: 'UTC', comment: 'nightly window' }

test('validate accepts a good schedule', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects an empty timezone', async () => {
  const res = await validate(ctxOf([{ ...good, timezone: '  ' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_TIMEZONE'))
})

test('validate rejects icalendar without a VEVENT', async () => {
  const res = await validate(ctxOf([{ ...good, icalendar: 'not calendar data' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ICALENDAR'))
})

test('validate rejects a VEVENT with no DTSTART', async () => {
  const noStart = 'BEGIN:VCALENDAR\nBEGIN:VEVENT\nRRULE:FREQ=DAILY\nEND:VEVENT\nEND:VCALENDAR'
  const res = await validate(ctxOf([{ ...good, icalendar: noStart }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'MISSING_DTSTART'))
})

test('validate warns on a non-recurring (no RRULE) schedule', async () => {
  const oneShot = 'BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART:20260101T020000Z\nEND:VEVENT\nEND:VCALENDAR'
  const res = await validate(ctxOf([{ ...good, icalendar: oneShot }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'NO_RRULE'))
})

test('validate warns on a duplicate schedule name', async () => {
  const res = await validate(ctxOf([good, { ...good, comment: 'again' }]))
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- command builders -------------------------------------------------------

test('buildGetSchedulesCommand defaults to rows=-1 (all rows)', () => {
  assert.equal(buildGetSchedulesCommand(), '<get_schedules filter="rows=-1"/>')
})

test('buildCreateScheduleCommand emits name, icalendar, timezone and comment', () => {
  const xml = buildCreateScheduleCommand({ name: 'Weekly', icalendar: ICAL, timezone: 'Europe/Berlin', comment: 'q1' })
  assert.ok(xml.startsWith('<create_schedule>'))
  assert.ok(xml.includes('<name>Weekly</name>'))
  assert.ok(xml.includes('<timezone>Europe/Berlin</timezone>'))
  assert.ok(xml.includes('<icalendar>'))
  assert.ok(xml.includes('RRULE:FREQ=WEEKLY;BYDAY=SU'))
  assert.ok(xml.includes('<comment>q1</comment>'))
})

test('buildCreateScheduleCommand omits an empty comment', () => {
  const xml = buildCreateScheduleCommand({ name: 'W', icalendar: ICAL, timezone: 'UTC' })
  assert.ok(!xml.includes('<comment>'))
})

test('buildModifyScheduleCommand targets by schedule_id and only sends provided fields', () => {
  const xml = buildModifyScheduleCommand('sch-1', { timezone: 'UTC' })
  assert.equal(xml, '<modify_schedule schedule_id="sch-1"><timezone>UTC</timezone></modify_schedule>')
})

test('buildDeleteScheduleCommand sets ultimate', () => {
  assert.equal(buildDeleteScheduleCommand('s1', true), '<delete_schedule schedule_id="s1" ultimate="1"/>')
  assert.equal(buildDeleteScheduleCommand('s1', false), '<delete_schedule schedule_id="s1" ultimate="0"/>')
})

// --- response parsing -------------------------------------------------------

test('parseSchedules extracts id, name, timezone, comment and icalendar', () => {
  const xml = `<get_schedules_response status="200" status_text="OK">
    <schedule id="b493b7a8-0001-0000-0000-000000000001">
      <name>Weekly</name>
      <comment>nightly</comment>
      <icalendar>BEGIN:VCALENDAR&#10;BEGIN:VEVENT&#10;DTSTART:20260101T020000Z&#10;RRULE:FREQ=WEEKLY&#10;END:VEVENT&#10;END:VCALENDAR</icalendar>
      <timezone>Europe/Berlin</timezone>
    </schedule>
  </get_schedules_response>`
  const schedules = parseSchedules(xml)
  assert.equal(schedules.length, 1)
  assert.equal(schedules[0].id, 'b493b7a8-0001-0000-0000-000000000001')
  assert.equal(schedules[0].name, 'Weekly')
  assert.equal(schedules[0].timezone, 'Europe/Berlin')
  assert.ok(schedules[0].icalendar.includes('RRULE:FREQ=WEEKLY'))
})

test('parseGmpStatus / parseCreatedId read a create_schedule response', () => {
  const raw = '<create_schedule_response status="201" status_text="OK, resource created" id="sch-new"/>'
  assert.equal(parseGmpStatus(raw).ok, true)
  assert.equal(parseCreatedId(raw), 'sch-new')
})

// --- _shared helpers --------------------------------------------------------

test('buildScheduleInput trims fields and defaults timezone to UTC', () => {
  const input = buildScheduleInput({ name: '  Weekly  ', icalendar: `  ${ICAL}  `, timezone: '' })
  assert.equal(input.name, 'Weekly')
  assert.equal(input.timezone, 'UTC')
  assert.ok(input.icalendar.startsWith('BEGIN:VCALENDAR'))
})

test('icalKeys keeps only DTSTART/DTEND/DURATION/RRULE, normalized', () => {
  const keys = icalKeys(ICAL)
  assert.equal(keys.DTSTART, '20260101T020000Z')
  assert.equal(keys.RRULE, 'FREQ=WEEKLY;BYDAY=SU')
  assert.equal(keys.PRODID, undefined)
})

test('normalizeIcal is stable across gvmd reformatting (folding / property order / case)', () => {
  const reordered = 'BEGIN:VCALENDAR\nBEGIN:VEVENT\nrrule:freq=weekly;byday=su\ndtstart:20260101T020000Z\nEND:VEVENT\nEND:VCALENDAR'
  const folded = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART:20260101T0200\r\n 00Z\r\nRRULE:FREQ=WEEKLY;BYDAY=SU\r\nEND:VEVENT\r\nEND:VCALENDAR'
  assert.equal(normalizeIcal(ICAL), normalizeIcal(reordered))
  assert.equal(normalizeIcal(ICAL), normalizeIcal(folded))
})

test('looksLikeIcalendar rejects plain text and accepts a VCALENDAR', () => {
  assert.equal(looksLikeIcalendar('hello'), false)
  assert.equal(looksLikeIcalendar(ICAL), true)
})

test('findScheduleByName matches on the trimmed name', () => {
  const schedules = parseSchedules('<get_schedules_response><schedule id="s1"><name>Weekly</name></schedule></get_schedules_response>')
  assert.equal(findScheduleByName(schedules, 'Weekly')?.id, 's1')
  assert.equal(findScheduleByName(schedules, 'Nope'), null)
})
