import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  contentSha256,
  fusionErrorMessage,
  fusionPaths,
  hasTraversalSegment,
  isWritablePath,
  normalizeEtag,
  normalizePath,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift handlers apply over the Recorded Future Fusion Files
 * API via fetch, which is impractical to mock here. Tests focus on validate.ts
 * and the pure _shared helpers (path/content rules, ETag comparison, path
 * encoding) — all network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.path ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { path: '/home/acme-corp/watchlists/vendor-risk.csv', content: 'domain,risk\nevil.example.com,90\n', comment: 'vendor feed' }

// --- validate -----------------------------------------------------------------

test('validate accepts a well-formed Fusion File', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing path', async () => {
  const res = await validate(ctxOf([{ ...good, path: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_PATH'))
})

test('validate rejects a path outside /home/', async () => {
  const res = await validate(ctxOf([{ ...good, path: '/public/risklists/mine.csv' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'READ_ONLY_PATH'))
})

test('validate rejects a path traversal segment', async () => {
  const res = await validate(ctxOf([{ ...good, path: '/home/acme-corp/../etc/passwd' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'PATH_TRAVERSAL'))
})

test('validate rejects content over the size cap', async () => {
  const res = await validate(ctxOf([{ ...good, content: 'x'.repeat(200_001) }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'CONTENT_TOO_LARGE'))
})

test('validate warns on empty content', async () => {
  const res = await validate(ctxOf([{ ...good, content: '' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'EMPTY_CONTENT'))
})

test('validate warns on a duplicate path', async () => {
  const res = await validate(ctxOf([good, { ...good, comment: 'copy' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_PATH'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- path / content helpers -----------------------------------------------------

test('normalizePath trims whitespace', () => {
  assert.equal(normalizePath('  /home/acme/file.csv  '), '/home/acme/file.csv')
  assert.equal(normalizePath(null), '')
})

test('isWritablePath accepts only /home/ paths', () => {
  assert.equal(isWritablePath('/home/acme/file.csv'), true)
  assert.equal(isWritablePath('/public/risklists/default_ip_risklist.csv'), false)
})

test('hasTraversalSegment flags a ".." segment', () => {
  assert.equal(hasTraversalSegment('/home/acme/../file.csv'), true)
  assert.equal(hasTraversalSegment('/home/acme/file.csv'), false)
})

test('contentSha256 is deterministic and matches a known digest', () => {
  assert.equal(contentSha256(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  assert.equal(contentSha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
})

test('normalizeEtag strips weak-validator prefix and quotes, lowercasing', () => {
  assert.equal(normalizeEtag('"ABC123"'), 'abc123')
  assert.equal(normalizeEtag('W/"abc123"'), 'abc123')
  assert.equal(normalizeEtag(null), '')
})

test('fusionPaths.file percent-encodes the full path (including slashes)', () => {
  assert.equal(fusionPaths.file('/home/acme/file.csv'), '/fusion/v3/files/%2Fhome%2Facme%2Ffile.csv')
})

test('fusionErrorMessage parses a {message} or {error} body, else falls back', () => {
  assert.equal(fusionErrorMessage(400, JSON.stringify({ message: 'bad rule' })), 'bad rule')
  assert.equal(fusionErrorMessage(400, JSON.stringify({ error: 'compile_failed' })), 'compile_failed')
  assert.equal(fusionErrorMessage(404, ''), 'HTTP 404')
})
