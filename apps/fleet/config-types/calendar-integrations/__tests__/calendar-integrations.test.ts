import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.teamId ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { teamId: '3', enableCalendarEvents: 'yes', webhookUrl: 'https://example.com/hook' }

test('validate rejects a non-numeric team id', async () => {
  const res = await validate(ctxOf([{ ...good, teamId: 'abc' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_TEAM_ID'))
})

test('validate rejects an unknown enable choice', async () => {
  const res = await validate(ctxOf([{ ...good, enableCalendarEvents: 'sure' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_YES_NO'))
})

test('validate requires a webhook URL when enabled', async () => {
  const res = await validate(ctxOf([{ ...good, webhookUrl: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'MISSING_WEBHOOK_URL'))
})

test('validate does not require a webhook URL when disabled', async () => {
  const res = await validate(ctxOf([{ ...good, enableCalendarEvents: 'no', webhookUrl: '' }]))
  assert.equal(res.valid, true)
})

test('validate warns on a webhook URL that does not look like http(s)', async () => {
  const res = await validate(ctxOf([{ ...good, webhookUrl: 'not-a-url' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'UNVERIFIED_URL'))
})

test('validate warns on a duplicate team id', async () => {
  const res = await validate(ctxOf([good, good]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_TEAM'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})
