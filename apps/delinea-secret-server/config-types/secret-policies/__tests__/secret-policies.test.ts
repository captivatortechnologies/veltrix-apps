import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  extractPolicySpecs,
  findPolicyByName,
  policyIdOf,
  buildPolicyCreateBody,
  buildPolicyUpdateBody,
  buildPolicyRestoreBody,
  type LivePolicy,
} from '../_shared'
import { recordsFromResponse, normalizeBool } from '../../../lib/secretServerApi'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * deploy / rollback / drift / health apply over the Secret Server REST API via
 * node:https inside secretServerApi, which is impractical to mock here. Tests
 * cover validate.ts and the pure, network-free helpers.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.secretPolicyName ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { secretPolicyName: 'Require Checkout', secretPolicyDescription: 'Force check-out on privileged secrets', active: true, comment: 'audit' }

// --- validate ---------------------------------------------------------------

test('validate rejects a missing policy name', async () => {
  const res = await validate(ctxOf([{ ...good, secretPolicyName: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate accepts a good policy', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate warns on a duplicate policy name', async () => {
  const res = await validate(ctxOf([good, { ...good, comment: 'copy' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_POLICY'))
})

test('validate rejects a name longer than 255 characters', async () => {
  const res = await validate(ctxOf([{ ...good, secretPolicyName: 'x'.repeat(256) }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'NAME_TOO_LONG'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared helpers --------------------------------------------------------

test('extractPolicySpecs maps and trims canvas fields', () => {
  const specs = extractPolicySpecs(toItems([{ secretPolicyName: '  Require Checkout  ', secretPolicyDescription: ' desc ', active: false }]))
  assert.equal(specs[0].secretPolicyName, 'Require Checkout')
  assert.equal(specs[0].secretPolicyDescription, 'desc')
  assert.equal(specs[0].active, false)
})

test('recordsFromResponse parses a paginated envelope and a bare array', () => {
  const env = recordsFromResponse<LivePolicy>(JSON.stringify({ records: [{ secretPolicyId: 1, secretPolicyName: 'A' }], total: 1 }))
  assert.equal(env.records.length, 1)
  assert.equal(env.total, 1)
  const arr = recordsFromResponse<LivePolicy>(JSON.stringify([{ secretPolicyId: 2, secretPolicyName: 'B' }]))
  assert.equal(arr.records.length, 1)
  assert.equal(recordsFromResponse('not json').records.length, 0)
})

test('findPolicyByName matches case-insensitively', () => {
  const policies: LivePolicy[] = [
    { secretPolicyId: 1, secretPolicyName: 'Require Checkout' },
    { secretPolicyId: 2, secretPolicyName: 'Heartbeat' },
  ]
  assert.equal(findPolicyByName(policies, 'require checkout')?.secretPolicyId, 1)
  assert.equal(findPolicyByName(policies, 'HEARTBEAT')?.secretPolicyId, 2)
  assert.equal(findPolicyByName(policies, 'nope'), null)
})

test('policyIdOf reads numeric ids and rejects blanks', () => {
  assert.equal(policyIdOf({ secretPolicyId: 42 }), 42)
  assert.equal(policyIdOf({ secretPolicyId: '7' }), 7)
  assert.equal(policyIdOf({}), null)
})

test('buildPolicyCreateBody nests managed fields under data', () => {
  const spec = extractPolicySpecs(toItems([good]))[0]
  const body = buildPolicyCreateBody(spec) as { data: Record<string, unknown> }
  assert.equal(body.data.secretPolicyName, 'Require Checkout')
  assert.equal(body.data.secretPolicyDescription, 'Force check-out on privileged secrets')
  assert.equal(body.data.active, true)
})

test('buildPolicyUpdateBody wraps each field in { dirty, value }', () => {
  const spec = extractPolicySpecs(toItems([{ ...good, active: false }]))[0]
  const body = buildPolicyUpdateBody(spec) as { data: Record<string, { dirty: boolean; value: unknown }> }
  assert.equal(body.data.secretPolicyName.dirty, true)
  assert.equal(body.data.secretPolicyName.value, 'Require Checkout')
  assert.equal(body.data.active.value, false)
})

test('buildPolicyRestoreBody restores prior managed fields with the dirty wrapper', () => {
  const body = buildPolicyRestoreBody({ secretPolicyName: 'Old', secretPolicyDescription: 'd', active: true }) as {
    data: Record<string, { dirty: boolean; value: unknown }>
  }
  assert.equal(body.data.secretPolicyName.value, 'Old')
  assert.equal(body.data.active.value, true)
})

test('normalizeBool coerces booleans, strings and numbers', () => {
  assert.equal(normalizeBool(true), true)
  assert.equal(normalizeBool('true'), true)
  assert.equal(normalizeBool('1'), true)
  assert.equal(normalizeBool('no'), false)
  assert.equal(normalizeBool(undefined), false)
})
