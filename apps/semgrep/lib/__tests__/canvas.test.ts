import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stringSetEqual } from '../canvas'

test('stringSetEqual matches equal sets regardless of order', () => {
  assert.equal(stringSetEqual(['a', 'b', 'c'], ['c', 'a', 'b']), true)
  assert.equal(stringSetEqual([], []), true)
})

test('stringSetEqual detects a length difference', () => {
  assert.equal(stringSetEqual(['a', 'b'], ['a']), false)
})

test('stringSetEqual detects a content difference of the same length', () => {
  assert.equal(stringSetEqual(['a', 'b'], ['a', 'c']), false)
})

test('stringSetEqual is exact-case (not case-insensitive)', () => {
  assert.equal(stringSetEqual(['A'], ['a']), false)
})
