import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { AUTO_VALUE, specFromItem, toSgtBody } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxOf(fields: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: fields.map((value, index) => ({ id: `i${index}`, name: `item${index}`, fields: value })) } } as unknown as PipelineContext
}

test('validate accepts an auto-assigned writable SGT', async () => {
  const result = await validate(ctxOf([{ name: 'Employees', value: AUTO_VALUE }]))
  assert.equal(result.valid, true)
})

test('validate rejects invalid names and reserved numeric range', async () => {
  const result = await validate(ctxOf([{ name: 'Bad Tag', value: 1 }]))
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((error) => error.code === 'INVALID_NAME'))
  assert.ok(result.errors.some((error) => error.code === 'INVALID_TAG_VALUE'))
})

test('wire body preserves Cisco propogateToApic spelling', () => {
  const spec = specFromItem({ id: 'i', name: 'i', fields: { name: 'Servers', value: 42, propagate_to_apic: true } })
  const body = toSgtBody(spec)
  assert.equal(body.value, 42)
  assert.equal(body.propogateToApic, true)
})
