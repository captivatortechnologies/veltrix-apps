import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { accountFromReadEnvelope, accountFromWriteEnvelope, buildTrustedCloudAccountBody } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The network handlers apply over the Orca REST API via lib/orcaApi (fetch),
 * which is impractical to mock here. Tests focus on validate.ts and the pure
 * _shared helpers, which are network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.accountName ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  accountName: 'Vendor account',
  description: 'This is the AWS account for a security vendor we use.',
  cloudProvider: 'aws',
  cloudAccountId: '123412341234',
}

// --- validate ----------------------------------------------------------------

test('validate accepts a well-formed trusted account', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
})

test('validate rejects a missing account name', async () => {
  const res = await validate(ctxOf([{ ...good, accountName: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a missing description', async () => {
  const res = await validate(ctxOf([{ ...good, description: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_DESCRIPTION'))
})

test('validate rejects an unknown cloud provider', async () => {
  const res = await validate(ctxOf([{ ...good, cloudProvider: 'ibm' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_CLOUD_PROVIDER'))
})

test('validate rejects a missing cloud account id', async () => {
  const res = await validate(ctxOf([{ ...good, cloudAccountId: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_ACCOUNT_ID'))
})

test('validate warns on a duplicate account name', async () => {
  const res = await validate(ctxOf([good, { ...good }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared helpers ---------------------------------------------------------

test('buildTrustedCloudAccountBody maps canvas fields and only sets a numeric id when given', () => {
  const created = buildTrustedCloudAccountBody(good)
  assert.equal(created.account_name, good.accountName)
  assert.equal(created.cloud_provider, 'aws')
  assert.equal(created.cloud_provider_id, good.cloudAccountId)
  assert.equal(created.id, undefined)

  const updated = buildTrustedCloudAccountBody(good, '42')
  assert.equal(updated.id, 42)
})

test('accountFromWriteEnvelope unwraps a single-object envelope', () => {
  assert.deepEqual(accountFromWriteEnvelope({ data: { id: 42, account_name: 'x' } }), { id: 42, account_name: 'x' })
  assert.equal(accountFromWriteEnvelope(null), null)
})

test('accountFromReadEnvelope unwraps the ARRAY envelope GET returns, even for one id', () => {
  assert.deepEqual(accountFromReadEnvelope({ data: [{ id: 42, account_name: 'x' }] }), { id: 42, account_name: 'x' })
  assert.equal(accountFromReadEnvelope({ data: [] }), null)
  assert.equal(accountFromReadEnvelope(null), null)
})
