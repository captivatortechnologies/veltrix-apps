import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  parseConf,
  resolveWorkerGroup,
  findPipeline,
  pipelinesFromList,
  canonicalJson,
  PIPELINE_ID_RE,
} from '../_shared'
import { groupResourcePath, apiRoot } from '../../../lib/criblApi'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift handlers apply over the Cribl REST API via node:https
 * inside criblApi, which is impractical to mock here. Tests focus on validate.ts
 * and the pure _shared / criblApi helpers.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.id ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { id: 'my_pipeline', worker_group: 'default', conf: '{ "functions": [] }' }

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

test('validate rejects conf that is not valid JSON', async () => {
  const res = await validate(ctxOf([{ ...good, conf: '{ not json ' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_CONF'))
})

test('validate rejects conf with no functions array', async () => {
  const res = await validate(ctxOf([{ ...good, conf: '{ "asyncFuncTimeout": 1000 }' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_CONF'))
})

test('validate warns on an empty Function chain', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'EMPTY_FUNCTIONS'))
})

test('validate warns on a duplicate pipeline id', async () => {
  const res = await validate(ctxOf([good, { ...good }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_ID'))
})

test('validate accepts a good pipeline with a Function', async () => {
  const conf = '{ "functions": [ { "id": "eval", "conf": { "add": [] } } ] }'
  const res = await validate(ctxOf([{ ...good, conf }]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
  assert.equal(res.warnings.length, 0)
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- parseConf --------------------------------------------------------------

test('parseConf accepts a full conf object', () => {
  const { conf, error } = parseConf('{ "functions": [ { "id": "eval" } ], "asyncFuncTimeout": 500 }')
  assert.equal(error, null)
  assert.equal(conf?.functions.length, 1)
  assert.equal(conf?.asyncFuncTimeout, 500)
})

test('parseConf wraps a bare functions array', () => {
  const { conf, error } = parseConf('[ { "id": "drop" } ]')
  assert.equal(error, null)
  assert.equal(conf?.functions.length, 1)
})

test('parseConf rejects invalid JSON', () => {
  assert.ok(parseConf('nope').error)
})

test('parseConf rejects an object without functions', () => {
  assert.ok(parseConf('{ "foo": 1 }').error)
})

test('parseConf rejects empty input', () => {
  assert.ok(parseConf('   ').error)
})

// --- resolveWorkerGroup -----------------------------------------------------

test('resolveWorkerGroup prefers the item field', () => {
  assert.equal(resolveWorkerGroup({ worker_group: 'prod' }, { default_worker_group: 'default' }), 'prod')
})

test('resolveWorkerGroup falls back to the setting', () => {
  assert.equal(resolveWorkerGroup({}, { default_worker_group: 'staging' }), 'staging')
})

test('resolveWorkerGroup honours a blank setting (single-instance)', () => {
  assert.equal(resolveWorkerGroup({}, { default_worker_group: '' }), '')
})

test('resolveWorkerGroup defaults to "default" with no field or setting', () => {
  assert.equal(resolveWorkerGroup({}, {}), 'default')
})

// --- list helpers -----------------------------------------------------------

test('pipelinesFromList unwraps the items envelope', () => {
  const rows = pipelinesFromList({ items: [{ id: 'a' }, { id: 'b' }], count: 2 })
  assert.equal(rows.length, 2)
})

test('pipelinesFromList accepts a bare array', () => {
  assert.equal(pipelinesFromList([{ id: 'a' }]).length, 1)
})

test('findPipeline matches by id', () => {
  const rows = [{ id: 'a' }, { id: 'b' }]
  assert.equal(findPipeline(rows, 'b')?.id, 'b')
  assert.equal(findPipeline(rows, 'missing'), null)
})

// --- path builder + canonical json ------------------------------------------

test('groupResourcePath scopes to a worker group', () => {
  assert.equal(groupResourcePath('https://h:9000', 'default', 'pipelines'), 'https://h:9000/api/v1/m/default/pipelines')
})

test('groupResourcePath omits /m for a single-instance deployment', () => {
  assert.equal(groupResourcePath('https://h:9000', '', 'pipelines'), 'https://h:9000/api/v1/pipelines')
})

test('apiRoot appends /api/v1', () => {
  assert.equal(apiRoot('https://h:9000/'), 'https://h:9000/api/v1')
})

test('canonicalJson is key-order independent', () => {
  assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }))
})

test('PIPELINE_ID_RE accepts valid ids and rejects spaces', () => {
  assert.ok(PIPELINE_ID_RE.test('my-pipeline_1'))
  assert.ok(!PIPELINE_ID_RE.test('my pipeline'))
})
