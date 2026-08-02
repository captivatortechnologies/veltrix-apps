import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildConnectionCreateBody,
  buildConnectionUpdateBody,
  findConnectionByName,
  nonSecretOptions,
  snapshotConnection,
  type Auth0Connection,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift/health handlers apply over the Auth0 Management API
 * via lib/auth0Api (global fetch), which is impractical to mock here. Tests focus
 * on validate.ts and the pure _shared helpers, which are network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  name: 'corp-db',
  strategy: 'auth0',
  display_name: 'Corporate Database',
  enabled_clients: 'abc123\ndef456',
  options: '{"passwordPolicy":"good"}',
}

// --- validate ---------------------------------------------------------------

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a name with invalid characters', async () => {
  const res = await validate(ctxOf([{ ...good, name: 'bad name!' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_NAME'))
})

test('validate rejects a name starting with a hyphen', async () => {
  const res = await validate(ctxOf([{ ...good, name: '-corp' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_NAME'))
})

test('validate rejects an unknown strategy', async () => {
  const res = await validate(ctxOf([{ ...good, strategy: 'carrier-pigeon' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_STRATEGY'))
})

test('validate rejects malformed options JSON', async () => {
  const res = await validate(ctxOf([{ ...good, options: '{not json' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_OPTIONS'))
})

test('validate rejects a JSON array for options', async () => {
  const res = await validate(ctxOf([{ ...good, options: '[1,2,3]' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_OPTIONS'))
})

test('validate warns on a duplicate connection name', async () => {
  const res = await validate(ctxOf([good, { ...good, display_name: 'Other' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate accepts a good connection with empty options', async () => {
  const res = await validate(ctxOf([{ ...good, options: '' }]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

// --- _shared helpers --------------------------------------------------------

test('buildConnectionCreateBody includes name, strategy, display_name, clients, options', () => {
  const body = buildConnectionCreateBody(good)
  assert.equal(body.name, 'corp-db')
  assert.equal(body.strategy, 'auth0')
  assert.equal(body.display_name, 'Corporate Database')
  assert.deepEqual(body.enabled_clients, ['abc123', 'def456'])
  assert.deepEqual(body.options, { passwordPolicy: 'good' })
})

test('buildConnectionUpdateBody omits name and strategy (immutable)', () => {
  const body = buildConnectionUpdateBody(good) as Record<string, unknown>
  assert.equal('name' in body, false)
  assert.equal('strategy' in body, false)
  assert.equal((body as { display_name?: string }).display_name, 'Corporate Database')
})

test('buildConnectionCreateBody omits empty optional fields', () => {
  const body = buildConnectionCreateBody({ name: 'x', strategy: 'auth0' })
  assert.equal('display_name' in body, false)
  assert.equal('enabled_clients' in body, false)
  assert.equal('options' in body, false)
})

test('findConnectionByName matches by trimmed name', () => {
  const list: Auth0Connection[] = [
    { id: 'con_1', name: 'corp-db' },
    { id: 'con_2', name: 'google' },
  ]
  assert.equal(findConnectionByName(list, 'google')?.id, 'con_2')
  assert.equal(findConnectionByName(list, 'missing'), null)
  assert.equal(findConnectionByName(list, ''), null)
})

test('nonSecretOptions strips secret-bearing keys', () => {
  const stripped = nonSecretOptions({ client_id: 'abc', client_secret: 'shh', signingCert: 'x', scope: 'openid' })
  assert.deepEqual(stripped, { client_id: 'abc', scope: 'openid' })
})

test('snapshotConnection captures non-secret options for restore', () => {
  const snap = snapshotConnection({
    id: 'con_1',
    name: 'corp-db',
    display_name: 'Corp',
    enabled_clients: ['abc'],
    options: { domain: 'corp.com', client_secret: 'shh' },
  })
  assert.equal(snap.display_name, 'Corp')
  assert.deepEqual(snap.enabled_clients, ['abc'])
  assert.deepEqual(snap.options, { domain: 'corp.com' })
})
