import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { SOURCE, buildEntityBody } from '../_shared'
import {
  CRIBL_ID_RE,
  resolveWorkerGroup,
  itemsFromList,
  findById,
  canonicalJson,
  pickKeys,
  parseJsonObject,
} from '../../../lib/criblCommon'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift handlers apply over the Cribl REST API via node:https
 * (impractical to mock here), so tests focus on validate.ts and the pure
 * lib/criblCommon + lib/criblSystemEntities helpers that back Sources.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.id ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>, settings: Record<string, unknown> = {}): PipelineContext {
  return { canvas: { items: toItems(list) }, settings } as unknown as PipelineContext
}

const good = { id: 'in_http', type: 'http', worker_group: 'default', conf: '{ "port": 10080 }' }

// --- validate ---------------------------------------------------------------

test('validate rejects a missing id', async () => {
  const res = await validate(ctxOf([{ ...good, id: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_ID'))
})

test('validate rejects an id with illegal characters', async () => {
  const res = await validate(ctxOf([{ ...good, id: 'bad id!' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ID'))
})

test('validate rejects a missing type', async () => {
  const res = await validate(ctxOf([{ ...good, type: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_TYPE'))
})

test('validate rejects conf that is not valid JSON', async () => {
  const res = await validate(ctxOf([{ ...good, conf: '{ not json ' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_CONF'))
})

test('validate rejects conf that is a JSON array (not an object)', async () => {
  const res = await validate(ctxOf([{ ...good, conf: '[1,2,3]' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_CONF'))
})

test('validate warns on a duplicate id within the same worker group', async () => {
  const res = await validate(ctxOf([good, { ...good }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_ID'))
})

test('validate does NOT flag the same id in different worker groups', async () => {
  const res = await validate(ctxOf([good, { ...good, worker_group: 'prod' }]))
  assert.equal(res.valid, true)
  assert.equal(res.warnings.length, 0)
})

test('validate accepts a good source', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- descriptor + body ------------------------------------------------------

test('SOURCE targets the system/inputs collection', () => {
  assert.equal(SOURCE.resource, 'system/inputs')
  assert.equal(SOURCE.kind, 'source')
})

test('buildEntityBody flattens conf onto id + type', () => {
  const body = buildEntityBody('in_http', 'http', { port: 10080, disabled: false })
  assert.deepEqual(body, { id: 'in_http', type: 'http', port: 10080, disabled: false })
})

// --- shared helpers ---------------------------------------------------------

test('parseJsonObject accepts an object and rejects arrays / primitives / empty', () => {
  assert.equal(parseJsonObject('{ "a": 1 }').error, null)
  assert.ok(parseJsonObject('[1,2]').error)
  assert.ok(parseJsonObject('42').error)
  assert.ok(parseJsonObject('   ').error)
})

test('resolveWorkerGroup prefers field, then setting, then default', () => {
  assert.equal(resolveWorkerGroup({ worker_group: 'prod' }, { default_worker_group: 'default' }), 'prod')
  assert.equal(resolveWorkerGroup({}, { default_worker_group: 'staging' }), 'staging')
  assert.equal(resolveWorkerGroup({}, { default_worker_group: '' }), '')
  assert.equal(resolveWorkerGroup({}, {}), 'default')
})

test('itemsFromList unwraps the items envelope and bare arrays', () => {
  assert.equal(itemsFromList({ items: [{ id: 'a' }, { id: 'b' }], count: 2 }).length, 2)
  assert.equal(itemsFromList([{ id: 'a' }]).length, 1)
  assert.equal(itemsFromList(null).length, 0)
})

test('findById matches by id', () => {
  const rows = [{ id: 'a' }, { id: 'b' }]
  assert.equal(findById(rows, 'b')?.id, 'b')
  assert.equal(findById(rows, 'missing'), null)
})

test('pickKeys keeps only the requested keys (subset drift)', () => {
  assert.deepEqual(pickKeys({ a: 1, b: 2, c: 3 }, ['a', 'c']), { a: 1, c: 3 })
  assert.deepEqual(pickKeys({ a: 1 }, ['missing']), {})
})

test('canonicalJson is key-order independent', () => {
  assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }))
})

test('CRIBL_ID_RE accepts valid ids and rejects spaces', () => {
  assert.ok(CRIBL_ID_RE.test('in_splunk_hec-1'))
  assert.ok(!CRIBL_ID_RE.test('in http'))
})
