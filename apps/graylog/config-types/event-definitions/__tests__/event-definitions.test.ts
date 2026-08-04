import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildEventDefinitionEntity, bodyFromLiveEventDefinition, eventDefinitionsFromList, findEventDefinition } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.title ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  title: 'Repeated Auth Failures',
  description: 'Fires when a source fails auth 5+ times in a minute',
  priority: '3',
  alert: true,
  enabled: true,
  config: '{"type":"aggregation-v1","query":"action:login_failed","streams":["000000000000000000000001"],"group_by":["source"],"series":[{"id":"count-1","function":"count","field":null}],"conditions":{"expression":{"expr":">","left":{"expr":"number-ref","ref":"count-1"},"right":{"expr":"number","value":5}}},"search_within_ms":60000,"execute_every_ms":60000}',
  field_spec: '{}',
  key_spec: '[]',
  notification_settings: '{"grace_period_ms":0,"backlog_size":0}',
  notifications: '[{"notification_id":"abc123","notification_parameters":{}}]',
  storage: '[]',
  tags: '["brute-force"]',
}

test('validate accepts a well-formed event definition', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing title', async () => {
  const res = await validate(ctxOf([{ ...good, title: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_TITLE'))
})

test('validate rejects config missing a type discriminator', async () => {
  const res = await validate(ctxOf([{ ...good, config: '{"query":"x"}' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_CONFIG'))
})

test('validate rejects malformed key_spec JSON', async () => {
  const res = await validate(ctxOf([{ ...good, key_spec: '{ nope' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_CONFIG'))
})

test('validate warns when no notifications are attached', async () => {
  const res = await validate(ctxOf([{ ...good, notifications: '[]' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'NO_NOTIFICATIONS'))
})

test('validate warns on a duplicate title', async () => {
  const res = await validate(ctxOf([good, { ...good, description: 'copy' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_TITLE'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('buildEventDefinitionEntity parses every JSON field and threads schedule', () => {
  const { entity, schedule, error } = buildEventDefinitionEntity(good)
  assert.equal(error, undefined)
  assert.equal(schedule, true)
  assert.equal(entity?.priority, 3)
  assert.equal(entity?.notifications.length, 1)
  assert.deepEqual(entity?.tags, ['brute-force'])
})

test('buildEventDefinitionEntity threads enabled:false to schedule:false', () => {
  const { schedule } = buildEventDefinitionEntity({ ...good, enabled: false })
  assert.equal(schedule, false)
})

test('buildEventDefinitionEntity defaults notification_settings when blank', () => {
  const { entity } = buildEventDefinitionEntity({ ...good, notification_settings: '' })
  assert.deepEqual(entity?.notification_settings, { grace_period_ms: 0, backlog_size: 0 })
})

test('bodyFromLiveEventDefinition strips server-computed keys', () => {
  const body = bodyFromLiveEventDefinition({ id: 'e1', title: 'X', scheduler: { foo: 1 }, updated_at: 'now' } as any)
  assert.equal(body.id, 'e1')
  assert.equal((body as any).scheduler, undefined)
  assert.equal((body as any).updated_at, undefined)
})

test('eventDefinitionsFromList + findEventDefinition match by title from the API envelope', () => {
  const live = eventDefinitionsFromList({ event_definitions: [{ id: '1', title: 'A' }, { id: '2', title: 'B' }] })
  assert.equal(live.length, 2)
  assert.equal(findEventDefinition(live, 'B')?.id, '2')
  assert.equal(findEventDefinition(live, 'nope'), null)
})
