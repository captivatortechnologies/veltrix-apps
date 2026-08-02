import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildSiteOptions, parseScopeEntries, scopeEquals, findSite, sitesFromList, normalizeScope } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift/health handlers hit the runZero console API via fetch,
 * which is impractical to mock here. Tests focus on validate.ts and the pure
 * _shared helpers, which are network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { name: 'HQ', description: 'Head office', subnets: '10.0.0.0/24\n192.168.1.0/24' }

// --- validate -------------------------------------------------------------

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate accepts a valid site', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate accepts a site with no scope (optional)', async () => {
  const res = await validate(ctxOf([{ name: 'DMZ', description: '', subnets: '' }]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate warns on a duplicate name', async () => {
  const res = await validate(ctxOf([good, { ...good, description: 'copy' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate warns on a suspect scope entry but stays valid', async () => {
  const res = await validate(ctxOf([{ ...good, subnets: '10.0.0.0/24\nnot a subnet!' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'SUSPECT_SCOPE'))
})

// --- _shared helpers ------------------------------------------------------

test('parseScopeEntries splits on newlines, commas and whitespace and drops blanks', () => {
  assert.deepEqual(parseScopeEntries('10.0.0.0/24, 192.168.1.1\n\n  172.16.0.0/16 '), [
    '10.0.0.0/24',
    '192.168.1.1',
    '172.16.0.0/16',
  ])
  assert.deepEqual(parseScopeEntries(''), [])
  assert.deepEqual(parseScopeEntries(null), [])
})

test('scopeEquals is order-insensitive and set-based', () => {
  assert.equal(scopeEquals('10.0.0.0/24\n192.168.1.0/24', '192.168.1.0/24, 10.0.0.0/24'), true)
  assert.equal(scopeEquals('10.0.0.0/24', '10.0.0.0/24\n10.0.1.0/24'), false)
  assert.equal(scopeEquals('', ''), true)
})

test('normalizeScope emits one entry per line', () => {
  assert.equal(normalizeScope('10.0.0.0/24, 192.168.1.1'), '10.0.0.0/24\n192.168.1.1')
})

test('buildSiteOptions maps the subnets textarea onto the API scope field', () => {
  const opts = buildSiteOptions({ name: '  HQ  ', description: '  main  ', subnets: '10.0.0.0/24, 10.0.1.0/24' })
  assert.deepEqual(opts, { name: 'HQ', description: 'main', scope: '10.0.0.0/24\n10.0.1.0/24' })
})

test('sitesFromList accepts a bare array and a { data } envelope', () => {
  assert.equal(sitesFromList([{ id: '1', name: 'a' }]).length, 1)
  assert.equal(sitesFromList({ data: [{ id: '1', name: 'a' }, { id: '2', name: 'b' }] }).length, 2)
  assert.equal(sitesFromList(null).length, 0)
})

test('findSite matches by name case-insensitively', () => {
  const sites = [{ id: '1', name: 'HQ' }, { id: '2', name: 'Branch' }]
  assert.equal(findSite(sites, 'hq')?.id, '1')
  assert.equal(findSite(sites, 'BRANCH')?.id, '2')
  assert.equal(findSite(sites, 'nope'), null)
})
