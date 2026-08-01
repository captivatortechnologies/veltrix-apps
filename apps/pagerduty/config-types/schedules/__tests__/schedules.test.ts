import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { parseScheduleLayers, extractScheduleSpecs, buildScheduleBody, findSchedule } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

// These handlers apply over the PagerDuty REST API via fetch inside pagerdutyApi,
// which is impractical to mock here. Tests focus on validate.ts + the pure _shared
// helpers (parsing / extraction / body building), which are network-free.

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const LAYERS =
  '[{"start":"2026-01-01T00:00:00Z","rotation_virtual_start":"2026-01-01T00:00:00Z","rotation_turn_length_seconds":604800,"users":[{"user":{"id":"PABC123","type":"user_reference"}}]}]'
const good = { name: 'Primary Rotation', time_zone: 'America/New_York', schedule_layers: LAYERS }

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate accepts a valid schedule', async () => {
  const res = await validate(ctxOf([{ ...good }]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a missing time zone', async () => {
  const res = await validate(ctxOf([{ ...good, time_zone: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_TIME_ZONE'))
})

test('validate rejects missing schedule layers', async () => {
  const res = await validate(ctxOf([{ ...good, schedule_layers: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_LAYERS'))
})

test('validate rejects layers that are not valid JSON', async () => {
  const res = await validate(ctxOf([{ ...good, schedule_layers: '[not json' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_LAYERS'))
})

test('validate rejects layers that parse to an empty array', async () => {
  const res = await validate(ctxOf([{ ...good, schedule_layers: '[]' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_LAYERS'))
})

test('validate rejects a layer with no users', async () => {
  const bad = '[{"start":"2026-01-01T00:00:00Z","rotation_virtual_start":"2026-01-01T00:00:00Z","rotation_turn_length_seconds":604800,"users":[]}]'
  const res = await validate(ctxOf([{ ...good, schedule_layers: bad }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_LAYERS'))
})

test('validate rejects a layer whose turn length is not positive', async () => {
  const bad = '[{"start":"2026-01-01T00:00:00Z","rotation_virtual_start":"2026-01-01T00:00:00Z","rotation_turn_length_seconds":0,"users":[{"user":{"id":"P1"}}]}]'
  const res = await validate(ctxOf([{ ...good, schedule_layers: bad }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_LAYERS'))
})

test('validate warns on a duplicate name', async () => {
  const res = await validate(ctxOf([good, { ...good, time_zone: 'Etc/UTC' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('parseScheduleLayers returns typed layers and defaults the user type', () => {
  const parsed = parseScheduleLayers('[{"start":"2026-01-01T00:00:00Z","rotation_virtual_start":"2026-01-01T00:00:00Z","rotation_turn_length_seconds":86400,"users":[{"user":{"id":"P1"}}]}]')
  assert.equal(parsed.error, null)
  assert.equal(parsed.layers?.length, 1)
  assert.equal(parsed.layers?.[0].rotation_turn_length_seconds, 86400)
  assert.equal(parsed.layers?.[0].users[0].user.id, 'P1')
  assert.equal(parsed.layers?.[0].users[0].user.type, 'user_reference')
})

test('parseScheduleLayers flags a missing start', () => {
  const parsed = parseScheduleLayers('[{"rotation_virtual_start":"2026-01-01T00:00:00Z","rotation_turn_length_seconds":86400,"users":[{"user":{"id":"P1"}}]}]')
  assert.equal(parsed.layers, null)
  assert.ok(parsed.error)
})

test('extractScheduleSpecs trims the name and carries the raw layers JSON', () => {
  const specs = extractScheduleSpecs(ctxOf([{ name: '  Primary  ', time_zone: 'Etc/UTC', schedule_layers: LAYERS }]).canvas)
  assert.equal(specs[0].name, 'Primary')
  assert.equal(specs[0].timeZone, 'Etc/UTC')
  assert.equal(specs[0].layersJson, LAYERS)
})

test('buildScheduleBody sets type, time_zone and layers', () => {
  const layers = parseScheduleLayers(LAYERS).layers!
  const body = buildScheduleBody({ itemName: 'g', name: 'Primary', timeZone: 'Etc/UTC', layersJson: LAYERS }, layers)
  assert.equal(body.type, 'schedule')
  assert.equal(body.name, 'Primary')
  assert.equal(body.time_zone, 'Etc/UTC')
  assert.equal(body.schedule_layers?.length, 1)
})

test('findSchedule matches by name case-insensitively', () => {
  const live = [{ id: 'PS1', name: 'Primary Rotation' }, { id: 'PS2', name: 'Secondary' }]
  assert.equal(findSchedule(live, 'primary rotation')?.id, 'PS1')
  assert.equal(findSchedule(live, 'missing'), null)
})
