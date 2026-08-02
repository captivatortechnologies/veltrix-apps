import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildResourceServerCreateBody,
  buildResourceServerUpdateBody,
  findResourceServerByName,
  mapToScopes,
  scopesToMap,
  snapshotResourceServer,
  type Auth0ResourceServer,
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
  name: 'Orders API',
  identifier: 'https://api.example.com/orders',
  scopes: { 'read:orders': 'Read orders', 'write:orders': 'Create and update orders' },
  signing_alg: 'RS256',
  token_lifetime: 86400,
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

test('validate rejects a name containing < or >', async () => {
  const res = await validate(ctxOf([{ ...good, name: 'Bad<API>' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_NAME'))
})

test('validate rejects a missing identifier', async () => {
  const res = await validate(ctxOf([{ ...good, identifier: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_IDENTIFIER'))
})

test('validate rejects an unknown signing algorithm', async () => {
  const res = await validate(ctxOf([{ ...good, signing_alg: 'ES256' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_SIGNING_ALG'))
})

test('validate rejects a token lifetime over the 30-day cap', async () => {
  const res = await validate(ctxOf([{ ...good, token_lifetime: 3000000 }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_TOKEN_LIFETIME'))
})

test('validate rejects a non-integer token lifetime', async () => {
  const res = await validate(ctxOf([{ ...good, token_lifetime: 'soon' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_TOKEN_LIFETIME'))
})

test('validate rejects a scope value containing whitespace', async () => {
  const res = await validate(ctxOf([{ ...good, scopes: { 'read orders': 'x' } }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_SCOPE'))
})

test('validate warns on a duplicate API name', async () => {
  const res = await validate(ctxOf([good, { ...good, identifier: 'https://api.example.com/orders-2' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate accepts a good API with the Auth0 default (empty) signing alg', async () => {
  const res = await validate(ctxOf([{ ...good, signing_alg: '' }]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

// --- _shared helpers --------------------------------------------------------

test('buildResourceServerCreateBody includes identifier and projects scopes', () => {
  const body = buildResourceServerCreateBody(good)
  assert.equal(body.name, 'Orders API')
  assert.equal(body.identifier, 'https://api.example.com/orders')
  assert.equal(body.signing_alg, 'RS256')
  assert.equal(body.token_lifetime, 86400)
  assert.deepEqual(body.scopes, [
    { value: 'read:orders', description: 'Read orders' },
    { value: 'write:orders', description: 'Create and update orders' },
  ])
})

test('buildResourceServerUpdateBody omits identifier (immutable)', () => {
  const body = buildResourceServerUpdateBody(good) as unknown as Record<string, unknown>
  assert.equal('identifier' in body, false)
  assert.equal((body as { name?: string }).name, 'Orders API')
})

test('buildResourceServerCreateBody omits signing_alg and token_lifetime when blank', () => {
  const body = buildResourceServerCreateBody({ name: 'A', identifier: 'urn:a', signing_alg: '', token_lifetime: '' })
  assert.equal('signing_alg' in body, false)
  assert.equal('token_lifetime' in body, false)
  assert.deepEqual(body.scopes, [])
})

test('scopesToMap and mapToScopes round-trip', () => {
  const scopes: Auth0ResourceServer['scopes'] = [
    { value: 'read:x', description: 'Read X' },
    { value: 'write:x' },
  ]
  const map = scopesToMap(scopes)
  assert.deepEqual(map, { 'read:x': 'Read X', 'write:x': '' })
  assert.deepEqual(mapToScopes(map), [{ value: 'read:x', description: 'Read X' }, { value: 'write:x' }])
})

test('findResourceServerByName matches by trimmed name', () => {
  const list: Auth0ResourceServer[] = [
    { id: 'rs_1', name: 'Orders API' },
    { id: 'rs_2', name: 'Billing API' },
  ]
  assert.equal(findResourceServerByName(list, 'Billing API')?.id, 'rs_2')
  assert.equal(findResourceServerByName(list, 'Missing'), null)
})

test('snapshotResourceServer captures managed fields', () => {
  const snap = snapshotResourceServer({
    id: 'rs_1',
    name: 'Orders API',
    identifier: 'https://api.example.com/orders',
    scopes: [{ value: 'read:orders' }],
    signing_alg: 'RS256',
    token_lifetime: 3600,
  })
  assert.equal(snap.name, 'Orders API')
  assert.equal(snap.signing_alg, 'RS256')
  assert.equal(snap.token_lifetime, 3600)
  assert.deepEqual(snap.scopes, [{ value: 'read:orders' }])
})
