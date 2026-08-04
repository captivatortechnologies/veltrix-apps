import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildCustomDomainCreateBody,
  buildCustomDomainUpdateBody,
  findCustomDomainByDomain,
  looksLikeHostname,
  snapshotCustomDomain,
  type Auth0CustomDomain,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift/health handlers apply over the Auth0 Management API
 * via lib/auth0Api (global fetch), which is impractical to mock here. Tests focus
 * on validate.ts and the pure _shared helpers, which are network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.domain ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  domain: 'login.example.com',
  type: 'auth0_managed_certs',
  tls_policy: 'recommended',
  custom_client_ip_header: 'cf-connecting-ip',
  domain_metadata: 'team=identity',
}

// --- validate ---------------------------------------------------------------

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate rejects a missing domain', async () => {
  const res = await validate(ctxOf([{ ...good, domain: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_DOMAIN'))
})

test('validate rejects a domain with a scheme', async () => {
  const res = await validate(ctxOf([{ ...good, domain: 'https://login.example.com' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_DOMAIN'))
})

test('validate rejects a domain with a path', async () => {
  const res = await validate(ctxOf([{ ...good, domain: 'example.com/login' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_DOMAIN'))
})

test('validate rejects a domain with no dot', async () => {
  const res = await validate(ctxOf([{ ...good, domain: 'localhost' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_DOMAIN'))
})

test('validate rejects an unknown type', async () => {
  const res = await validate(ctxOf([{ ...good, type: 'wildcard' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_TYPE'))
})

test('validate rejects an unknown tls_policy', async () => {
  const res = await validate(ctxOf([{ ...good, tls_policy: 'strict' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_TLS_POLICY'))
})

test('validate accepts a blank tls_policy', async () => {
  const res = await validate(ctxOf([{ ...good, tls_policy: '' }]))
  assert.equal(res.valid, true)
})

test('validate warns on a duplicate domain', async () => {
  const res = await validate(ctxOf([good, { ...good, tls_policy: 'compatible' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_DOMAIN'))
})

// --- _shared helpers --------------------------------------------------------

test('looksLikeHostname accepts a bare hostname and rejects scheme/path/no-dot', () => {
  assert.equal(looksLikeHostname('login.example.com'), true)
  assert.equal(looksLikeHostname('https://login.example.com'), false)
  assert.equal(looksLikeHostname('example.com/path'), false)
  assert.equal(looksLikeHostname('localhost'), false)
  assert.equal(looksLikeHostname(''), false)
})

test('buildCustomDomainCreateBody includes domain, type, tls_policy, ip header, metadata', () => {
  const body = buildCustomDomainCreateBody(good)
  assert.equal(body.domain, 'login.example.com')
  assert.equal(body.type, 'auth0_managed_certs')
  assert.equal(body.tls_policy, 'recommended')
  assert.equal(body.custom_client_ip_header, 'cf-connecting-ip')
  assert.deepEqual(body.domain_metadata, { team: 'identity' })
})

test('buildCustomDomainUpdateBody omits domain and type (immutable)', () => {
  const body = buildCustomDomainUpdateBody(good) as Record<string, unknown>
  assert.equal('domain' in body, false)
  assert.equal('type' in body, false)
  assert.equal((body as { tls_policy?: string }).tls_policy, 'recommended')
})

test('buildCustomDomainCreateBody omits empty optional fields', () => {
  const body = buildCustomDomainCreateBody({ domain: 'x.example.com', type: 'auth0_managed_certs' })
  assert.equal('tls_policy' in body, false)
  assert.equal('custom_client_ip_header' in body, false)
  assert.equal('domain_metadata' in body, false)
})

test('findCustomDomainByDomain matches by trimmed domain', () => {
  const list: Auth0CustomDomain[] = [
    { id: 'cd_1', domain: 'login.example.com' },
    { id: 'cd_2', domain: 'auth.example.com' },
  ]
  assert.equal(findCustomDomainByDomain(list, 'auth.example.com')?.id, 'cd_2')
  assert.equal(findCustomDomainByDomain(list, 'missing.example.com'), null)
  assert.equal(findCustomDomainByDomain(list, ''), null)
})

test('snapshotCustomDomain captures tls_policy, ip header and metadata for restore', () => {
  const snap = snapshotCustomDomain({
    id: 'cd_1',
    domain: 'login.example.com',
    type: 'auth0_managed_certs',
    tls_policy: 'compatible',
    custom_client_ip_header: 'true-client-ip',
    domain_metadata: { team: 'identity' },
  })
  assert.equal(snap.tls_policy, 'compatible')
  assert.equal(snap.custom_client_ip_header, 'true-client-ip')
  assert.deepEqual(snap.domain_metadata, { team: 'identity' })
})

test('snapshotCustomDomain defaults missing fields safely', () => {
  const snap = snapshotCustomDomain({ id: 'cd_1', domain: 'login.example.com', type: 'auth0_managed_certs' })
  assert.equal(snap.custom_client_ip_header, '')
  assert.deepEqual(snap.domain_metadata, {})
  assert.equal('tls_policy' in snap, false)
})
