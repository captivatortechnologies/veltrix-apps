import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { DATABASE_CONNECTION, buildDatabaseConnectionRecord } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.id ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  id: 'db-prod-01',
  worker_group: 'default',
  database_type: 'postgres',
  auth_type: 'connectionString',
  description: 'Primary application database',
  connection_string: 'postgresql://db.example.com:5432/appdb',
}

test('validate rejects a missing id', async () => {
  const res = await validate(ctxOf([{ ...good, id: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_ID'))
})

test('validate rejects an unrecognized database_type', async () => {
  const res = await validate(ctxOf([{ ...good, database_type: 'mongo' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID'))
})

test('validate rejects a missing description', async () => {
  const res = await validate(ctxOf([{ ...good, description: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID'))
})

test('validate warns when no credential mechanism is set', async () => {
  const res = await validate(ctxOf([{ ...good, connection_string: '' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'NO_CREDENTIAL'))
})

test('validate accepts a good connection', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
  assert.equal(res.warnings.length, 0)
})

test('buildDatabaseConnectionRecord includes sensitive fields only when non-blank', () => {
  const spec = buildDatabaseConnectionRecord(good, {})
  assert.equal(spec.error, null)
  assert.equal(spec.body?.connectionString, good.connection_string)
  assert.equal(spec.body?.password, undefined)
})

test('DATABASE_CONNECTION declares its write-only fields as sensitiveKeys', () => {
  assert.equal(DATABASE_CONNECTION.resource, 'lib/database-connections')
  assert.deepEqual(DATABASE_CONNECTION.sensitiveKeys, ['connectionString', 'password', 'configObj'])
})
