import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildExceptionBody,
  buildExceptionDeleteBody,
  findObject,
  objectsFromResponse,
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
  value: 'safe.example.com',
  description: 'internal marketing domain',
}

// --- validate -----------------------------------------------------------------

test('validate accepts a well-formed exception object', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects an unknown type', async () => {
  const res = await validate(ctxOf([{ ...good, type: 'fileMd5' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_TYPE'))
})

test('validate accepts fileSha256 (exceptions support the full type set)', async () => {
  const res = await validate(ctxOf([{ type: 'fileSha256', value: 'a'.repeat(64) }]))
  assert.equal(res.valid, true)
})

test('validate rejects a missing value', async () => {
  const res = await validate(ctxOf([{ ...good, value: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_VALUE'))
})

test('validate rejects a non-http(s) URL value', async () => {
  const res = await validate(ctxOf([{ type: 'url', value: 'ftp://x.example.com' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_VALUE'))
})

test('validate rejects a malformed file SHA-1', async () => {
  const res = await validate(ctxOf([{ type: 'fileSha1', value: 'not-a-hash' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_VALUE'))
})

test('validate rejects a malformed file SHA-256', async () => {
  const res = await validate(ctxOf([{ type: 'fileSha256', value: 'abc123' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_VALUE'))
})

test('validate rejects a malformed sender mail address', async () => {
  const res = await validate(ctxOf([{ type: 'senderMailAddress', value: 'not-an-email' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_VALUE'))
})

test('validate rejects an over-length description', async () => {
  const res = await validate(ctxOf([{ ...good, description: 'x'.repeat(501) }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'DESCRIPTION_TOO_LONG'))
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

test('buildExceptionBody keys the value under the type and omits an empty description', () => {
  const obj = buildExceptionBody({ type: 'ip', value: '1.2.3.4' })
  assert.ok(obj)
  assert.equal(obj?.ip, '1.2.3.4')
  assert.equal('description' in (obj as object), false)
})

test('buildExceptionBody includes a non-empty description', () => {
  const obj = buildExceptionBody({ ...good })
  assert.equal(obj?.domain, 'safe.example.com')
  assert.equal(obj?.description, 'internal marketing domain')
})

test('buildExceptionBody returns null for an unknown type or blank value', () => {
  assert.equal(buildExceptionBody({ type: 'fileMd5', value: 'x' }), null)
  assert.equal(buildExceptionBody({ type: 'domain', value: '' }), null)
})

test('buildExceptionDeleteBody keys the value under the type', () => {
  assert.deepEqual(buildExceptionDeleteBody('url', 'https://x.example.com'), { url: 'https://x.example.com' })
  assert.equal(buildExceptionDeleteBody('fileMd5', 'x'), null)
})

test('valueOf reads the identifier from any type-keyed object', () => {
  assert.equal(valueOf({ domain: 'safe.example.com' }), 'safe.example.com')
  assert.equal(valueOf({ fileSha256: 'a'.repeat(64) }), 'a'.repeat(64))
  assert.equal(valueOf({}), '')
})

test('findObject matches case-insensitively on the value', () => {
  const live = [{ domain: 'SAFE.EXAMPLE.COM', description: 'ok' }]
  const match = findObject(live, 'safe.example.com')
  assert.ok(match)
  assert.equal(match?.description, 'ok')
})

test('objectsFromResponse unwraps both the items and bare-array shapes', () => {
  assert.equal(objectsFromResponse({ items: [{ domain: 'a' }, { ip: 'b' }] }).length, 2)
  assert.equal(objectsFromResponse([{ url: 'c' }]).length, 1)
  assert.equal(objectsFromResponse(null).length, 0)
})
