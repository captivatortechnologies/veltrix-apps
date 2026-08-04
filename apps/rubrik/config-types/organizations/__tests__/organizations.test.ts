import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildOrganizationBody,
  findOrganizationByName,
  normalizeName,
  organizationsFromList,
  type RubrikOrganization,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift/health handlers apply over the Rubrik CDM REST API via
 * node:https inside rubrikApi, which is impractical to mock here. Tests focus on
 * validate.ts and the pure _shared.ts builders, which are network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { name: 'Finance' }

// --- validate ---------------------------------------------------------------

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects duplicate names', async () => {
  const res = await validate(ctxOf([good, { ...good }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'DUPLICATE_NAME'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate accepts a well-formed organization', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

// --- normalizeName ------------------------------------------------------------

test('normalizeName trims surrounding whitespace', () => {
  assert.equal(normalizeName('  Finance  '), 'Finance')
  assert.equal(normalizeName(undefined), '')
})

// --- buildOrganizationBody ----------------------------------------------------

test('buildOrganizationBody emits only the trimmed name', () => {
  const body = buildOrganizationBody({ name: '  Finance  ' })
  assert.deepEqual(body, { name: 'Finance' })
})

// --- list parsing + identity match ---------------------------------------------

test('organizationsFromList unwraps the { data } envelope and bare arrays', () => {
  assert.equal(organizationsFromList({ data: [{ name: 'A' }], total: 1 }).length, 1)
  assert.equal(organizationsFromList([{ name: 'B' }]).length, 1)
  assert.equal(organizationsFromList(null).length, 0)
})

test('findOrganizationByName matches on the exact trimmed name', () => {
  const list: RubrikOrganization[] = [{ id: '1', name: 'Finance' }, { id: '2', name: 'EMEA' }]
  assert.equal(findOrganizationByName(list, ' Finance ')?.id, '1')
  assert.equal(findOrganizationByName(list, 'APAC'), null)
})
