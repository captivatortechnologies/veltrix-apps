import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CLIENT_ID_RE, validClientId } from '../clientId'

test('validClientId accepts "C." followed by hex', () => {
  assert.equal(validClientId('C.1a2b3c4d5e6f7890'), true)
  assert.equal(validClientId('C.ABCDEF12'), true)
  assert.equal(validClientId('c.1a2b3c4d'), false) // the "C" prefix is case-sensitive
})

test('validClientId trims surrounding whitespace before matching', () => {
  assert.equal(validClientId('  C.1a2b3c4d  '), true)
})

test('validClientId rejects malformed ids', () => {
  assert.equal(validClientId(''), false)
  assert.equal(validClientId('1a2b3c4d'), false)
  assert.equal(validClientId('C.'), false)
  assert.equal(validClientId('C.not-hex'), false)
  assert.equal(validClientId('C.zz'), false)
})

test('CLIENT_ID_RE matches the same rule directly', () => {
  assert.equal(CLIENT_ID_RE.test('C.1a2b3c4d'), true)
  assert.equal(CLIENT_ID_RE.test('bad'), false)
})
