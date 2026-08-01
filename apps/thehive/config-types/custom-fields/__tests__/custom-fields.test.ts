import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildCustomFieldBody,
  buildCustomFieldUpdate,
  toUpdateBody,
  normalizeType,
  parseBool,
  parseOptions,
  findCustomField,
  customFieldId,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift handlers apply over the TheHive REST API via
 * node:https inside thehiveApi, which is impractical to mock here. Tests focus on
 * validate.ts and the pure _shared helpers, which are network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { name: 'business-impact', displayName: 'Business Impact', group: 'impact', description: 'How bad', type: 'string', mandatory: true, options: 'low\nhigh' }

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects an unknown type', async () => {
  const res = await validate(ctxOf([{ ...good, type: 'enumeration' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_TYPE'))
})

test('validate warns on options for a boolean field', async () => {
  const res = await validate(ctxOf([{ ...good, type: 'boolean', options: 'a,b' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'OPTIONS_IGNORED'))
})

test('validate warns on a duplicate name', async () => {
  const res = await validate(ctxOf([good, { ...good, description: 'copy' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate accepts a good field', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true, JSON.stringify(res.errors))
  assert.equal(res.errors.length, 0)
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('normalizeType validates and falls back to string', () => {
  assert.equal(normalizeType('integer'), 'integer')
  assert.equal(normalizeType('URL'), 'url')
  assert.equal(normalizeType('enumeration'), 'string')
  assert.equal(normalizeType(''), 'string')
})

test('parseBool coerces common truthy forms', () => {
  assert.equal(parseBool(true), true)
  assert.equal(parseBool('true'), true)
  assert.equal(parseBool('yes'), true)
  assert.equal(parseBool('false'), false)
  assert.equal(parseBool(''), false)
})

test('parseOptions splits on newlines and commas, dedupes', () => {
  assert.deepEqual(parseOptions('low, high\nlow\n  mid '), ['low', 'high', 'mid'])
  assert.deepEqual(parseOptions(''), [])
})

test('buildCustomFieldBody defaults group/description and includes options', () => {
  const body = buildCustomFieldBody({ name: 'x', type: 'integer', options: 'a,b', mandatory: 'true' })
  assert.equal(body.name, 'x')
  assert.equal(body.displayName, 'x')
  assert.equal(body.group, 'default')
  assert.equal(body.description, '')
  assert.equal(body.type, 'integer')
  assert.equal(body.mandatory, true)
  assert.deepEqual(body.options, ['a', 'b'])
})

test('buildCustomFieldBody omits options when none given', () => {
  const body = buildCustomFieldBody({ name: 'x', type: 'string' })
  assert.equal(body.options, undefined)
})

test('buildCustomFieldUpdate / toUpdateBody drop the name', () => {
  const update = buildCustomFieldUpdate({ name: 'x', type: 'string', group: 'g' })
  assert.ok(!('name' in update))
  assert.equal(update.group, 'g')
  const restore = toUpdateBody({ name: 'x', type: 'date', group: 'g', displayName: 'X', mandatory: false })
  assert.ok(!('name' in restore))
  assert.equal(restore.type, 'date')
})

test('findCustomField matches by name; customFieldId prefers _id then id', () => {
  const live = [{ _id: 'abc', name: 'a' }, { id: 7, name: 'b' }]
  assert.equal(customFieldId(findCustomField(live, 'a')), 'abc')
  assert.equal(customFieldId(findCustomField(live, 'b')), '7')
  assert.equal(findCustomField(live, 'nope'), null)
})
