import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildRuleBody, findRule, normalizeEnabled, rulesFromList, type ExtractionRule } from '../_shared'
import { normalizeBaseUrl, buildAuthHeader, hasBasicAuth } from '../../../lib/sumoLogicApi'
import type { CredentialRef, PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The network handlers (deploy/rollback/drift/health) apply over the Sumo Logic
 * Management API via `fetch`, which is impractical to mock here. Tests focus on
 * the pure, network-free pieces: validate.ts, _shared.ts and the URL/auth helpers.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  name: 'Parse nginx client IP',
  scope: '_sourceCategory=prod/nginx',
  parseExpression: 'parse "[client=*]" as client_ip',
  enabled: true,
}

// --- validate ---------------------------------------------------------------

test('validate accepts a well-formed rule', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a missing scope', async () => {
  const res = await validate(ctxOf([{ ...good, scope: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_SCOPE'))
})

test('validate rejects a missing parse expression', async () => {
  const res = await validate(ctxOf([{ ...good, parseExpression: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_PARSE_EXPRESSION'))
})

test('validate warns on a duplicate rule name', async () => {
  const res = await validate(ctxOf([good, { ...good, scope: '_sourceCategory=other' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared ----------------------------------------------------------------

test('normalizeEnabled coerces booleans, strings and numbers', () => {
  assert.equal(normalizeEnabled(true), true)
  assert.equal(normalizeEnabled(false), false)
  assert.equal(normalizeEnabled('disabled'), false)
  assert.equal(normalizeEnabled('0'), false)
  assert.equal(normalizeEnabled('enabled'), true)
  assert.equal(normalizeEnabled(''), true)
})

test('buildRuleBody trims fields and omits id', () => {
  const body = buildRuleBody({ name: '  R  ', scope: ' s ', parseExpression: ' p ', enabled: 'disabled', id: 'x' })
  assert.deepEqual(body, { name: 'R', scope: 's', parseExpression: 'p', enabled: false })
})

test('rulesFromList unwraps the { data: [...] } envelope and bare arrays', () => {
  const rules: ExtractionRule[] = [{ id: '1', name: 'a', scope: 's', parseExpression: 'p', enabled: true }]
  assert.deepEqual(rulesFromList({ data: rules }), rules)
  assert.deepEqual(rulesFromList(rules), rules)
  assert.deepEqual(rulesFromList(null), [])
  assert.deepEqual(rulesFromList({}), [])
})

test('findRule matches by name case-insensitively', () => {
  const rules: ExtractionRule[] = [{ id: '9', name: 'My Rule', scope: 's', parseExpression: 'p', enabled: true }]
  assert.equal(findRule(rules, 'my rule')?.id, '9')
  assert.equal(findRule(rules, 'missing'), null)
  assert.equal(findRule(rules, ''), null)
})

// --- lib/sumoLogicApi -------------------------------------------------------

test('normalizeBaseUrl appends /api/v1 to a bare deployment host', () => {
  assert.equal(normalizeBaseUrl('api.us2.sumologic.com'), 'https://api.us2.sumologic.com/api/v1')
  assert.equal(normalizeBaseUrl('https://api.sumologic.com'), 'https://api.sumologic.com/api/v1')
  assert.equal(normalizeBaseUrl('https://api.eu.sumologic.com/'), 'https://api.eu.sumologic.com/api/v1')
})

test('normalizeBaseUrl leaves an explicit /api/v1 base untouched', () => {
  assert.equal(normalizeBaseUrl('https://api.au.sumologic.com/api/v1'), 'https://api.au.sumologic.com/api/v1')
  assert.equal(normalizeBaseUrl('https://api.au.sumologic.com/api/v1/'), 'https://api.au.sumologic.com/api/v1')
})

test('normalizeBaseUrl returns empty for empty input', () => {
  assert.equal(normalizeBaseUrl(''), '')
  assert.equal(normalizeBaseUrl('   '), '')
})

test('buildAuthHeader builds Basic auth from Access ID + Access Key', () => {
  const cred = { username: 'accessId', apiToken: 'accessKey' } as unknown as CredentialRef
  const expected = `Basic ${Buffer.from('accessId:accessKey').toString('base64')}`
  assert.equal(buildAuthHeader(cred).Authorization, expected)
})

test('buildAuthHeader returns empty when a half is missing', () => {
  assert.deepEqual(buildAuthHeader({ username: 'id', apiToken: '' } as unknown as CredentialRef), {})
  assert.deepEqual(buildAuthHeader({ username: '', apiToken: 'key' } as unknown as CredentialRef), {})
})

test('hasBasicAuth requires both halves', () => {
  assert.equal(hasBasicAuth({ username: 'id', apiToken: 'key' } as unknown as CredentialRef), true)
  assert.equal(hasBasicAuth({ username: 'id', apiToken: null } as unknown as CredentialRef), false)
  assert.equal(hasBasicAuth(null), false)
})
