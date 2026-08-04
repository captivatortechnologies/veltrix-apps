import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildPolicyBody, findPolicySummaryByName, isMalformedJsonArray, parseRequirementGroups, parseTargets } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'
import type { SysdigPosturePolicySummary } from '../../../lib/sysdigApi'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const groups = JSON.stringify([
  { name: 'Security', description: 'x', requirements: [{ name: 'Enforce access control', description: 'x', controls: [{ name: 'Create Pods', enabled: false }] }] },
])
const good = { name: 'CIS K8s Baseline', description: 'Internal baseline', type: 'kubernetes', enabled: true, requirementGroupsJson: groups }

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects an unknown type', async () => {
  const res = await validate(ctxOf([{ ...good, type: 'openstack' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_TYPE'))
})

test('validate rejects malformed requirementGroupsJson', async () => {
  const res = await validate(ctxOf([{ ...good, requirementGroupsJson: 'nope' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_GROUPS_JSON'))
})

test('validate rejects an empty requirement-groups array', async () => {
  const res = await validate(ctxOf([{ ...good, requirementGroupsJson: '[]' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_GROUPS'))
})

test('validate rejects a control missing a name', async () => {
  const bad = JSON.stringify([{ name: 'Security', requirements: [{ name: 'Req', controls: [{ enabled: true }] }] }])
  const res = await validate(ctxOf([{ ...good, requirementGroupsJson: bad }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_CONTROL_NAME'))
})

test('validate accepts a good posture policy', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('parseRequirementGroups builds the nested tree with enabled defaulting true', () => {
  const parsed = parseRequirementGroups(groups)
  assert.equal(parsed[0].name, 'Security')
  assert.equal(parsed[0].requirements?.[0].controls?.[0].enabled, false)
})

test('isMalformedJsonArray only flags real parse/shape failures', () => {
  assert.equal(isMalformedJsonArray(undefined), false)
  assert.equal(isMalformedJsonArray('[]'), false)
  assert.equal(isMalformedJsonArray('{}'), true)
  assert.equal(isMalformedJsonArray('nope'), true)
})

test('parseTargets parses version constraints', () => {
  assert.deepEqual(parseTargets('[{"platform":"EKS","minVersion":1.24,"maxVersion":1.28}]'), [{ platform: 'EKS', minVersion: 1.24, maxVersion: 1.28 }])
})

test('buildPolicyBody maps fields and includes id only when given', () => {
  const created = buildPolicyBody(good)
  assert.equal(created.id, undefined)
  assert.equal(created.name, good.name)
  assert.equal(created.groups?.length, 1)

  const updated = buildPolicyBody(good, 'p_1')
  assert.equal(updated.id, 'p_1')
})

test('findPolicySummaryByName matches by exact name', () => {
  const summaries: SysdigPosturePolicySummary[] = [{ id: '1', name: 'A' }, { id: '2', name: 'CIS K8s Baseline' }]
  assert.equal(findPolicySummaryByName(summaries, 'CIS K8s Baseline')?.id, '2')
  assert.equal(findPolicySummaryByName(summaries, 'missing'), null)
})
