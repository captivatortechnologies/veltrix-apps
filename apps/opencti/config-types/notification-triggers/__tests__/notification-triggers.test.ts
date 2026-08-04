import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildTriggerInput,
  buildTriggerPatch,
  findTrigger,
  notifierIdsOf,
  recipientIdsOf,
  resolveNotifierIds,
  toStringList,
  triggersFromList,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift handlers apply over the OpenCTI GraphQL API via
 * node:https inside openctiApi, which is impractical to mock here. Tests focus
 * on validate.ts (pure, network-free) and the pure _shared helpers.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  name: 'New Critical Indicators',
  description: 'Notify on new high-confidence indicators',
  event_types: ['create'],
  instance_trigger: false,
  filters: '{"mode":"and","filters":[],"filterGroups":[]}',
  recipients: ['user--1'],
  notifier_names: ['Email Analysts'],
}

test('validate rejects a missing trigger name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects no event types', async () => {
  const res = await validate(ctxOf([{ ...good, event_types: [] }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_EVENT_TYPES'))
})

test('validate rejects an unknown event type', async () => {
  const res = await validate(ctxOf([{ ...good, event_types: ['create', 'archive'] }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_EVENT_TYPE'))
})

test('validate rejects malformed filters JSON', async () => {
  const res = await validate(ctxOf([{ ...good, filters: '{not json' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_FILTERS_JSON'))
})

test('validate warns on a duplicate trigger name', async () => {
  const res = await validate(ctxOf([good, { ...good, description: 'dup' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate accepts a good trigger and a minimal one', async () => {
  const full = await validate(ctxOf([good]))
  assert.equal(full.valid, true, JSON.stringify(full.errors))

  const bare = await validate(ctxOf([{ name: 'Minimal', event_types: ['update'] }]))
  assert.equal(bare.valid, true)
  assert.equal(bare.errors.length, 0)
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('resolveNotifierIds matches case-insensitively and reports unresolved names', () => {
  const live = [{ id: 'n1', name: 'Email Analysts' }]
  const { ids, unresolved } = resolveNotifierIds(['email analysts', 'Missing'], live)
  assert.deepEqual(ids, ['n1'])
  assert.deepEqual(unresolved, ['Missing'])
})

test('buildTriggerInput carries required fields and only sets notifiers/recipients when non-empty', () => {
  const input = buildTriggerInput({ name: 'Minimal', event_types: ['update'] }, [])
  assert.deepEqual(input, { name: 'Minimal', event_types: ['update'], instance_trigger: false })

  const full = buildTriggerInput(good, ['n1'])
  assert.deepEqual(full.event_types, ['create'])
  assert.equal(full.instance_trigger, false)
  assert.deepEqual(full.recipients, ['user--1'])
  assert.deepEqual(full.notifiers, ['n1'])
})

test('buildTriggerPatch never patches the identity and replaces array fields wholesale', () => {
  const patch = buildTriggerPatch(good, ['n1'])
  assert.ok(patch.every((p) => p.key !== 'name'))
  const eventTypes = patch.find((p) => p.key === 'event_types')
  assert.deepEqual(eventTypes?.value, ['create'])
  const notifiers = patch.find((p) => p.key === 'notifiers')
  assert.deepEqual(notifiers?.value, ['n1'])
  const instanceTrigger = patch.find((p) => p.key === 'instance_trigger')
  assert.deepEqual(instanceTrigger?.value, [false])
})

test('notifierIdsOf / recipientIdsOf extract ids from their respective object lists', () => {
  const trigger = { notifiers: [{ id: 'n1' }, { id: 'n2' }], recipients: [{ id: 'user--1' }] }
  assert.deepEqual(notifierIdsOf(trigger), ['n1', 'n2'])
  assert.deepEqual(recipientIdsOf(trigger), ['user--1'])
})

test('toStringList normalizes array and comma-separated values', () => {
  assert.deepEqual(toStringList(['create', 'create', 'update']), ['create', 'update'])
  assert.deepEqual(toStringList('create, update'), ['create', 'update'])
})

test('triggersFromList unwraps the edges/node connection', () => {
  const list = triggersFromList({
    triggers: { edges: [{ node: { id: '1', name: 'New Critical Indicators' } }, { node: { id: '2', name: 'Other' } }] },
  })
  assert.equal(list.length, 2)
  assert.equal(findTrigger(list, 'new critical indicators')?.id, '1')
})
