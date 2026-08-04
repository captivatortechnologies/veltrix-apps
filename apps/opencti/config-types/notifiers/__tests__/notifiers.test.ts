import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildNotifierInput, buildNotifierPatch, findNotifier, notifiersFromList } from '../_shared'
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
  name: 'Send Mail to Analyst',
  description: 'Emails the assigned analyst when a case is created.',
  notifier_connector_id: 'f2f27ca1-4d6f-4e5b-8e3f-1234567890ab',
  notifier_configuration: JSON.stringify({ title: 'New case assigned', template: 'A case was created: ${entity_name}' }),
}

test('validate accepts a good notifier', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true, JSON.stringify(res.errors))
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing name / connector id / configuration', async () => {
  const res = await validate(ctxOf([{ ...good, name: '', notifier_connector_id: '', notifier_configuration: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_CONNECTOR_ID'))
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_CONFIGURATION'))
})

test('validate rejects a malformed JSON configuration', async () => {
  const res = await validate(ctxOf([{ ...good, notifier_configuration: '{not valid json' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_JSON'))
})

test('validate warns on a duplicate notifier name', async () => {
  const res = await validate(ctxOf([good, { ...good, description: 'A different description.' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('buildNotifierInput omits a blank description but keeps required fields', () => {
  const input = buildNotifierInput({ ...good, description: '' })
  assert.equal(input.description, undefined)
  assert.equal(input.name, good.name)
  assert.equal(input.notifier_connector_id, good.notifier_connector_id)
  assert.equal(input.notifier_configuration, good.notifier_configuration)

  const full = buildNotifierInput(good)
  assert.equal(full.description, good.description)
})

test('buildNotifierPatch patches connector id and configuration and never patches the identity', () => {
  const patch = buildNotifierPatch(good)
  assert.ok(patch.every((p) => p.key !== 'name'))
  const connectorId = patch.find((p) => p.key === 'notifier_connector_id')
  assert.deepEqual(connectorId?.value, [good.notifier_connector_id])
  const configuration = patch.find((p) => p.key === 'notifier_configuration')
  assert.deepEqual(configuration?.value, [good.notifier_configuration])
})

test('notifiersFromList unwraps the edges/node connection', () => {
  const list = notifiersFromList({
    notifiers: {
      edges: [
        { node: { id: '1', name: 'Send Mail to Analyst' } },
        { node: { id: '2', name: 'UI Notification' } },
      ],
    },
  })
  assert.equal(list.length, 2)
  assert.equal(findNotifier(list, 'SEND MAIL TO ANALYST')?.id, '1')
})
