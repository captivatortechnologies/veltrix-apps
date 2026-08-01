import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildObservableTypeBody, parseBool, findObservableType, observableTypeId, observableTypesFromList } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * deploy/rollback/drift apply over the TheHive REST API (node:https inside
 * thehiveApi), impractical to mock here. Tests cover validate.ts and the pure
 * network-free _shared helpers.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ isAttachment: false }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate warns on a whitespace name', async () => {
  const res = await validate(ctxOf([{ name: 'my type' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'NAME_WHITESPACE'))
})

test('validate warns on a duplicate name', async () => {
  const res = await validate(ctxOf([{ name: 'ip' }, { name: 'ip' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate accepts a good type', async () => {
  const res = await validate(ctxOf([{ name: 'filename', isAttachment: false }]))
  assert.equal(res.valid, true, JSON.stringify(res.errors))
  assert.equal(res.errors.length, 0)
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('buildObservableTypeBody coerces isAttachment and trims name', () => {
  assert.deepEqual(buildObservableTypeBody({ name: '  ip ', isAttachment: 'true' }), { name: 'ip', isAttachment: true })
  assert.deepEqual(buildObservableTypeBody({ name: 'domain' }), { name: 'domain', isAttachment: false })
})

test('parseBool coerces common forms', () => {
  assert.equal(parseBool('on'), true)
  assert.equal(parseBool(true), true)
  assert.equal(parseBool('no'), false)
})

test('findObservableType matches by name; observableTypeId prefers _id then id', () => {
  const live = [{ _id: 'abc', name: 'ip' }, { id: 3, name: 'domain' }]
  assert.equal(observableTypeId(findObservableType(live, 'ip')), 'abc')
  assert.equal(observableTypeId(findObservableType(live, 'domain')), '3')
  assert.equal(findObservableType(live, 'nope'), null)
})

test('observableTypesFromList unwraps arrays and wrapped rows', () => {
  assert.equal(observableTypesFromList([{ name: 'ip' }]).length, 1)
  assert.equal(observableTypesFromList({ data: [{ name: 'ip' }] }).length, 1)
  assert.equal(observableTypesFromList(null).length, 0)
})
