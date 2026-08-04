import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { PACK_ID_RE, buildPackSpec, findPack, upgradeQuery } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift handlers apply over the Cribl REST API via
 * node:https (impractical to mock here), so tests focus on validate.ts and the
 * pure _shared helpers.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.id ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) }, settings: {} } as unknown as PipelineContext
}

const good = { id: 'observability-pack', worker_group: 'default', source: 'https://github.com/org/packs/apache', spec: '^1.3.0' }

test('validate rejects a missing id', async () => {
  const res = await validate(ctxOf([{ ...good, id: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_ID'))
})

test('validate rejects an id with illegal characters', async () => {
  const res = await validate(ctxOf([{ ...good, id: 'bad id!' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID'))
})

test('validate rejects a missing source', async () => {
  const res = await validate(ctxOf([{ ...good, source: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID'))
})

test('validate accepts a good pack', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate warns on a duplicate id within the same worker group', async () => {
  const res = await validate(ctxOf([good, { ...good }]))
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_ID'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('buildPackSpec builds the install body', () => {
  const spec = buildPackSpec({ ...good, display_name: 'Apache Logs', description: 'Apache pack' })
  assert.equal(spec.error, null)
  assert.deepEqual(spec.body, {
    id: 'observability-pack',
    source: good.source,
    disabled: false,
    spec: '^1.3.0',
    displayName: 'Apache Logs',
    description: 'Apache pack',
  })
})

test('findPack matches by id', () => {
  const rows = [{ id: 'a' }, { id: 'b' }]
  assert.equal(findPack(rows, 'b')?.id, 'b')
  assert.equal(findPack(rows, 'missing'), null)
})

test('upgradeQuery builds only the provided params', () => {
  assert.equal(upgradeQuery({ source: 'https://x', spec: '1.2.3' }), '?source=https%3A%2F%2Fx&spec=1.2.3')
  assert.equal(upgradeQuery({}), '')
})

test('PACK_ID_RE accepts valid ids and rejects spaces', () => {
  assert.ok(PACK_ID_RE.test('my-pack_1'))
  assert.ok(!PACK_ID_RE.test('my pack'))
})
