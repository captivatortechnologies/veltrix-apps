import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildAddBody, entriesFromList, findEntry, normalizeBool } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift handlers apply over the Darktrace REST API via
 * node:https inside darktraceApi, which is impractical to mock here (the signer
 * itself is unit-tested in lib/__tests__). These tests cover validate.ts and the
 * pure _shared helpers, which are network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.entry ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { entry: 'evil.example.com', source: 'Veltrix-Managed', description: 'Known C2', expiry: '', hostname: false, iagn: false }

test('validate accepts a good domain entry', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate accepts an IPv4 and an IPv6 entry', async () => {
  const res = await validate(ctxOf([{ ...good, entry: '198.51.100.9' }, { ...good, entry: '2001:db8::1' }]))
  assert.equal(res.valid, true, JSON.stringify(res.errors))
})

test('validate rejects a missing entry', async () => {
  const res = await validate(ctxOf([{ ...good, entry: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_ENTRY'))
})

test('validate rejects an entry with a scheme or path', async () => {
  const withScheme = await validate(ctxOf([{ ...good, entry: 'https://evil.com' }]))
  assert.ok(withScheme.errors.some((e) => e.code === 'INVALID_ENTRY'))
  const withPath = await validate(ctxOf([{ ...good, entry: 'evil.com/bad' }]))
  assert.ok(withPath.errors.some((e) => e.code === 'INVALID_ENTRY'))
})

test('validate rejects a missing source', async () => {
  const res = await validate(ctxOf([{ ...good, source: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_SOURCE'))
})

test('validate rejects an over-long description', async () => {
  const res = await validate(ctxOf([{ ...good, description: 'x'.repeat(257) }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'DESCRIPTION_TOO_LONG'))
})

test('validate warns on a duplicate entry+source pair', async () => {
  const res = await validate(ctxOf([good, { ...good, description: 'dup' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_ENTRY'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('buildAddBody includes only non-empty fields and coerces flags', () => {
  assert.deepEqual(buildAddBody({ entry: 'evil.com', source: 'Src', description: '', expiry: '', hostname: true, iagn: 'true' }), {
    addentry: 'evil.com',
    source: 'Src',
    hostname: true,
    iagn: true,
  })
})

test('buildAddBody carries description and expiry when present', () => {
  assert.deepEqual(buildAddBody({ entry: 'evil.com', source: 'Src', description: 'C2', expiry: '1 week' }), {
    addentry: 'evil.com',
    source: 'Src',
    description: 'C2',
    expiry: '1 week',
  })
})

test('entriesFromList normalizes both bare-string and object rows', () => {
  const rows = entriesFromList(['evil.com', { name: 'bad.net', source: 'Src' }])
  assert.equal(rows.length, 2)
  assert.equal(rows[0].name, 'evil.com')
  assert.equal(rows[1].source, 'Src')
})

test('findEntry matches case-insensitively', () => {
  const rows = entriesFromList([{ name: 'Evil.COM' }])
  assert.ok(findEntry(rows, 'evil.com'))
  assert.equal(findEntry(rows, 'good.com'), null)
})

test('normalizeBool coerces common truthy strings', () => {
  assert.equal(normalizeBool(true), true)
  assert.equal(normalizeBool('true'), true)
  assert.equal(normalizeBool('1'), true)
  assert.equal(normalizeBool('no'), false)
  assert.equal(normalizeBool(undefined), false)
})
