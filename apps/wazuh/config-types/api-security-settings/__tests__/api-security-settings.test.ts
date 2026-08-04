import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { specFromItem, toSecurityConfigBody, securityConfigEquals, parseNonNegativeInt } from '../_shared'
import type { PipelineContext, CanvasItemSnapshot } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift/health handlers apply over the Wazuh REST API via
 * node:https inside wazuhApi, which is impractical to mock here. Tests focus on
 * validate.ts and the pure _shared helpers, which are network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: `item-${i}`, fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { configLabel: 'Security Settings', auth_token_exp_timeout: 900, rbac_mode: 'white' }

test('validate rejects an empty canvas', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate warns (but passes) with more than one item', async () => {
  const res = await validate(ctxOf([good, good]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'SINGLETON_EXCESS'))
})

test('validate rejects a negative timeout', async () => {
  const res = await validate(ctxOf([{ ...good, auth_token_exp_timeout: -5 }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_TIMEOUT'))
})

test('validate rejects a non-integer timeout', async () => {
  const res = await validate(ctxOf([{ ...good, auth_token_exp_timeout: 12.5 }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_TIMEOUT'))
})

test('validate warns on black RBAC mode', async () => {
  const res = await validate(ctxOf([{ ...good, rbac_mode: 'black' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'BLACK_MODE'))
})

test('validate accepts good settings with no warnings', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.warnings.length, 0)
})

test('parseNonNegativeInt rejects negatives, floats and non-numbers', () => {
  assert.equal(parseNonNegativeInt(900), 900)
  assert.equal(parseNonNegativeInt(-1), null)
  assert.equal(parseNonNegativeInt(1.5), null)
  assert.equal(parseNonNegativeInt('abc'), null)
  assert.equal(parseNonNegativeInt(0), 0)
})

test('specFromItem defaults an unrecognized rbac_mode to white', () => {
  const item = { id: 'i0', name: 'x', fields: { ...good, rbac_mode: 'purple' } } as CanvasItemSnapshot
  assert.equal(specFromItem(item).rbacMode, 'white')
})

test('toSecurityConfigBody / securityConfigEquals round-trip', () => {
  const body = toSecurityConfigBody(specFromItem({ id: 'i0', name: 'x', fields: good } as CanvasItemSnapshot))
  assert.deepEqual(body, { auth_token_exp_timeout: 900, rbac_mode: 'white' })
  assert.equal(securityConfigEquals(body, { auth_token_exp_timeout: 900, rbac_mode: 'white' }), true)
  assert.equal(securityConfigEquals(body, { auth_token_exp_timeout: 901, rbac_mode: 'white' }), false)
})
