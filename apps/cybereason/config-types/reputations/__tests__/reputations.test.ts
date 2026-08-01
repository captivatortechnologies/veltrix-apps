import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildEntry, parseReputationsCsv, isValidKey, normalizeBool, indexByKey } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy / rollback / drift / health handlers apply over the Cybereason REST
 * API via node:https inside cybereasonApi, which is impractical to mock here.
 * Tests focus on validate.ts and the pure _shared helpers — network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.key ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const MD5 = 'd41d8cd98f00b204e9800998ecf8427e'
const SHA1 = 'da39a3ee5e6b4b0d3255bfef95601890afd80709'
const good = { keyType: 'file', key: MD5, reputation: 'blacklist', preventExecution: true, comment: 'known bad' }

// --- validate ---------------------------------------------------------------

test('validate accepts a good file blacklist reputation', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate accepts SHA-1, domain and ipv4 keys', async () => {
  const res = await validate(
    ctxOf([
      { keyType: 'file', key: SHA1, reputation: 'whitelist' },
      { keyType: 'domain', key: 'evil.example.com', reputation: 'blacklist' },
      { keyType: 'ipv4', key: '203.0.113.7', reputation: 'blacklist' },
    ]),
  )
  assert.equal(res.valid, true, JSON.stringify(res.errors))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate rejects a missing key', async () => {
  const res = await validate(ctxOf([{ ...good, key: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_KEY'))
})

test('validate rejects an unknown key type', async () => {
  const res = await validate(ctxOf([{ ...good, keyType: 'sha256' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_KEY_TYPE'))
})

test('validate rejects a SHA-256 hash under the file type (unsupported)', async () => {
  const res = await validate(ctxOf([{ ...good, key: 'a'.repeat(64) }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_KEY'))
})

test('validate rejects a malformed ipv4', async () => {
  const res = await validate(ctxOf([{ keyType: 'ipv4', key: '999.1.1.1', reputation: 'blacklist' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_KEY'))
})

test('validate rejects an unknown reputation', async () => {
  const res = await validate(ctxOf([{ ...good, reputation: 'graylist' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_REPUTATION'))
})

test('validate warns on a duplicate key', async () => {
  const res = await validate(ctxOf([good, { ...good, comment: 'copy' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_KEY'))
})

test('validate warns when preventExecution is set on a domain', async () => {
  const res = await validate(ctxOf([{ keyType: 'domain', key: 'evil.example.com', reputation: 'blacklist', preventExecution: true }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'PREVENT_IGNORED'))
})

// --- _shared helpers --------------------------------------------------------

test('buildEntry maps reputation to maliciousType and keeps prevent for file blacklist', () => {
  const entry = buildEntry(good, false)
  assert.deepEqual(entry.keys, [MD5])
  assert.equal(entry.maliciousType, 'blacklist')
  assert.equal(entry.prevent, true)
  assert.equal(entry.remove, false)
  assert.equal(entry.comment, 'known bad')
})

test('buildEntry forces prevent false for whitelist and for non-file types', () => {
  assert.equal(buildEntry({ ...good, reputation: 'whitelist' }, false).prevent, false)
  assert.equal(buildEntry({ keyType: 'domain', key: 'evil.example.com', reputation: 'blacklist', preventExecution: true }, false).prevent, false)
})

test('buildEntry sets remove:true when asked', () => {
  assert.equal(buildEntry(good, true).remove, true)
})

test('normalizeBool coerces common truthy strings', () => {
  assert.equal(normalizeBool('true'), true)
  assert.equal(normalizeBool('on'), true)
  assert.equal(normalizeBool('false'), false)
  assert.equal(normalizeBool(undefined), false)
})

test('isValidKey enforces per-type shapes', () => {
  assert.equal(isValidKey('file', MD5), true)
  assert.equal(isValidKey('file', SHA1), true)
  assert.equal(isValidKey('file', 'nothex'), false)
  assert.equal(isValidKey('ipv4', '10.0.0.1'), true)
  assert.equal(isValidKey('domain', 'a.b.co'), true)
})

test('parseReputationsCsv matches columns by header name and coerces prevent', () => {
  const csv = ['Key,Reputation,Prevent,Comment', `${MD5},blacklist,true,known bad`, 'evil.example.com,whitelist,false,ok'].join('\n')
  const rows = parseReputationsCsv(csv)
  assert.equal(rows.length, 2)
  const byKey = indexByKey(rows)
  const hit = byKey.get(MD5)
  assert.ok(hit)
  assert.equal(hit?.reputation, 'blacklist')
  assert.equal(hit?.prevent, true)
  assert.equal(hit?.comment, 'known bad')
})

test('parseReputationsCsv tolerates quoted commas and reordered columns', () => {
  const csv = ['maliciousType,comment,keys', `blacklist,"bad, very bad",${MD5}`].join('\n')
  const rows = parseReputationsCsv(csv)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].key, MD5)
  assert.equal(rows[0].reputation, 'blacklist')
  assert.equal(rows[0].comment, 'bad, very bad')
})

test('parseReputationsCsv returns [] for an empty or header-only file', () => {
  assert.deepEqual(parseReputationsCsv(''), [])
  assert.deepEqual(parseReputationsCsv('Key,Reputation'), [])
})
