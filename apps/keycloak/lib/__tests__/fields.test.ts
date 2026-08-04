import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readJsonArray, readJsonObject, parseJsonField } from '../fields'

// --- readJsonObject ------------------------------------------------------------

test('readJsonObject parses a JSON object string', () => {
  assert.deepEqual(readJsonObject('{"a":"1"}', {}), { a: '1' })
})

test('readJsonObject passes an already-parsed object through', () => {
  assert.deepEqual(readJsonObject({ a: 1 }, {}), { a: 1 })
})

test('readJsonObject falls back on a blank string', () => {
  assert.deepEqual(readJsonObject('', { fallback: true }), { fallback: true })
  assert.deepEqual(readJsonObject(undefined, { fallback: true }), { fallback: true })
})

test('readJsonObject falls back on invalid JSON', () => {
  assert.deepEqual(readJsonObject('{not json', { fallback: true }), { fallback: true })
})

test('readJsonObject falls back when the JSON parses to an array', () => {
  assert.deepEqual(readJsonObject('[1,2]', { fallback: true }), { fallback: true })
})

// --- readJsonArray ---------------------------------------------------------------

test('readJsonArray parses a JSON array string', () => {
  assert.deepEqual(readJsonArray('[1,2,3]'), [1, 2, 3])
})

test('readJsonArray passes an already-parsed array through', () => {
  assert.deepEqual(readJsonArray([{ a: 1 }]), [{ a: 1 }])
})

test('readJsonArray returns [] on a blank string, invalid JSON, or a non-array', () => {
  assert.deepEqual(readJsonArray(''), [])
  assert.deepEqual(readJsonArray('{not json'), [])
  assert.deepEqual(readJsonArray('{"a":1}'), [])
  assert.deepEqual(readJsonArray(undefined), [])
})

// --- parseJsonField --------------------------------------------------------------

test('parseJsonField treats blank/undefined as ok with an undefined value', () => {
  assert.deepEqual(parseJsonField(undefined), { ok: true, value: undefined })
  assert.deepEqual(parseJsonField(''), { ok: true, value: undefined })
  assert.deepEqual(parseJsonField('   '), { ok: true, value: undefined })
})

test('parseJsonField parses valid JSON', () => {
  assert.deepEqual(parseJsonField('[1,2]'), { ok: true, value: [1, 2] })
})

test('parseJsonField passes an already-parsed value through', () => {
  const value = { a: 1 }
  assert.deepEqual(parseJsonField(value), { ok: true, value })
})

test('parseJsonField reports invalid JSON as not ok', () => {
  assert.deepEqual(parseJsonField('{not json'), { ok: false })
})
