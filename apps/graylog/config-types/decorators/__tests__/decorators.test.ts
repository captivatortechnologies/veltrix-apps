import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildDecoratorBody, bodyFromLiveDecorator, decoratorsFromList, findDecorator } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.type ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { stream_title: '', type: 'format-message-field-decorator', order: 0, config: '{"field":"src_ip"}' }

test('validate accepts a well-formed global decorator', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing type', async () => {
  const res = await validate(ctxOf([{ ...good, type: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_TYPE'))
})

test('validate rejects malformed config JSON', async () => {
  const res = await validate(ctxOf([{ ...good, config: '{ nope' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_CONFIG_JSON'))
})

test('validate warns on a duplicate (stream, type) pair', async () => {
  const res = await validate(ctxOf([good, { ...good, order: 1 }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_DECORATOR'))
})

test('validate allows the same type on different streams without warning', async () => {
  const res = await validate(ctxOf([good, { ...good, stream_title: 'Firewall' }]))
  assert.equal(res.warnings.some((w) => w.code === 'DUPLICATE_DECORATOR'), false)
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('buildDecoratorBody omits stream for the global scope', () => {
  const { body, error } = buildDecoratorBody(good, '')
  assert.equal(error, undefined)
  assert.equal(body?.stream, undefined)
  assert.deepEqual(body?.config, { field: 'src_ip' })
})

test('buildDecoratorBody includes stream when a stream id is resolved', () => {
  const { body } = buildDecoratorBody(good, 'stream-1')
  assert.equal(body?.stream, 'stream-1')
})

test('bodyFromLiveDecorator maps a live decorator back to a request body', () => {
  const body = bodyFromLiveDecorator({ type: 'x', config: { a: 1 }, stream: 's1', order: 2 })
  assert.equal(body.stream, 's1')
  assert.equal(body.order, 2)
})

test('decoratorsFromList + findDecorator match by the (stream, type) pair', () => {
  const live = decoratorsFromList([
    { id: '1', type: 'x', stream: 's1' },
    { id: '2', type: 'x' },
  ])
  assert.equal(live.length, 2)
  assert.equal(findDecorator(live, 's1', 'x')?.id, '1')
  assert.equal(findDecorator(live, '', 'x')?.id, '2')
  assert.equal(findDecorator(live, 's2', 'x'), null)
})
