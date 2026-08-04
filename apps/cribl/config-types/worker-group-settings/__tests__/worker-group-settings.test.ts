import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { parseSettings, deepPick } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.worker_group ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) }, settings: {} } as unknown as PipelineContext
}

const good = { worker_group: 'default', settings: '{ "security": { "cspEnabled": true } }' }

test('validate rejects settings that are not valid JSON', async () => {
  const res = await validate(ctxOf([{ ...good, settings: '{ not json' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_SETTINGS'))
})

test('validate rejects settings that are not an object', async () => {
  const res = await validate(ctxOf([{ ...good, settings: '[1,2]' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_SETTINGS'))
})

test('validate rejects a malformed worker group', async () => {
  const res = await validate(ctxOf([{ ...good, worker_group: 'bad group!' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_GROUP'))
})

test('validate warns on a duplicate group', async () => {
  const res = await validate(ctxOf([good, { ...good }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_ID'))
})

test('validate accepts a good settings entry', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('parseSettings accepts an object and rejects arrays / non-JSON / empty', () => {
  assert.equal(parseSettings('{ "a": 1 }').error, null)
  assert.ok(parseSettings('[1]').error)
  assert.ok(parseSettings('nope').error)
  assert.ok(parseSettings('  ').error)
})

test('deepPick projects only the declared paths, ignoring undeclared siblings', () => {
  const live = {
    tls: { minVersion: 'TLSv1.2', maxVersion: 'TLSv1.3', rejectUnauthorized: true, defaultCipherList: 'DEFAULT' },
    api: { port: 9000 },
  }
  const declared = { tls: { minVersion: 'TLSv1.2' } }
  assert.deepEqual(deepPick(live, declared), { tls: { minVersion: 'TLSv1.2' } })
})

test('deepPick surfaces a real difference at the declared path', () => {
  const live = { tls: { minVersion: 'TLSv1.0' } }
  const declared = { tls: { minVersion: 'TLSv1.2' } }
  assert.notDeepEqual(deepPick(live, declared), declared)
})
