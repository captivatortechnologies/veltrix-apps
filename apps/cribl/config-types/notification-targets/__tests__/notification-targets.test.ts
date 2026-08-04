import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { NOTIFICATION_TARGET, buildEntityBody } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * NOTIFICATION_TARGET reuses lib/criblSystemEntities (the same engine backing
 * Sources/Destinations), so behavioral coverage of validateEntities itself
 * lives in config-types/sources/__tests__. These tests confirm the
 * `groupScoped: false` descriptor wiring specific to this config type.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.id ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) }, settings: {} } as unknown as PipelineContext
}

const good = { id: 'nt-slack-prod', type: 'slack', conf: '{ "url": "https://hooks.slack.com/services/x" }' }

test('validate accepts a good notification target', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing type', async () => {
  const res = await validate(ctxOf([{ ...good, type: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_TYPE'))
})

test('validate does not scope duplicate-id warnings to a group (no worker_group field)', async () => {
  const res = await validate(ctxOf([good, { ...good }]))
  assert.equal(res.valid, true)
  const warning = res.warnings.find((w) => w.code === 'DUPLICATE_ID')
  assert.ok(warning)
  assert.ok(!warning!.message.includes('for group'))
})

test('buildEntityBody flattens conf onto id + type', () => {
  const body = buildEntityBody('nt-slack-prod', 'slack', { url: 'https://hooks.slack.com/services/x' })
  assert.deepEqual(body, { id: 'nt-slack-prod', type: 'slack', url: 'https://hooks.slack.com/services/x' })
})

test('NOTIFICATION_TARGET is a flat, non-group-scoped collection', () => {
  assert.equal(NOTIFICATION_TARGET.resource, 'notification-targets')
  assert.equal(NOTIFICATION_TARGET.groupScoped, false)
})
