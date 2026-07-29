import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * These handlers apply over the Kibana Detection Engine REST API via node:https
 * inside soConsole, which is impractical to mock here. Tests focus on validate.ts,
 * which is pure and network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.ruleId ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { ruleId: 'so-suspicious-powershell', name: 'Suspicious PowerShell', severity: 'high', riskScore: 73, query: 'process.name:powershell.exe', enabled: 'enabled' }

test('validate rejects an unsafe rule id', async () => {
  const res = await validate(ctxOf([{ ...good, ruleId: 'bad id/../x' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_RULE_ID'))
})

test('validate rejects an unknown severity', async () => {
  const res = await validate(ctxOf([{ ...good, severity: 'urgent' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_SEVERITY'))
})

test('validate rejects a risk score out of range', async () => {
  const res = await validate(ctxOf([{ ...good, riskScore: 150 }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_RISK_SCORE'))

  const negative = await validate(ctxOf([{ ...good, riskScore: -1 }]))
  assert.equal(negative.valid, false)
  assert.ok(negative.errors.some((e) => e.code === 'INVALID_RISK_SCORE'))
})

test('validate rejects an empty query and name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '', query: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_QUERY'))
})

test('validate accepts a good rule (risk score as a string too)', async () => {
  const res = await validate(ctxOf([{ ...good, riskScore: '50' }]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})
