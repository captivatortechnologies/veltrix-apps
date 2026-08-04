import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  extractPolicyGroupSpecs,
  toPolicyNameList,
  buildPolicyGroupBody,
  findPolicyGroupByName,
  findPolicyRefByName,
  priorFieldsOf,
  memberIdOf,
  diffMembers,
  buildMemberOp,
  type JumpCloudPolicyGroup,
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

const good = { name: 'Baseline Endpoint Policies', memberPolicies: ['Password Complexity', 'Screen Lock'] }

// --- validate -----------------------------------------------------------------

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate warns on an empty memberPolicies list', async () => {
  const res = await validate(ctxOf([{ ...good, memberPolicies: [] }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'NO_MEMBERS'))
})

test('validate errors on a duplicate name', async () => {
  const res = await validate(ctxOf([good, { ...good }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'DUPLICATE_NAME'))
})

// --- _shared helpers ----------------------------------------------------------

test('toPolicyNameList splits, trims and de-dupes case-insensitively', () => {
  assert.deepEqual(toPolicyNameList('A, B\nA'), ['A', 'B'])
})

test('extractPolicyGroupSpecs trims fields and reads memberPolicies', () => {
  const [spec] = extractPolicyGroupSpecs(canvasOf([{ name: '  G  ', memberPolicies: ['P1'] }]))
  assert.equal(spec.name, 'G')
  assert.deepEqual(spec.memberPolicies, ['P1'])
  assert.equal(spec.itemId, 'i0')
})

test('buildPolicyGroupBody sends only name', () => {
  assert.deepEqual(buildPolicyGroupBody({ name: 'G', memberPolicies: [] }), { name: 'G' })
})

test('findPolicyGroupByName and findPolicyRefByName match case-insensitively', () => {
  const groups: JumpCloudPolicyGroup[] = [{ id: 'a', name: 'Baseline' }]
  assert.equal(findPolicyGroupByName(groups, 'baseline')?.id, 'a')
  assert.equal(findPolicyRefByName([{ id: 'p1', name: 'Password Complexity' }], 'password complexity')?.id, 'p1')
})

test('priorFieldsOf captures only name for rollback', () => {
  assert.deepEqual(priorFieldsOf({ id: 'a', name: 'G', description: 'ignored' }), { name: 'G' })
})

test('memberIdOf reads the nested to.id and a flat id', () => {
  assert.equal(memberIdOf({ to: { id: 'p1' } }), 'p1')
  assert.equal(memberIdOf({ id: 'p2' }), 'p2')
})

test('diffMembers is always exclusive (adds + removes to converge)', () => {
  const { toAdd, toRemove } = diffMembers(['a', 'b'], ['b', 'c'])
  assert.deepEqual(toAdd.sort(), ['c'])
  assert.deepEqual(toRemove.sort(), ['a'])
})

test('buildMemberOp shapes the policy member op body', () => {
  assert.deepEqual(buildMemberOp('add', 'p1'), { op: 'add', type: 'policy', id: 'p1' })
})
