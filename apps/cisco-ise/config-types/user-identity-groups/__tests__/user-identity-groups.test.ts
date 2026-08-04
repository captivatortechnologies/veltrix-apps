import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { specFromItem, extractSpecs, toIdentityGroupBody, MAX_NAME_LENGTH } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { name: 'Contractors' }

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate rejects a name over the ERS length limit', async () => {
  const res = await validate(ctxOf([{ name: 'a'.repeat(MAX_NAME_LENGTH + 1) }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'NAME_TOO_LONG'))
})

test('validate rejects a group that names itself as parent', async () => {
  const res = await validate(ctxOf([{ name: 'Contractors', parent: 'Contractors' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'SELF_PARENT'))
})

test('validate warns when the parent is not declared in this configuration', async () => {
  const res = await validate(ctxOf([{ name: 'Contractors', parent: 'Employees' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'PARENT_NOT_IN_CONFIG'))
})

test('validate does not warn when the parent is declared earlier in this configuration', async () => {
  const res = await validate(ctxOf([{ name: 'Employees' }, { name: 'Contractors', parent: 'Employees' }]))
  assert.equal(res.valid, true)
  assert.ok(!res.warnings.some((w) => w.code === 'PARENT_NOT_IN_CONFIG'))
})

test('validate warns on a duplicate name', async () => {
  const res = await validate(ctxOf([good, { ...good, description: 'copy' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate accepts a well-formed group with no parent', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('specFromItem trims name, description and parent', () => {
  const spec = specFromItem({ id: 'i0', name: 'x', fields: { name: '  Contractors  ', parent: '  Employees  ' } })
  assert.equal(spec.name, 'Contractors')
  assert.equal(spec.parentName, 'Employees')
})

test('extractSpecs maps every item', () => {
  const specs = extractSpecs(toItems([good]))
  assert.equal(specs.length, 1)
  assert.equal(specs[0].name, 'Contractors')
})

test('toIdentityGroupBody omits parent when unresolved/absent', () => {
  const spec = specFromItem({ id: 'i0', name: 'x', fields: good })
  const body = toIdentityGroupBody(spec, null)
  assert.equal(body.parent, undefined)
})

test('toIdentityGroupBody includes the resolved parent id', () => {
  const spec = specFromItem({ id: 'i0', name: 'x', fields: { name: 'Contractors', parent: 'Employees' } })
  const body = toIdentityGroupBody(spec, 'parent-id-123')
  assert.equal(body.parent, 'parent-id-123')
})
