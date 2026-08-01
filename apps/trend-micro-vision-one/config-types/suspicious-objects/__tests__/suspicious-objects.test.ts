import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildObjectBody,
  buildDeleteBody,
  findObject,
  objectsFromResponse,
  parseDaysToExpiration,
  valueOf,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift handlers apply over the Vision One REST API via fetch,
 * which is impractical to mock here. Tests focus on validate.ts and the pure
 * _shared helpers (identity matching + body building) — both network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.value ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  type: 'domain',
  value: 'evil.example.com',
  scanAction: 'block',
  riskLevel: 'high',
  description: 'known C2 domain',
}

// --- validate -----------------------------------------------------------------

test('validate accepts a well-formed suspicious object', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects an unknown type', async () => {
  const res = await validate(ctxOf([{ ...good, type: 'fileSha256' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_TYPE'))
})

test('validate rejects a missing value', async () => {
  const res = await validate(ctxOf([{ ...good, value: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_VALUE'))
})

test('validate rejects a non-http(s) URL value', async () => {
  const res = await validate(ctxOf([{ ...good, type: 'url', value: 'ftp://x.example.com' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_VALUE'))
})

test('validate rejects a malformed file SHA-1', async () => {
  const res = await validate(ctxOf([{ ...good, type: 'fileSha1', value: 'not-a-hash' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_VALUE'))
})

test('validate accepts a 40-char file SHA-1', async () => {
  const res = await validate(ctxOf([{ ...good, type: 'fileSha1', value: 'a'.repeat(40) }]))
  assert.equal(res.valid, true)
})

test('validate rejects a malformed sender mail address', async () => {
  const res = await validate(ctxOf([{ ...good, type: 'senderMailAddress', value: 'not-an-email' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_VALUE'))
})

test('validate rejects an unknown scan action', async () => {
  const res = await validate(ctxOf([{ ...good, scanAction: 'quarantine' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_SCAN_ACTION'))
})

test('validate rejects an unknown risk level', async () => {
  const res = await validate(ctxOf([{ ...good, riskLevel: 'critical' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_RISK_LEVEL'))
})

test('validate rejects a non-numeric daysToExpiration', async () => {
  const res = await validate(ctxOf([{ ...good, daysToExpiration: 'soon' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_EXPIRATION'))
})

test('validate accepts a positive integer daysToExpiration', async () => {
  const res = await validate(ctxOf([{ ...good, daysToExpiration: '30' }]))
  assert.equal(res.valid, true)
})

test('validate warns on a duplicate object value', async () => {
  const res = await validate(ctxOf([good, { ...good, description: 'copy' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_VALUE'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared helpers ----------------------------------------------------------

test('buildObjectBody keys the value under the type and omits empty optionals', () => {
  const obj = buildObjectBody({ type: 'ip', value: '1.2.3.4', scanAction: 'log', riskLevel: 'low' })
  assert.ok(obj)
  assert.equal(obj?.ip, '1.2.3.4')
  assert.equal(obj?.scanAction, 'log')
  assert.equal(obj?.riskLevel, 'low')
  assert.equal('description' in (obj as object), false)
  assert.equal('daysToExpiration' in (obj as object), false)
})

test('buildObjectBody includes a valid daysToExpiration', () => {
  const obj = buildObjectBody({ ...good, daysToExpiration: '90' })
  assert.equal(obj?.daysToExpiration, 90)
})

test('buildObjectBody returns null for an unknown type or blank value', () => {
  assert.equal(buildObjectBody({ type: 'fileSha256', value: 'x' }), null)
  assert.equal(buildObjectBody({ type: 'domain', value: '' }), null)
})

test('buildDeleteBody keys the value under the type', () => {
  assert.deepEqual(buildDeleteBody('url', 'https://x.example.com'), { url: 'https://x.example.com' })
  assert.equal(buildDeleteBody('fileSha256', 'x'), null)
})

test('parseDaysToExpiration rejects non-positive / non-integer values', () => {
  assert.equal(parseDaysToExpiration(''), null)
  assert.equal(parseDaysToExpiration('0'), null)
  assert.equal(parseDaysToExpiration('-5'), null)
  assert.equal(parseDaysToExpiration('abc'), null)
  assert.equal(parseDaysToExpiration('30'), 30)
})

test('valueOf reads the identifier from any type-keyed object', () => {
  assert.equal(valueOf({ domain: 'evil.example.com' }), 'evil.example.com')
  assert.equal(valueOf({ senderMailAddress: 'bad@example.com' }), 'bad@example.com')
  assert.equal(valueOf({}), '')
})

test('findObject matches case-insensitively on the value', () => {
  const live = [{ domain: 'EVIL.EXAMPLE.COM', scanAction: 'block' }]
  const match = findObject(live, 'evil.example.com')
  assert.ok(match)
  assert.equal(match?.scanAction, 'block')
})

test('objectsFromResponse unwraps both the items and bare-array shapes', () => {
  assert.equal(objectsFromResponse({ items: [{ domain: 'a' }, { ip: 'b' }] }).length, 2)
  assert.equal(objectsFromResponse([{ url: 'c' }]).length, 1)
  assert.equal(objectsFromResponse(null).length, 0)
})
