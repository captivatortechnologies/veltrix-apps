import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildHashException, groupHashExceptions, endpointForListType, isSha256, normalizeHash } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * deploy/rollback/drift apply over (or explicitly opt out of) the Cortex XDR REST
 * API, which is impractical to mock here. Tests focus on validate.ts and the pure
 * _shared helpers (hash validation + API grouping) — both network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.hash ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
const SHA2 = 'a94a8fe5ccb19ba61c4c0873d391e987982fbbd3b8ff2b64a3d90b8f0c1d2e3f'
const good = { hash: SHA, list_type: 'blocklist', comment: 'known bad' }

// --- validate -----------------------------------------------------------------

test('validate accepts a well-formed hash exception', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing hash', async () => {
  const res = await validate(ctxOf([{ ...good, hash: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_HASH'))
})

test('validate rejects a non-SHA256 hash', async () => {
  const res = await validate(ctxOf([{ ...good, hash: 'deadbeef' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_HASH'))
})

test('validate rejects an unknown list type', async () => {
  const res = await validate(ctxOf([{ ...good, list_type: 'greylist' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_LIST_TYPE'))
})

test('validate accepts the allowlist list type', async () => {
  const res = await validate(ctxOf([{ ...good, list_type: 'allowlist' }]))
  assert.equal(res.valid, true)
})

test('validate warns on a duplicate hash', async () => {
  const res = await validate(ctxOf([good, { ...good, comment: 'copy' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_HASH'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared helpers ----------------------------------------------------------

test('isSha256 accepts 64 hex chars and rejects others', () => {
  assert.equal(isSha256(SHA), true)
  assert.equal(isSha256('deadbeef'), false)
  assert.equal(isSha256(SHA.toUpperCase()), true)
})

test('normalizeHash trims + lowercases', () => {
  assert.equal(normalizeHash(`  ${SHA.toUpperCase()}  `), SHA)
})

test('buildHashException omits an empty comment', () => {
  const exc = buildHashException({ hash: SHA, list_type: 'allowlist' })
  assert.equal(exc.hash, SHA)
  assert.equal(exc.list_type, 'allowlist')
  assert.equal('comment' in exc, false)
})

test('groupHashExceptions batches by list type + comment', () => {
  const groups = groupHashExceptions([
    { hash: SHA, list_type: 'blocklist', comment: 'x' },
    { hash: SHA2, list_type: 'blocklist', comment: 'x' },
    { hash: SHA2, list_type: 'allowlist', comment: 'y' },
  ])
  assert.equal(groups.length, 2)
  const block = groups.find((g) => g.listType === 'blocklist')
  assert.deepEqual(block?.hashes.sort(), [SHA, SHA2].sort())
  assert.equal(block?.comment, 'x')
})

test('groupHashExceptions drops invalid list types and de-dupes hashes', () => {
  const groups = groupHashExceptions([
    { hash: SHA, list_type: 'blocklist', comment: '' },
    { hash: SHA, list_type: 'blocklist', comment: '' },
    { hash: SHA2, list_type: 'greylist', comment: '' },
  ])
  assert.equal(groups.length, 1)
  assert.equal(groups[0].hashes.length, 1)
})

test('endpointForListType maps to the two endpoints', () => {
  assert.match(endpointForListType('blocklist'), /blocklist/)
  assert.match(endpointForListType('allowlist'), /allowlist/)
})
