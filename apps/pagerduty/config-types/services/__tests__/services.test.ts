import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  extractServiceSpecs,
  parseOptionalTimeout,
  buildServiceBody,
  serviceRestoreBody,
  findService,
  findPolicyId,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

// These handlers apply over the PagerDuty REST API via fetch inside pagerdutyApi,
// which is impractical to mock here. Tests focus on validate.ts + the pure _shared
// helpers (parsing / extraction / body building), which are network-free.

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  name: 'Payments API',
  description: 'The billing service',
  escalation_policy: 'Primary On-Call',
  auto_resolve_timeout: 14400,
  acknowledgement_timeout: 1800,
  alert_creation: 'create_alerts_and_incidents',
}

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate accepts a valid service', async () => {
  const res = await validate(ctxOf([{ ...good }]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a missing escalation policy reference', async () => {
  const res = await validate(ctxOf([{ ...good, escalation_policy: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_ESCALATION_POLICY'))
})

test('validate rejects a negative timeout', async () => {
  const res = await validate(ctxOf([{ ...good, auto_resolve_timeout: -5 }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_TIMEOUT'))
})

test('validate rejects a non-integer timeout', async () => {
  const res = await validate(ctxOf([{ ...good, acknowledgement_timeout: 'soon' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_TIMEOUT'))
})

test('validate accepts blank (optional) timeouts', async () => {
  const res = await validate(ctxOf([{ ...good, auto_resolve_timeout: '', acknowledgement_timeout: '' }]))
  assert.equal(res.valid, true)
})

test('validate rejects an invalid alert_creation value', async () => {
  const res = await validate(ctxOf([{ ...good, alert_creation: 'create_alerts' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ALERT_CREATION'))
})

test('validate warns on a duplicate name', async () => {
  const res = await validate(ctxOf([good, { ...good, description: 'copy' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('parseOptionalTimeout coerces numbers, numeric strings and blanks', () => {
  assert.equal(parseOptionalTimeout(3600), 3600)
  assert.equal(parseOptionalTimeout('1800'), 1800)
  assert.equal(parseOptionalTimeout(''), null)
  assert.equal(parseOptionalTimeout(null), null)
  assert.ok(Number.isNaN(parseOptionalTimeout('nope')))
})

test('extractServiceSpecs trims fields and carries the escalation policy name', () => {
  const specs = extractServiceSpecs(ctxOf([{ name: '  Payments  ', escalation_policy: '  Primary  ' }]).canvas)
  assert.equal(specs[0].name, 'Payments')
  assert.equal(specs[0].escalationPolicyName, 'Primary')
})

test('buildServiceBody sets type + escalation_policy_reference and omits blanks', () => {
  const body = buildServiceBody(
    { itemName: 'g', name: 'Payments', description: '', escalationPolicyName: 'Primary', autoResolveTimeout: null, acknowledgementTimeout: null, alertCreation: '' },
    'PEP123',
  )
  assert.equal(body.type, 'service')
  assert.equal(body.name, 'Payments')
  assert.equal(body.escalation_policy?.id, 'PEP123')
  assert.equal(body.escalation_policy?.type, 'escalation_policy_reference')
  assert.equal(body.description, undefined)
  assert.equal(body.auto_resolve_timeout, undefined)
  assert.equal(body.alert_creation, undefined)
})

test('serviceRestoreBody reconstructs the prior body including its escalation policy', () => {
  const body = serviceRestoreBody({
    id: 'PS1',
    name: 'Payments',
    description: 'billing',
    escalation_policy: { id: 'PEP123', type: 'escalation_policy_reference', summary: 'Primary' },
    auto_resolve_timeout: 14400,
    alert_creation: 'create_incidents',
  })
  assert.equal(body.type, 'service')
  assert.equal(body.escalation_policy?.id, 'PEP123')
  assert.equal(body.auto_resolve_timeout, 14400)
  assert.equal(body.alert_creation, 'create_incidents')
})

test('findService matches by name case-insensitively', () => {
  const live = [{ id: 'PS1', name: 'Payments API' }, { id: 'PS2', name: 'Web' }]
  assert.equal(findService(live, 'payments api')?.id, 'PS1')
  assert.equal(findService(live, 'missing'), null)
})

test('findPolicyId resolves an escalation policy name to its id', () => {
  const policies = [{ id: 'PEP1', name: 'Primary On-Call' }, { id: 'PEP2', name: 'Secondary' }]
  assert.equal(findPolicyId(policies, 'primary on-call'), 'PEP1')
  assert.equal(findPolicyId(policies, 'nope'), null)
})
