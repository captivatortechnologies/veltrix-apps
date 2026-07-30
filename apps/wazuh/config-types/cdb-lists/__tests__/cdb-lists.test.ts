import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { parseEntries, deriveFilename, isSafeRelativePath, serializeEntries } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift/health handlers apply over the Wazuh REST API via
 * node:https inside wazuhApi, which is impractical to mock here. Tests focus on
 * validate.ts and the pure _shared parsing helpers, which are network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.listName ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { listName: 'blocklist', path: 'etc/lists/blocklist', entries: '10.0.0.5:malicious\n10.0.0.6:c2' }

test('validate rejects an unsafe list name', async () => {
  const res = await validate(ctxOf([{ ...good, listName: 'bad name/../x' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_NAME'))
})

test('validate rejects an unsafe path (traversal)', async () => {
  const res = await validate(ctxOf([{ ...good, path: 'etc/lists/../../etc/passwd' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_PATH'))
})

test('validate rejects an absolute path', async () => {
  const res = await validate(ctxOf([{ ...good, path: '/etc/lists/blocklist' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_PATH'))
})

test('validate rejects malformed entries (line without a colon)', async () => {
  const res = await validate(ctxOf([{ ...good, entries: '10.0.0.5:malicious\nnot-a-pair' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ENTRIES'))
})

test('validate accepts a good list, including empty values (bare key:)', async () => {
  const res = await validate(ctxOf([{ ...good, entries: 'baduser:\nanother.user:' }]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate warns (but passes) when a list has no entries', async () => {
  const res = await validate(ctxOf([{ ...good, entries: '' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'EMPTY_ENTRIES'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('parseEntries splits key:value, keeps colons in the value, skips blanks', () => {
  const { entries, invalidLines } = parseEntries('a:1\n\n b : http://x:80 \nbad')
  assert.deepEqual(invalidLines, [4])
  assert.deepEqual(entries, [
    { key: 'a', value: '1' },
    { key: 'b', value: 'http://x:80' },
  ])
})

test('serializeEntries round-trips to the canonical body', () => {
  assert.equal(serializeEntries([{ key: 'a', value: '1' }, { key: 'b', value: '' }]), 'a:1\nb:\n')
  assert.equal(serializeEntries([]), '')
})

test('deriveFilename strips the etc/lists/ prefix, falls back to listName', () => {
  assert.equal(deriveFilename('etc/lists/blocklist', 'blocklist'), 'blocklist')
  assert.equal(deriveFilename('', 'allowlist'), 'allowlist')
  assert.equal(deriveFilename('etc/lists/sub/list', 'x'), 'sub/list')
})

test('isSafeRelativePath rejects roots and traversal', () => {
  assert.equal(isSafeRelativePath('etc/lists/blocklist'), true)
  assert.equal(isSafeRelativePath('/etc/lists/blocklist'), false)
  assert.equal(isSafeRelativePath('etc/../secret'), false)
  assert.equal(isSafeRelativePath(''), false)
})
