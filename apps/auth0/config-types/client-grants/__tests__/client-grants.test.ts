import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildClientGrantCreateBody,
  buildClientGrantUpdateBody,
  findClientGrant,
  grantKey,
  snapshotClientGrant,
  type Auth0ClientGrant,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift/health handlers apply over the Auth0 Management API
 * via lib/auth0Api (global fetch), which is impractical to mock here. Tests focus
 * on validate.ts and the pure _shared helpers, which are network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.client_id ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  client_id: 'abc123',
  audience: 'https://api.example.com',
  scope: 'read:orders\nwrite:orders',
  organization_usage: 'deny',
  allow_any_organization: false,
}

// --- validate ---------------------------------------------------------------

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate rejects a missing client_id', async () => {
  const res = await validate(ctxOf([{ ...good, client_id: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_CLIENT_ID'))
})

test('validate rejects a missing audience', async () => {
  const res = await validate(ctxOf([{ ...good, audience: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_AUDIENCE'))
})

test('validate rejects an unknown organization_usage', async () => {
  const res = await validate(ctxOf([{ ...good, organization_usage: 'sometimes' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ORGANIZATION_USAGE'))
})

test('validate accepts a blank organization_usage (defers to Auth0 default)', async () => {
  const res = await validate(ctxOf([{ ...good, organization_usage: '' }]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a scope token containing whitespace', async () => {
  const res = await validate(ctxOf([{ ...good, scope: 'read orders' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_SCOPE'))
})

test('validate warns on a duplicate (client_id, audience) pair', async () => {
  const res = await validate(ctxOf([good, { ...good, scope: 'read:orders' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_GRANT'))
})

test('validate does not warn when audience differs for the same client_id', async () => {
  const res = await validate(ctxOf([good, { ...good, audience: 'https://api2.example.com' }]))
  assert.equal(res.warnings.some((w) => w.code === 'DUPLICATE_GRANT'), false)
})

// --- _shared helpers --------------------------------------------------------

test('buildClientGrantCreateBody includes client_id, audience, scope, organization fields', () => {
  const body = buildClientGrantCreateBody(good)
  assert.equal(body.client_id, 'abc123')
  assert.equal(body.audience, 'https://api.example.com')
  assert.deepEqual(body.scope, ['read:orders', 'write:orders'])
  assert.equal(body.organization_usage, 'deny')
  assert.equal(body.allow_any_organization, false)
})

test('buildClientGrantCreateBody omits organization_usage when blank', () => {
  const body = buildClientGrantCreateBody({ client_id: 'x', audience: 'y', organization_usage: '' })
  assert.equal('organization_usage' in body, false)
})

test('buildClientGrantUpdateBody omits client_id and audience (immutable)', () => {
  const body = buildClientGrantUpdateBody(good) as Record<string, unknown>
  assert.equal('client_id' in body, false)
  assert.equal('audience' in body, false)
  assert.deepEqual((body as { scope?: string[] }).scope, ['read:orders', 'write:orders'])
})

test('grantKey is order-sensitive on the pair but trims whitespace', () => {
  assert.equal(grantKey('abc', 'https://api.example.com'), grantKey(' abc ', ' https://api.example.com '))
  assert.notEqual(grantKey('abc', 'aud1'), grantKey('aud1', 'abc'))
})

test('findClientGrant matches by the (client_id, audience) pair', () => {
  const list: Auth0ClientGrant[] = [
    { id: 'cgr_1', client_id: 'abc123', audience: 'https://api.example.com' },
    { id: 'cgr_2', client_id: 'abc123', audience: 'https://api2.example.com' },
  ]
  assert.equal(findClientGrant(list, 'abc123', 'https://api2.example.com')?.id, 'cgr_2')
  assert.equal(findClientGrant(list, 'abc123', 'https://missing.example.com'), null)
  assert.equal(findClientGrant(list, '', ''), null)
})

test('snapshotClientGrant captures scope, organization_usage and allow_any_organization for restore', () => {
  const snap = snapshotClientGrant({
    id: 'cgr_1',
    client_id: 'abc123',
    audience: 'https://api.example.com',
    scope: ['read:orders'],
    organization_usage: 'allow',
    allow_any_organization: true,
  })
  assert.deepEqual(snap.scope, ['read:orders'])
  assert.equal(snap.organization_usage, 'allow')
  assert.equal(snap.allow_any_organization, true)
})

test('snapshotClientGrant defaults missing fields safely', () => {
  const snap = snapshotClientGrant({ id: 'cgr_1', client_id: 'abc123', audience: 'https://api.example.com' })
  assert.deepEqual(snap.scope, [])
  assert.equal(snap.allow_any_organization, false)
  assert.equal('organization_usage' in snap, false)
})
