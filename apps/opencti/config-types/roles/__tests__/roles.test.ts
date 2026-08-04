import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildRoleInput, buildRolePatch, findRole, rolesFromList } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift handlers apply over the OpenCTI GraphQL API via
 * node:https inside openctiApi, which is impractical to mock here. Tests focus on
 * validate.ts (pure, network-free) and the pure _shared helpers.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { name: 'Administrator', description: 'Full platform access' }

test('validate rejects a missing role name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate warns on a duplicate role name', async () => {
  const res = await validate(ctxOf([good, { ...good, description: 'dup' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate accepts a good role and a name-only role', async () => {
  const full = await validate(ctxOf([good]))
  assert.equal(full.valid, true)
  assert.equal(full.errors.length, 0)

  const bare = await validate(ctxOf([{ name: 'Analyst' }]))
  assert.equal(bare.valid, true)
  assert.equal(bare.errors.length, 0)
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('buildRoleInput keeps name and omits a blank description', () => {
  const input = buildRoleInput({ name: 'Administrator', description: '' })
  assert.deepEqual(input, { name: 'Administrator' })

  const full = buildRoleInput(good)
  assert.equal(full.description, 'Full platform access')
})

test('buildRolePatch patches description and never patches the identity', () => {
  const patch = buildRolePatch(good)
  assert.ok(patch.every((p) => p.key !== 'name'))
  const description = patch.find((p) => p.key === 'description')
  assert.deepEqual(description?.value, ['Full platform access'])
})

test('rolesFromList unwraps the edges/node connection', () => {
  const list = rolesFromList({
    roles: { edges: [{ node: { id: '1', name: 'Administrator' } }, { node: { id: '2', name: 'Analyst' } }] },
  })
  assert.equal(list.length, 2)
  assert.equal(findRole(list, 'administrator')?.id, '1')
})
