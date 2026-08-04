import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { SECRET, buildSecretRecord } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.id ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const textSecret = { id: 'db-credentials', worker_group: 'default', secret_type: 'text', value: 'token-abc123' }
const credsSecret = { id: 'ingest-bot', worker_group: 'default', secret_type: 'credentials', username: 'ingest-bot', password: 'app-password-123' }
const keypairSecret = { id: 'aws-key', worker_group: 'default', secret_type: 'keypair', api_key: 'AKIA...', secret_key: 'wJal...' }

test('validate rejects a missing id', async () => {
  const res = await validate(ctxOf([{ ...textSecret, id: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_ID'))
})

test('validate rejects an unrecognized secret_type', async () => {
  const res = await validate(ctxOf([{ ...textSecret, secret_type: 'oauth' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID'))
})

test('validate warns when secret material is blank', async () => {
  const res = await validate(ctxOf([{ ...textSecret, value: '' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'SECRET_BLANK'))
})

test('validate accepts a good text secret', async () => {
  const res = await validate(ctxOf([textSecret]))
  assert.equal(res.valid, true)
  assert.equal(res.warnings.length, 0)
})

test('validate accepts a good credentials secret', async () => {
  const res = await validate(ctxOf([credsSecret]))
  assert.equal(res.valid, true)
  assert.equal(res.warnings.length, 0)
})

test('validate accepts a good keypair secret', async () => {
  const res = await validate(ctxOf([keypairSecret]))
  assert.equal(res.valid, true)
  assert.equal(res.warnings.length, 0)
})

test('buildSecretRecord only includes the fields for its secret_type', () => {
  const spec = buildSecretRecord(credsSecret, {})
  assert.equal(spec.error, null)
  assert.deepEqual(spec.body, { id: 'ingest-bot', secretType: 'credentials', username: 'ingest-bot', password: 'app-password-123' })
})

test('SECRET declares its write-only fields as sensitiveKeys', () => {
  assert.equal(SECRET.resource, 'system/secrets')
  assert.deepEqual(SECRET.sensitiveKeys, ['value', 'password', 'apiKey', 'secretKey'])
})
