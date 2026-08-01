import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { extractSiteSpecs } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift handlers apply over the Umbrella Deployments API,
 * which is impractical to mock here. Tests focus on the pure, network-free
 * pieces: validate.ts and the _shared parsing helpers.
 */
function ctxWith(list: Array<{ id?: string; name?: string; fields: Record<string, unknown> }>): PipelineContext {
  const items = list.map((row, i) => ({ id: row.id ?? `i${i}`, name: row.name ?? String(i), fields: row.fields }))
  return { canvas: { items } } as unknown as PipelineContext
}

test('validate accepts a valid site', () => {
  const res = validate(ctxWith([{ fields: { name: 'London HQ' } }]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate errors when there are no items', () => {
  const res = validate(ctxWith([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate requires a name', () => {
  const res = validate(ctxWith([{ name: '', fields: { name: '' } }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'required'))
})

test('validate rejects a too-long name', () => {
  const res = validate(ctxWith([{ fields: { name: 'x'.repeat(51) } }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'too_long'))
})

test('validate rejects duplicate names', () => {
  const res = validate(ctxWith([{ fields: { name: 'Site A' } }, { fields: { name: 'site a' } }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'duplicate_name'))
})

test('extractSiteSpecs trims the name and falls back to the item name', () => {
  const specs = extractSiteSpecs({
    items: [
      { id: 'i1', name: 'Fallback', fields: { name: '  Paris  ' } },
      { id: 'i2', name: 'FromItem', fields: {} },
    ],
  } as unknown as PipelineContext['canvas'])
  assert.equal(specs[0].name, 'Paris')
  assert.equal(specs[1].name, 'FromItem')
})
