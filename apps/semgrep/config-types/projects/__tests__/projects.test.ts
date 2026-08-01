import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { diffTags, projectSpecFromFields, strList, tagsEqual } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift handlers apply over the Semgrep REST API via fetch,
 * which is impractical to mock here. Tests focus on validate.ts and the pure
 * _shared helpers (spec building + tag diffing) — all network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.projectName ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  projectName: 'my-org/my-repo',
  primaryBranch: 'refs/heads/main',
  manageTags: true,
  tags: ['team-payments', 'external'],
}

// --- validate -----------------------------------------------------------------

test('validate accepts a well-formed project', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing project name', async () => {
  const res = await validate(ctxOf([{ ...good, projectName: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_PROJECT_NAME'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate rejects a duplicate project name (case-insensitive)', async () => {
  const res = await validate(ctxOf([good, { ...good, projectName: 'My-Org/My-Repo' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'DUPLICATE_PROJECT'))
})

test('validate rejects a primary branch containing whitespace', async () => {
  const res = await validate(ctxOf([{ ...good, primaryBranch: 'refs/heads/my branch' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_PRIMARY_BRANCH'))
})

test('validate rejects a tag containing a comma', async () => {
  const res = await validate(ctxOf([{ ...good, tags: ['a,b'] }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_TAG'))
})

test('validate allows a blank primary branch and empty tags', async () => {
  const res = await validate(ctxOf([{ projectName: 'org/repo', primaryBranch: '', manageTags: true, tags: [] }]))
  assert.equal(res.valid, true)
})

test('validate warns when tags are listed but tag management is off', async () => {
  const res = await validate(ctxOf([{ ...good, manageTags: false }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'TAGS_UNMANAGED'))
})

// --- _shared helpers ----------------------------------------------------------

test('strList reads arrays, comma strings, and dedupes case-insensitively', () => {
  assert.deepEqual(strList(['a', 'b', 'A', ' ']), ['a', 'b'])
  assert.deepEqual(strList('x, y ,x'), ['x', 'y'])
  assert.deepEqual(strList(undefined), [])
})

test('projectSpecFromFields defaults manageTags to true and trims values', () => {
  const spec = projectSpecFromFields({ projectName: '  org/repo  ', primaryBranch: '  refs/heads/dev ' })
  assert.equal(spec.projectName, 'org/repo')
  assert.equal(spec.primaryBranch, 'refs/heads/dev')
  assert.equal(spec.manageTags, true)
  assert.deepEqual(spec.tags, [])
})

test('projectSpecFromFields honors an explicit manageTags:false', () => {
  const spec = projectSpecFromFields({ projectName: 'org/repo', manageTags: false, tags: ['a'] })
  assert.equal(spec.manageTags, false)
})

test('diffTags computes add/remove ignoring case', () => {
  const { toAdd, toRemove } = diffTags(['keep', 'add'], ['KEEP', 'drop'])
  assert.deepEqual(toAdd, ['add'])
  assert.deepEqual(toRemove, ['drop'])
})

test('tagsEqual is order- and case-insensitive', () => {
  assert.equal(tagsEqual(['a', 'B'], ['b', 'A']), true)
  assert.equal(tagsEqual(['a'], ['a', 'b']), false)
})
