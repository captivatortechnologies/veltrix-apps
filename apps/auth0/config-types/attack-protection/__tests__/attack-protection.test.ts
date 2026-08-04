import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { declaredObjectField } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift/health handlers apply over the Auth0 Management API
 * via lib/auth0Api (global fetch), which is impractical to mock here. Tests focus
 * on validate.ts and the pure _shared helpers, which are network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: `item-${i}`, fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  breached_password_detection: '{"enabled":true,"shields":["block"]}',
  brute_force_protection: '{"enabled":true,"max_attempts":10}',
  suspicious_ip_throttling: '',
}

// --- validate ---------------------------------------------------------------

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate accepts a fully blank item', async () => {
  const res = await validate(ctxOf([{}]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate accepts well-formed JSON for every declared sub-resource', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
})

test('validate rejects malformed JSON in breached_password_detection', async () => {
  const res = await validate(ctxOf([{ ...good, breached_password_detection: '{bad' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_BREACHED_PASSWORD_DETECTION'))
})

test('validate rejects a JSON array for brute_force_protection', async () => {
  const res = await validate(ctxOf([{ ...good, brute_force_protection: '[1,2]' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_BRUTE_FORCE_PROTECTION'))
})

test('validate rejects malformed JSON in suspicious_ip_throttling', async () => {
  const res = await validate(ctxOf([{ ...good, suspicious_ip_throttling: '{oops' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_SUSPICIOUS_IP_THROTTLING'))
})

test('validate rejects more than one declared item', async () => {
  const res = await validate(ctxOf([good, good]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'singleton'))
})

// --- _shared helpers ---------------------------------------------------------

test('declaredObjectField treats a blank value as not declared', () => {
  assert.deepEqual(declaredObjectField(''), { declared: false, value: {} })
  assert.deepEqual(declaredObjectField(undefined), { declared: false, value: {} })
  assert.deepEqual(declaredObjectField(null), { declared: false, value: {} })
})

test('declaredObjectField parses a declared JSON object', () => {
  const result = declaredObjectField('{"enabled":true,"max_attempts":5}')
  assert.equal(result.declared, true)
  assert.deepEqual(result.value, { enabled: true, max_attempts: 5 })
})

test('declaredObjectField falls back to an empty object for malformed JSON', () => {
  const result = declaredObjectField('{not json')
  assert.equal(result.declared, true)
  assert.deepEqual(result.value, {})
})
