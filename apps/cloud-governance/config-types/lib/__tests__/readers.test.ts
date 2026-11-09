import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readBoolean, readJsonArray, readList, readOptionalNumber, readRecord } from '../readers'
import { scoreChecks } from '../results'
import { diffFields, sameValue } from '../drift'
import { resolveStore } from '../store'

test('readJsonArray handles blank, arrays, valid and invalid JSON', () => {
  assert.deepEqual(readJsonArray({ a: '' }, 'a'), { value: [], issue: null })
  assert.deepEqual(readJsonArray({}, 'a'), { value: [], issue: null })
  assert.deepEqual(readJsonArray({ a: [1] }, 'a').value, [1])
  assert.deepEqual(readJsonArray({ a: '[{"x":1}]' }, 'a').value, [{ x: 1 }])
  assert.equal(readJsonArray({ a: '{' }, 'a').issue?.code, 'JSON_INVALID')
  assert.equal(readJsonArray({ a: '{}' }, 'a').issue?.code, 'JSON_NOT_ARRAY')
  assert.equal(readJsonArray({ a: 5 }, 'a').issue?.code, 'JSON_INVALID')
})

test('readOptionalNumber keeps unparseable text raw for the model validator', () => {
  assert.equal(readOptionalNumber({ n: '' }, 'n'), undefined)
  assert.equal(readOptionalNumber({ n: ' 12 ' }, 'n'), 12)
  assert.equal(readOptionalNumber({ n: 'abc' }, 'n'), 'abc')
  assert.equal(readOptionalNumber({ n: 4 }, 'n'), 4)
})

test('readList, readRecord and readBoolean tolerate the shapes the canvas produces', () => {
  assert.deepEqual(readList({ l: ' a, b\nc ' }, 'l'), ['a', 'b', 'c'])
  assert.deepEqual(readList({ l: ['x', ' ', 3] }, 'l'), ['x'])
  assert.deepEqual(readRecord({ r: [{ key: 'k', value: 'v' }, { key: ' ', value: 'z' }] }, 'r'), { k: 'v' })
  assert.deepEqual(readRecord({ r: { a: 1 } }, 'r'), { a: '1' })
  assert.equal(readBoolean({ b: 'false' }, 'b', true), false)
  assert.equal(readBoolean({}, 'b', true), true)
})

test('scoreChecks is a 0-100 percentage', () => {
  assert.equal(scoreChecks([]).score, 0)
  assert.deepEqual(scoreChecks([{ name: 'a', passed: true, message: '' }, { name: 'b', passed: false, message: '' }]).score, 50)
})

test('diffFields and sameValue compare structurally regardless of key order', () => {
  assert.equal(sameValue({ a: 1, b: { c: 2 } }, { b: { c: 2 }, a: 1 }), true)
  assert.deepEqual(diffFields('p', { a: 1, b: 2 }, { a: 1, b: 3 }).map((d) => d.field), ['p.b'])
})

test('resolveStore requires a usable db on the context', () => {
  assert.equal(resolveStore({ customerId: 'c' }), null)
  assert.equal(resolveStore({ customerId: 'c', db: {} } as any), null)
  assert.ok(resolveStore({ customerId: 'c', db: { $queryRawUnsafe: async () => [] } } as any))
})
