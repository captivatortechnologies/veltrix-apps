import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  actionTypesOf,
  buildActions,
  buildPolicyBody,
  findPolicyByName,
  normalizeEnabled,
  normalizeSeverity,
  ruleNamesOf,
  splitList,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'
import type { SysdigPolicy } from '../../../lib/sysdigApi'

/**
 * The deploy/rollback/drift handlers call the Sysdig Secure REST API via fetch,
 * which is impractical to mock here. Tests focus on validate.ts and the pure
 * mapping helpers in _shared.ts, which are network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  name: 'Suspicious runtime activity',
  description: 'Stops containers on high-severity detections',
  enabled: true,
  severity: 4,
  ruleNames: 'Unexpected outbound connection, Terminal shell in container',
  actions: ['stop'],
  scope: 'container.image.repository = myrepo/app',
}

// --- validate ---------------------------------------------------------------

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a policy with no referenced rules', async () => {
  const res = await validate(ctxOf([{ ...good, ruleNames: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_RULE_NAMES'))
})

test('validate rejects an out-of-range severity', async () => {
  const res = await validate(ctxOf([{ ...good, severity: 9 }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_SEVERITY'))
})

test('validate accepts a named severity (normalized)', async () => {
  const res = await validate(ctxOf([{ ...good, severity: 'critical' }]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects an unknown response action', async () => {
  const res = await validate(ctxOf([{ ...good, actions: ['nuke'] }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ACTION'))
})

test('validate accepts a notify-only policy (no actions)', async () => {
  const res = await validate(ctxOf([{ ...good, actions: [] }]))
  assert.equal(res.valid, true)
})

test('validate warns on a duplicate policy name', async () => {
  const res = await validate(ctxOf([good, { ...good, severity: 2 }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared helpers --------------------------------------------------------

test('normalizeEnabled defaults to enabled and reads disabled/false/0', () => {
  assert.equal(normalizeEnabled(undefined), true)
  assert.equal(normalizeEnabled('disabled'), false)
  assert.equal(normalizeEnabled('0'), false)
})

test('normalizeSeverity maps names, numbers and numeric strings to 0-7', () => {
  assert.equal(normalizeSeverity('EMERGENCY'), 0)
  assert.equal(normalizeSeverity('warning'), 4)
  assert.equal(normalizeSeverity(2), 2)
  assert.equal(normalizeSeverity('7'), 7)
  assert.equal(normalizeSeverity('nonsense'), 4)
})

test('splitList handles arrays and comma/newline strings', () => {
  assert.deepEqual(splitList(['a', ' b ', '']), ['a', 'b'])
  assert.deepEqual(splitList('a, b\nc'), ['a', 'b', 'c'])
  assert.deepEqual(splitList(undefined), [])
})

test('buildActions maps known keys and drops unknown ones', () => {
  assert.deepEqual(buildActions(['stop', 'kill']), [
    { type: 'POLICY_ACTION_STOP' },
    { type: 'POLICY_ACTION_KILL' },
  ])
  assert.deepEqual(buildActions(['bogus']), [])
})

test('buildPolicyBody maps canvas fields to the Sysdig policy shape', () => {
  const policy = buildPolicyBody(good)
  assert.equal(policy.name, good.name)
  assert.equal(policy.enabled, true)
  assert.equal(policy.severity, 4)
  assert.equal(policy.type, 'falco')
  assert.deepEqual(policy.ruleNames, ['Unexpected outbound connection', 'Terminal shell in container'])
  assert.deepEqual(policy.actions, [{ type: 'POLICY_ACTION_STOP' }])
  assert.equal(policy.scope, good.scope)
})

test('buildPolicyBody omits an empty scope', () => {
  const policy = buildPolicyBody({ ...good, scope: '   ' })
  assert.equal(policy.scope, undefined)
})

test('findPolicyByName matches by exact name', () => {
  const policies: SysdigPolicy[] = [
    { name: 'A' },
    { name: 'Suspicious runtime activity', id: 7 },
  ]
  assert.equal(findPolicyByName(policies, 'Suspicious runtime activity')?.id, 7)
  assert.equal(findPolicyByName(policies, 'missing'), null)
  assert.equal(findPolicyByName(policies, ''), null)
})

test('ruleNamesOf and actionTypesOf sort for stable comparison', () => {
  const policy: SysdigPolicy = {
    name: 'p',
    ruleNames: ['b', 'a'],
    actions: [{ type: 'POLICY_ACTION_STOP' }, { type: 'POLICY_ACTION_KILL' }],
  }
  assert.deepEqual(ruleNamesOf(policy), ['a', 'b'])
  assert.deepEqual(actionTypesOf(policy), ['POLICY_ACTION_KILL', 'POLICY_ACTION_STOP'])
})
