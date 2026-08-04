import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { specFromItem, diffIdSets, resolveNamesToIds } from '../_shared'
import type { PipelineContext, CanvasItemSnapshot } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift/health handlers apply over the Wazuh REST API via
 * node:https inside wazuhApi, which is impractical to mock here. Tests focus on
 * validate.ts and the pure _shared helpers, which are network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.username ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { username: 'soc_svc_account', password: 'Sup3r$ecret!', allow_run_as: false, roles: ['soc_analyst'] }

test('validate rejects an empty canvas', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate rejects a username under the minimum length', async () => {
  const res = await validate(ctxOf([{ ...good, username: 'abc' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_NAME'))
})

test('validate rejects an unsafe username', async () => {
  const res = await validate(ctxOf([{ ...good, username: 'bad user!' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_NAME'))
})

test('validate accepts a well-formed user', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate warns (but passes) on a blank password', async () => {
  const res = await validate(ctxOf([{ ...good, password: '' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'NO_PASSWORD'))
})

test('validate flags a duplicate username as a warning, not an error', async () => {
  const res = await validate(ctxOf([good, good]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('specFromItem reads the checkbox and tag list, keeps password out of logs-friendly shape', () => {
  const item = { id: 'i0', name: 'x', fields: good } as CanvasItemSnapshot
  const spec = specFromItem(item)
  assert.equal(spec.allowRunAs, false)
  assert.deepEqual(spec.roleNames, ['soc_analyst'])
  assert.equal(spec.password, 'Sup3r$ecret!')
})

test('diffIdSets computes exactly what to add/remove', () => {
  assert.deepEqual(diffIdSets([1, 2], [2, 3]), { toAdd: [3], toRemove: [1] })
})

test('resolveNamesToIds throws listing every unknown role name', () => {
  const byName = new Map([['soc_analyst', 5]])
  assert.deepEqual(resolveNamesToIds(['soc_analyst'], byName, 'Role'), [5])
  assert.throws(() => resolveNamesToIds(['soc_analyst', 'ghost'], byName, 'Role'), /ghost/)
})
