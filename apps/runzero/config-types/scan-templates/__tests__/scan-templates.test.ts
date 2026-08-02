import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildTemplateOptions,
  buildTemplateUpdate,
  readKeyValueMap,
  findTemplate,
  orgIdFrom,
  paramsEqual,
  type RunzeroScanTemplate,
} from '../_shared'
import { coerceList } from '../../../lib/runzeroApi'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * deploy/rollback/drift/health hit the runZero console API via fetch, which is impractical to
 * mock here. Tests focus on validate.ts and the network-free _shared helpers.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { name: 'Fast TCP', description: 'Quick sweep', params: [{ key: 'tcp-ports', value: '1-1000' }] }

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

test('validate accepts a valid template', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate warns on a duplicate name', async () => {
  const res = await validate(ctxOf([good, { ...good, description: 'copy' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate warns when params rows carry no key', async () => {
  const res = await validate(ctxOf([{ name: 'T', params: [{ key: '', value: 'x' }] }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'EMPTY_PARAM_KEY'))
})

// --- _shared helpers ------------------------------------------------------

test('readKeyValueMap handles row arrays, object maps and key=value strings', () => {
  assert.deepEqual(readKeyValueMap([{ key: 'a', value: '1' }, { key: 'b', value: '2' }]), { a: '1', b: '2' })
  assert.deepEqual(readKeyValueMap({ a: '1', b: 2 }), { a: '1', b: '2' })
  assert.deepEqual(readKeyValueMap('a=1\nb=2'), { a: '1', b: '2' })
  assert.deepEqual(readKeyValueMap(''), {})
})

test('buildTemplateOptions maps fields and falls back to the resolved org id', () => {
  const opts = buildTemplateOptions({ name: ' Fast ', description: 'd', params: [{ key: 'rate', value: '10000' }] }, 'org-1')
  assert.equal(opts.name, 'Fast')
  assert.equal(opts.organization_id, 'org-1')
  assert.equal(opts.global, false)
  assert.deepEqual(opts.acl, {})
  assert.deepEqual(opts.params, { rate: '10000' })
})

test('buildTemplateOptions honors an explicit organization id', () => {
  const opts = buildTemplateOptions({ name: 'Fast', organizationId: 'org-explicit' }, 'org-resolved')
  assert.equal(opts.organization_id, 'org-explicit')
})

test('buildTemplateUpdate layers declared fields over the prior object, preserving id', () => {
  const prior: RunzeroScanTemplate = { id: 'tpl-1', name: 'Fast', client_id: 'acct-1', acl: { u: 'user' }, params: { old: 'v' } }
  const upd = buildTemplateUpdate(prior, { name: 'Fast', global: true, params: [{ key: 'rate', value: '5000' }] }, 'org-1')
  assert.equal(upd.id, 'tpl-1')
  assert.equal(upd.client_id, 'acct-1')
  assert.equal(upd.global, true)
  assert.deepEqual(upd.acl, { u: 'user' })
  assert.deepEqual(upd.params, { rate: '5000' })
})

test('findTemplate matches by name case-insensitively', () => {
  const templates = [{ id: '1', name: 'Fast TCP' }, { id: '2', name: 'Deep' }]
  assert.equal(findTemplate(templates, 'fast tcp')?.id, '1')
  assert.equal(findTemplate(templates, 'DEEP')?.id, '2')
  assert.equal(findTemplate(templates, 'nope'), null)
})

test('orgIdFrom reads the id off a GET /org response', () => {
  assert.equal(orgIdFrom({ id: 'org-9', name: 'Acme' }), 'org-9')
  assert.equal(orgIdFrom(null), '')
})

test('paramsEqual is a set-based map comparison', () => {
  assert.equal(paramsEqual({ a: '1', b: '2' }, { b: '2', a: '1' }), true)
  assert.equal(paramsEqual({ a: '1' }, { a: '2' }), false)
  assert.equal(paramsEqual({ a: '1' }, { a: '1', b: '2' }), false)
})

test('coerceList accepts a bare array and a { data } envelope', () => {
  assert.equal(coerceList([{ id: '1' }]).length, 1)
  assert.equal(coerceList({ data: [{ id: '1' }, { id: '2' }] }).length, 2)
  assert.equal(coerceList(null).length, 0)
})
