import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildCreateBody,
  managedFieldsToPatchBody,
  readManagedFields,
  readPolicyType,
  sameManagedFields,
  snapshotManagedFields,
  type AuthentikPolicy,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const expressionGood = {
  name: 'Require Corp Domain',
  type: 'expression',
  execution_logging: false,
  expression: 'return request.user.email.endswith("@example.com")',
}
const passwordGood = { name: 'Strong Passwords', type: 'password', length_min: 12, amount_uppercase: 1 }
const reputationGood = { name: 'Block Low Reputation', type: 'reputation', check_ip: true, check_username: true, threshold: -5 }

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...expressionGood, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects an unknown type', async () => {
  const res = await validate(ctxOf([{ ...expressionGood, type: 'geofence' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_TYPE'))
})

test('validate requires an expression for Type = expression', async () => {
  const res = await validate(ctxOf([{ ...expressionGood, expression: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_EXPRESSION'))
})

test('validate does not require an expression for Type = password or reputation', async () => {
  const res = await validate(ctxOf([passwordGood, reputationGood]))
  assert.equal(res.valid, true)
})

test('validate accepts all three fully populated policy types', async () => {
  const res = await validate(ctxOf([expressionGood, passwordGood, reputationGood]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('readPolicyType defaults an invalid/blank type to expression', () => {
  assert.equal(readPolicyType('bogus'), 'expression')
  assert.equal(readPolicyType(''), 'expression')
  assert.equal(readPolicyType('password'), 'password')
})

test('buildCreateBody for expression only sends expression fields', () => {
  const body = buildCreateBody(expressionGood) as Record<string, unknown>
  assert.equal(body.expression, expressionGood.expression)
  assert.equal('threshold' in body, false)
  assert.equal('length_min' in body, false)
})

test('buildCreateBody for password only sends password fields', () => {
  const body = buildCreateBody(passwordGood) as Record<string, unknown>
  assert.equal(body.length_min, 12)
  assert.equal(body.amount_uppercase, 1)
  assert.equal('expression' in body, false)
  assert.equal('threshold' in body, false)
})

test('buildCreateBody for reputation only sends reputation fields', () => {
  const body = buildCreateBody(reputationGood) as Record<string, unknown>
  assert.equal(body.threshold, -5)
  assert.equal(body.check_ip, true)
  assert.equal('expression' in body, false)
  assert.equal('length_min' in body, false)
})

test('snapshotManagedFields + sameManagedFields agree for an unchanged expression policy', () => {
  const expected = readManagedFields(expressionGood)
  const live: AuthentikPolicy = { pk: 'uuid-1', name: 'Require Corp Domain', execution_logging: false, expression: expressionGood.expression }
  const actual = snapshotManagedFields(live, 'expression')
  assert.equal(sameManagedFields(expected, actual), true)
})

test('sameManagedFields flags a changed password policy length_min', () => {
  const expected = readManagedFields(passwordGood)
  const actual = snapshotManagedFields({ pk: 'uuid-2', name: 'Strong Passwords', length_min: 8, amount_uppercase: 1 }, 'password')
  assert.equal(sameManagedFields(expected, actual), false)
})

test('managedFieldsToPatchBody round-trips a captured reputation snapshot', () => {
  const managed = readManagedFields(reputationGood)
  const body = managedFieldsToPatchBody(managed) as Record<string, unknown>
  assert.equal(body.threshold, -5)
})
