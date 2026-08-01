import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildListBody, findListByName, itemsOf, normalizeEnabled, splitItems } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'
import type { SysdigList } from '../../../lib/sysdigApi'

/**
 * The deploy/rollback/drift handlers call the Sysdig Secure REST API via fetch,
 * which is impractical to mock here. Tests focus on validate.ts and the pure
 * mapping helpers in _shared.ts, which are network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  name: 'authorized_server_binaries',
  items: 'nginx, node, java',
  enabled: true,
}

// --- validate ---------------------------------------------------------------

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a list with no items', async () => {
  const res = await validate(ctxOf([{ ...good, items: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_ITEMS'))
})

test('validate accepts a good list', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate warns on a duplicate list name', async () => {
  const res = await validate(ctxOf([good, { ...good, items: 'ncat' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared helpers --------------------------------------------------------

test('normalizeEnabled defaults to enabled and reads disabled/false/0', () => {
  assert.equal(normalizeEnabled(undefined), true)
  assert.equal(normalizeEnabled('disabled'), false)
  assert.equal(normalizeEnabled('0'), false)
})

test('splitItems handles arrays and comma/newline strings', () => {
  assert.deepEqual(splitItems(['a', ' b ', '']), ['a', 'b'])
  assert.deepEqual(splitItems('a, b\nc'), ['a', 'b', 'c'])
  assert.deepEqual(splitItems(undefined), [])
})

test('buildListBody maps canvas fields to the Sysdig list shape', () => {
  const list = buildListBody(good)
  assert.equal(list.name, good.name)
  assert.deepEqual(list.items, { items: ['nginx', 'node', 'java'] })
  assert.equal(list.append, false)
})

test('findListByName matches by exact name', () => {
  const lists: SysdigList[] = [
    { name: 'A', items: { items: [] } },
    { name: 'authorized_server_binaries', id: 3, items: { items: ['nginx'] } },
  ]
  assert.equal(findListByName(lists, 'authorized_server_binaries')?.id, 3)
  assert.equal(findListByName(lists, 'missing'), null)
  assert.equal(findListByName(lists, ''), null)
})

test('itemsOf sorts a live list for stable comparison', () => {
  const list: SysdigList = { name: 'x', items: { items: ['c', 'a', 'b'] } }
  assert.deepEqual(itemsOf(list), ['a', 'b', 'c'])
  assert.deepEqual(itemsOf(null), [])
})
