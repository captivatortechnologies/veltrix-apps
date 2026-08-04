import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { actionKeysOf, applyTuning, buildActions, findManagedPolicy, resetTuning, splitList, splitNumericList } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'
import type { SysdigPolicy } from '../../../lib/sysdigApi'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { name: 'Sysdig Runtime Threat Detection', type: 'falco', enabled: true, actions: ['stop'], notificationChannelIds: ['12', '34'] }

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects an unknown type', async () => {
  const res = await validate(ctxOf([{ ...good, type: 'syslog' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_TYPE'))
})

test('validate rejects an unknown action', async () => {
  const res = await validate(ctxOf([{ ...good, actions: ['nuke'] }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ACTION'))
})

test('validate rejects a non-numeric notification channel id', async () => {
  const res = await validate(ctxOf([{ ...good, notificationChannelIds: ['abc'] }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_CHANNEL_ID'))
})

test('validate accepts a good managed-policy tuning', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate warns on a duplicate name+type', async () => {
  const res = await validate(ctxOf([good, good]))
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('splitList / splitNumericList', () => {
  assert.deepEqual(splitList('a, b'), ['a', 'b'])
  assert.deepEqual(splitNumericList(['1', '2', 'x']), [1, 2])
})

test('buildActions maps known keys and drops unknown ones', () => {
  assert.deepEqual(buildActions(['stop', 'nuke']), [{ type: 'POLICY_ACTION_STOP' }])
})

const livePolicy: SysdigPolicy = {
  id: 42,
  name: 'Sysdig Runtime Threat Detection',
  type: 'falco',
  isDefault: true,
  version: 3,
  enabled: false,
  ruleNames: [],
  actions: [],
  notificationChannelIds: [],
  rules: [
    { ruleName: 'Terminal shell in container', enabled: true },
    { ruleName: 'Write below /etc', enabled: true },
  ],
}

test('findManagedPolicy requires isDefault + name + type match', () => {
  assert.equal(findManagedPolicy([livePolicy], 'Sysdig Runtime Threat Detection', 'falco')?.id, 42)
  assert.equal(findManagedPolicy([livePolicy], 'Sysdig Runtime Threat Detection', 'k8s_audit'), null)
  assert.equal(findManagedPolicy([{ ...livePolicy, isDefault: false }], 'Sysdig Runtime Threat Detection', 'falco'), null)
})

test('applyTuning disables only the named rules and sets scope/actions/channels', () => {
  const tuned = applyTuning(livePolicy, { scope: 'container.id != ""', actions: ['kill'], notificationChannelIds: ['9'], disabledRuleNames: ['Write below /etc'] })
  assert.equal(tuned.enabled, true)
  assert.equal(tuned.scope, 'container.id != ""')
  assert.deepEqual(tuned.actions, [{ type: 'POLICY_ACTION_KILL' }])
  assert.deepEqual(tuned.notificationChannelIds, [9])
  assert.deepEqual(tuned.rules, [
    { ruleName: 'Terminal shell in container', enabled: true },
    { ruleName: 'Write below /etc', enabled: false },
  ])
})

test('actionKeysOf reverses the action-type map', () => {
  assert.deepEqual(actionKeysOf({ ...livePolicy, actions: [{ type: 'POLICY_ACTION_STOP' }, { type: 'POLICY_ACTION_KILL' }] }), ['kill', 'stop'])
})

test('resetTuning clears customization and re-enables every rule', () => {
  const reset = resetTuning({ ...livePolicy, enabled: true, scope: 'x', runbook: 'y', actions: [{ type: 'POLICY_ACTION_STOP' }] })
  assert.equal(reset.enabled, false)
  assert.equal(reset.scope, '')
  assert.equal(reset.runbook, '')
  assert.deepEqual(reset.actions, [])
  assert.ok(reset.rules?.every((r) => r.enabled))
})
