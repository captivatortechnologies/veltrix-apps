import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  extractUserGroupSpecs,
  buildUserGroupBody,
  findUserGroupByName,
  normalizeMembershipMethod,
  priorFieldsOf,
  type JumpCloudUserGroup,
} from '../_shared'
import type { CanvasSnapshot, PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/health/drift handlers talk to the JumpCloud API via fetch,
 * which is impractical to mock here. Tests focus on validate.ts and the pure
 * _shared helpers (network-free).
 */
function canvasOf(list: Array<Record<string, unknown>>): CanvasSnapshot {
  const items = list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
  return { items, sections: items } as unknown as CanvasSnapshot
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: canvasOf(list) } as unknown as PipelineContext
}

const good = { name: 'Engineering', description: 'All engineers', email: 'eng@example.com', membershipMethod: 'STATIC' }

// --- validate -----------------------------------------------------------------

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects an invalid email', async () => {
  const res = await validate(ctxOf([{ ...good, email: 'not-an-email' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_EMAIL'))
})

test('validate accepts a missing (optional) email and description', async () => {
  const res = await validate(ctxOf([{ name: 'Ops', membershipMethod: 'STATIC' }]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate errors on a duplicate name', async () => {
  const res = await validate(ctxOf([good, { ...good, description: 'copy' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'DUPLICATE_NAME'))
})

test('validate warns on DYNAMIC_AUTOMATED (needs a member query)', async () => {
  const res = await validate(ctxOf([{ ...good, membershipMethod: 'DYNAMIC_AUTOMATED' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DYNAMIC_NEEDS_QUERY'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared helpers ----------------------------------------------------------

test('normalizeMembershipMethod coerces unknown values to STATIC', () => {
  assert.equal(normalizeMembershipMethod('dynamic_automated'), 'DYNAMIC_AUTOMATED')
  assert.equal(normalizeMembershipMethod('STATIC'), 'STATIC')
  assert.equal(normalizeMembershipMethod('bogus'), 'STATIC')
  assert.equal(normalizeMembershipMethod(undefined), 'STATIC')
})

test('extractUserGroupSpecs trims fields and defaults the method', () => {
  const [spec] = extractUserGroupSpecs(canvasOf([{ name: '  Sales  ', description: ' team ', email: '', membershipMethod: 'weird' }]))
  assert.equal(spec.name, 'Sales')
  assert.equal(spec.description, 'team')
  assert.equal(spec.email, '')
  assert.equal(spec.membershipMethod, 'STATIC')
  assert.equal(spec.itemId, 'i0')
})

test('buildUserGroupBody omits an empty email but always sends description + method', () => {
  const body = buildUserGroupBody({ name: 'X', description: '', email: '', membershipMethod: 'STATIC' })
  assert.deepEqual(body, { name: 'X', description: '', membershipMethod: 'STATIC' })
  assert.equal('email' in body, false)

  const withEmail = buildUserGroupBody({ name: 'Y', description: 'd', email: 'y@example.com', membershipMethod: 'DYNAMIC_AUTOMATED' })
  assert.equal(withEmail.email, 'y@example.com')
  assert.equal(withEmail.membershipMethod, 'DYNAMIC_AUTOMATED')
})

test('findUserGroupByName matches case-insensitively', () => {
  const groups: JumpCloudUserGroup[] = [{ id: 'a', name: 'Engineering' }, { id: 'b', name: 'Ops' }]
  assert.equal(findUserGroupByName(groups, 'engineering')?.id, 'a')
  assert.equal(findUserGroupByName(groups, 'MISSING'), null)
})

test('priorFieldsOf captures the managed subset for rollback', () => {
  const prior = priorFieldsOf({ id: 'a', name: 'Eng', description: 'd', email: 'e@x.io', membershipMethod: 'STATIC', type: 'user_group' })
  assert.deepEqual(prior, { name: 'Eng', description: 'd', membershipMethod: 'STATIC', email: 'e@x.io' })
})
