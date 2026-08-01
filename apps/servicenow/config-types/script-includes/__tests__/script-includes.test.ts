import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { spec } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * Network handlers run through the shared table-config engine; tests focus on
 * validate.ts and the pure spec.buildBody mapping.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  name: 'IncidentUtils',
  description: 'Reusable incident helpers',
  active: true,
  clientCallable: false,
  access: 'package_private',
  script: 'var IncidentUtils = Class.create(); IncidentUtils.prototype = { type: "IncidentUtils" };',
}

test('validate accepts a well-formed script include', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a name that is not a valid identifier', async () => {
  const res = await validate(ctxOf([{ ...good, name: '2 Bad Name' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_NAME'))
})

test('validate rejects a missing script', async () => {
  const res = await validate(ctxOf([{ ...good, script: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_SCRIPT'))
})

test('validate rejects an invalid access value', async () => {
  const res = await validate(ctxOf([{ ...good, access: 'everyone' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ACCESS'))
})

test('validate accepts each valid access value', async () => {
  for (const access of ['package_private', 'public']) {
    const res = await validate(ctxOf([{ ...good, access }]))
    assert.equal(res.valid, true, `expected access ${access} to be valid`)
  }
})

test('validate warns on a public, client-callable script include', async () => {
  const res = await validate(ctxOf([{ ...good, access: 'public', clientCallable: true }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'PUBLIC_CLIENT_CALLABLE'))
})

test('validate warns on a duplicate name', async () => {
  const res = await validate(ctxOf([good, { ...good, description: 'other' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_IDENTITY'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('spec.buildBody maps canvas fields to sys_script_include columns and defaults access', () => {
  const body = spec.buildBody({ ...good, access: '' })
  assert.equal(body.name, 'IncidentUtils')
  assert.equal(body.active, true)
  assert.equal(body.client_callable, false)
  assert.equal(body.access, 'package_private')
  assert.ok(String(body.script).includes('Class.create'))
})
