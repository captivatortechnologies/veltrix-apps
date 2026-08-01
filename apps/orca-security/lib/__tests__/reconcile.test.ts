import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  canonicalJson,
  dataFromEnvelope,
  normalizeBool,
  normalizeStringList,
  parseJsonField,
  priorServerId,
  type ReconcileEntry,
} from '../reconcile'

test('dataFromEnvelope unwraps the { data: {...} } envelope', () => {
  assert.deepEqual(dataFromEnvelope({ data: { a: 1 } }), { a: 1 })
  assert.equal(dataFromEnvelope({ data: null }), null)
  assert.equal(dataFromEnvelope(null), null)
  assert.equal(dataFromEnvelope('nope'), null)
})

test('normalizeBool coerces strings and falls back', () => {
  assert.equal(normalizeBool('false'), false)
  assert.equal(normalizeBool('disabled'), false)
  assert.equal(normalizeBool('true'), true)
  assert.equal(normalizeBool(undefined, true), true)
  assert.equal(normalizeBool('', false), false)
})

test('normalizeStringList handles arrays, delimited strings and de-dups', () => {
  assert.deepEqual(normalizeStringList(['a', ' b ', 'a', '']), ['a', 'b'])
  assert.deepEqual(normalizeStringList('a, b\nc'), ['a', 'b', 'c'])
  assert.deepEqual(normalizeStringList(''), [])
  assert.deepEqual(normalizeStringList(undefined), [])
})

test('parseJsonField returns a discriminated result', () => {
  const ok = parseJsonField('{"a":1}', 'X')
  assert.equal(ok.ok, true)
  if (ok.ok) assert.deepEqual(ok.value, { a: 1 })

  const empty = parseJsonField('', 'X')
  assert.equal(empty.ok, false)

  const bad = parseJsonField('{oops}', 'X')
  assert.equal(bad.ok, false)
})

test('canonicalJson is key-order independent but array-order sensitive', () => {
  assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }))
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]))
})

test('priorServerId matches by stable item id first, then by name', () => {
  const previous: ReconcileEntry[] = [
    { itemId: 'i0', name: 'Old name', serverId: 'id-1', existed: false, prior: null },
    { itemId: 'i1', name: 'Second', serverId: 'id-2', existed: true, prior: null },
  ]
  assert.equal(priorServerId(previous, 'i0', 'Renamed'), 'id-1')
  assert.equal(priorServerId(previous, 'zzz', 'Second'), 'id-2')
  assert.equal(priorServerId(previous, 'zzz', 'Nothing'), null)
  assert.equal(priorServerId(undefined, 'i0', 'x'), null)
})
