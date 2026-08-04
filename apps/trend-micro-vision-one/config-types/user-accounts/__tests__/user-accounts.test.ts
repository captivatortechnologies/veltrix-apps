import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  accountIdFromResponse,
  accountsFromResponse,
  buildInviteBody,
  buildUpdateBody,
  findAccountByEmail,
  normalizeValue,
  parseAccountFields,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift handlers apply over the Vision One REST API via fetch,
 * which is impractical to mock here. Tests focus on validate.ts and the pure
 * _shared helpers (identity matching + body building) — both network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.email ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  email: 'analyst@example.com',
  role: 'SOC Analyst',
  authType: 'local',
  status: 'enabled',
  description: 'Tier-1 SOC analyst',
}

// --- validate -----------------------------------------------------------------

test('validate accepts a well-formed user account', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing email', async () => {
  const res = await validate(ctxOf([{ ...good, email: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_EMAIL'))
})

test('validate rejects a malformed email', async () => {
  const res = await validate(ctxOf([{ ...good, email: 'not-an-email' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_EMAIL'))
})

test('validate rejects a missing role', async () => {
  const res = await validate(ctxOf([{ ...good, role: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_ROLE'))
})

test('validate rejects an unknown auth type', async () => {
  const res = await validate(ctxOf([{ ...good, authType: 'oauth' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_AUTH_TYPE'))
})

test('validate rejects an unknown status', async () => {
  const res = await validate(ctxOf([{ ...good, status: 'suspended' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_STATUS'))
})

test('validate accepts a blank status (defaults to enabled at deploy time)', async () => {
  const res = await validate(ctxOf([{ ...good, status: '' }]))
  assert.equal(res.valid, true)
})

test('validate rejects an over-length description', async () => {
  const res = await validate(ctxOf([{ ...good, description: 'x'.repeat(501) }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'DESCRIPTION_TOO_LONG'))
})

test('validate warns on a duplicate email', async () => {
  const res = await validate(ctxOf([good, { ...good, description: 'copy' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_EMAIL'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared helpers ----------------------------------------------------------

test('parseAccountFields defaults a blank status to enabled', () => {
  const parsed = parseAccountFields({ ...good, status: '' })
  assert.equal(parsed?.status, 'enabled')
})

test('parseAccountFields returns null for a missing email, role or unknown auth type', () => {
  assert.equal(parseAccountFields({ ...good, email: '' }), null)
  assert.equal(parseAccountFields({ ...good, role: '' }), null)
  assert.equal(parseAccountFields({ ...good, authType: 'oauth' }), null)
})

test('buildInviteBody omits an empty description and never includes status', () => {
  const parsed = parseAccountFields({ ...good, description: '' })
  assert.ok(parsed)
  const body = buildInviteBody(parsed!)
  assert.deepEqual(body, { email: good.email, role: good.role, authType: good.authType })
})

test('buildUpdateBody never includes email or authType', () => {
  const parsed = parseAccountFields(good)
  assert.ok(parsed)
  const body = buildUpdateBody(parsed!)
  assert.deepEqual(body, { role: good.role, status: good.status, description: good.description })
})

test('accountIdFromResponse reads the id when present', () => {
  assert.equal(accountIdFromResponse({ id: 'acct-123' }), 'acct-123')
  assert.equal(accountIdFromResponse({}), null)
  assert.equal(accountIdFromResponse(null), null)
})

test('findAccountByEmail matches case-insensitively', () => {
  const live = [{ id: 'a1', email: 'Analyst@Example.com', role: 'SOC Analyst' }]
  const match = findAccountByEmail(live, 'analyst@example.com')
  assert.ok(match)
  assert.equal(match?.id, 'a1')
})

test('accountsFromResponse unwraps both the items and bare-array shapes', () => {
  assert.equal(accountsFromResponse({ items: [{ email: 'a@x.com' }, { email: 'b@x.com' }] }).length, 2)
  assert.equal(accountsFromResponse([{ email: 'c@x.com' }]).length, 1)
  assert.equal(accountsFromResponse(null).length, 0)
})

test('normalizeValue trims and lowercases', () => {
  assert.equal(normalizeValue('  Analyst@Example.com '), 'analyst@example.com')
  assert.equal(normalizeValue(undefined), '')
})
