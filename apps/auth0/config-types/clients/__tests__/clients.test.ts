import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { parseList, findClientByName, buildClientBody, sameUrlList, type Auth0Client } from '../_shared'
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
  name: 'Web App',
  app_type: 'regular_web',
  callbacks: 'https://app.example.com/callback',
  allowed_logout_urls: 'https://app.example.com/logout',
  web_origins: 'https://app.example.com',
  token_endpoint_auth_method: 'client_secret_post',
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
  const res = await validate(ctxOf([{ ...good, name: 'Bad<Name>' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_NAME'))
})

test('validate rejects an unknown application type', async () => {
  const res = await validate(ctxOf([{ ...good, app_type: 'confidential' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_APP_TYPE'))
})

test('validate rejects an unknown token endpoint auth method', async () => {
  const res = await validate(ctxOf([{ ...good, token_endpoint_auth_method: 'mtls' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_TOKEN_AUTH_METHOD'))
})

test('validate rejects a non-http(s) callback URL', async () => {
  const res = await validate(ctxOf([{ ...good, callbacks: 'ftp://example.com/cb' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_URL'))
})

test('validate warns on a duplicate application name', async () => {
  const res = await validate(ctxOf([good, { ...good, callbacks: 'https://other.example.com/cb' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate accepts a good application for each app type and an empty token method', async () => {
  for (const app_type of ['spa', 'native', 'regular_web', 'non_interactive']) {
    const res = await validate(ctxOf([{ ...good, app_type, token_endpoint_auth_method: '' }]))
    assert.equal(res.valid, true, `expected ${app_type} to be valid`)
    assert.equal(res.errors.length, 0)
  }
})

// --- _shared helpers --------------------------------------------------------

test('parseList splits newline/comma lists, trims and de-duplicates', () => {
  assert.deepEqual(parseList('https://a.com\nhttps://b.com, https://a.com'), ['https://a.com', 'https://b.com'])
  assert.deepEqual(parseList(['https://a.com', ' https://a.com ', 'https://c.com']), ['https://a.com', 'https://c.com'])
  assert.deepEqual(parseList(''), [])
  assert.deepEqual(parseList(undefined), [])
})

test('findClientByName matches by trimmed name', () => {
  const clients: Auth0Client[] = [
    { client_id: 'a1', name: 'Web App' },
    { client_id: 'b2', name: 'Mobile App' },
  ]
  assert.equal(findClientByName(clients, 'Mobile App')?.client_id, 'b2')
  assert.equal(findClientByName(clients, 'Missing'), null)
  assert.equal(findClientByName(clients, ''), null)
})

test('buildClientBody omits app_type and token method when blank, and parses URL lists', () => {
  const body = buildClientBody({
    name: 'Web App',
    app_type: '',
    token_endpoint_auth_method: '',
    callbacks: 'https://a.com/cb\nhttps://a.com/cb',
    allowed_logout_urls: 'https://a.com/out',
    web_origins: 'https://a.com',
  })
  assert.equal(body.name, 'Web App')
  assert.equal('app_type' in body, false)
  assert.equal('token_endpoint_auth_method' in body, false)
  assert.deepEqual(body.callbacks, ['https://a.com/cb'])
  assert.deepEqual(body.web_origins, ['https://a.com'])
})

test('buildClientBody includes app_type and token method when set', () => {
  const body = buildClientBody({ name: 'M2M', app_type: 'non_interactive', token_endpoint_auth_method: 'client_secret_post' })
  assert.equal(body.app_type, 'non_interactive')
  assert.equal(body.token_endpoint_auth_method, 'client_secret_post')
})

test('sameUrlList is order-insensitive and detects differences', () => {
  assert.equal(sameUrlList('https://a.com\nhttps://b.com', ['https://b.com', 'https://a.com']), true)
  assert.equal(sameUrlList('https://a.com', ['https://a.com', 'https://b.com']), false)
  assert.equal(sameUrlList('', []), true)
})
