import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildScope,
  displayLabels,
  displayList,
  displayScope,
  keyvalueEntries,
  normalizeBoolean,
  normalizeNumber,
  sameLabels,
  sameScope,
  sameStringSet,
  splitList,
  toLabels,
  toScopeVariables,
} from '../common'

test('splitList handles arrays and comma/newline strings', () => {
  assert.deepEqual(splitList(['a', ' b ', '']), ['a', 'b'])
  assert.deepEqual(splitList('a, b\nc'), ['a', 'b', 'c'])
  assert.deepEqual(splitList(undefined), [])
})

test('keyvalueEntries reads a plain object into sorted [key, value] pairs', () => {
  assert.deepEqual(keyvalueEntries({ b: '2', a: '1' }), [
    ['a', '1'],
    ['b', '2'],
  ])
  assert.deepEqual(keyvalueEntries(undefined), [])
  assert.deepEqual(keyvalueEntries([1, 2]), [])
})

test('normalizeBoolean reads booleans, string forms and falls back', () => {
  assert.equal(normalizeBoolean(true), true)
  assert.equal(normalizeBoolean('false'), false)
  assert.equal(normalizeBoolean('1'), true)
  assert.equal(normalizeBoolean(undefined, true), true)
  assert.equal(normalizeBoolean('nonsense', false), false)
})

test('normalizeNumber reads numbers, numeric strings and falls back', () => {
  assert.equal(normalizeNumber(5), 5)
  assert.equal(normalizeNumber('7'), 7)
  assert.equal(normalizeNumber('nonsense', 3), 3)
  assert.equal(normalizeNumber(undefined, 0), 0)
})

test('toScopeVariables converts a keyvalue object to attribute/value pairs', () => {
  assert.deepEqual(toScopeVariables({ 'image.repo': 'nginx' }), [{ attribute: 'image.repo', value: 'nginx' }])
})

test('toLabels converts a keyvalue object to key/value pairs', () => {
  assert.deepEqual(toLabels({ team: 'platform' }), [{ key: 'team', value: 'platform' }])
})

test('buildScope omits an entirely empty scope, keeps a populated one', () => {
  assert.equal(buildScope('', undefined), undefined)
  assert.deepEqual(buildScope('v1', { 'image.repo': 'nginx' }), {
    expression: 'v1',
    variables: [{ attribute: 'image.repo', value: 'nginx' }],
  })
})

test('sameStringSet is order-insensitive', () => {
  assert.equal(sameStringSet(['a', 'b'], ['b', 'a']), true)
  assert.equal(sameStringSet(['a'], ['a', 'b']), false)
})

test('sameScope compares expression + variables order-insensitively', () => {
  const a = { expression: 'v1 && v2', variables: [{ attribute: 'a', value: '1' }, { attribute: 'b', value: '2' }] }
  const b = { expression: 'v1 && v2', variables: [{ attribute: 'b', value: '2' }, { attribute: 'a', value: '1' }] }
  assert.equal(sameScope(a, b), true)
  assert.equal(sameScope(a, undefined), false)
  assert.equal(sameScope(undefined, undefined), true)
})

test('sameLabels compares key/value pairs order-insensitively', () => {
  assert.equal(sameLabels([{ key: 'a', value: '1' }], [{ key: 'a', value: '1' }]), true)
  assert.equal(sameLabels([{ key: 'a', value: '1' }], [{ key: 'a', value: '2' }]), false)
})

test('displayList and displayLabels sort for stable diff rendering', () => {
  assert.equal(displayList(['b', 'a']), 'a, b')
  assert.equal(displayLabels([{ key: 'b', value: '2' }, { key: 'a', value: '1' }]), 'a=1, b=2')
})

test('displayScope renders a readable summary', () => {
  assert.equal(displayScope(undefined), '(none)')
  assert.equal(displayScope({ expression: 'v1', variables: [{ attribute: 'a', value: '1' }] }), 'v1 [a=1]')
})
