import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildNotificationEntity, bodyFromLiveNotification, notificationsFromList, findNotification, HTTP_NOTIFICATION_TYPE } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.title ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  title: 'SOC Webhook',
  description: 'Posts alerts to the SOC webhook',
  config: `{"type":"${HTTP_NOTIFICATION_TYPE}","url":"https://soc.example.com/hook","http_method":"POST"}`,
}

test('validate accepts a well-formed notification', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing title', async () => {
  const res = await validate(ctxOf([{ ...good, title: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_TITLE'))
})

test('validate rejects config missing a type discriminator', async () => {
  const res = await validate(ctxOf([{ ...good, config: '{"url":"https://x"}' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_CONFIG'))
})

test('validate warns on a duplicate title', async () => {
  const res = await validate(ctxOf([good, { ...good, description: 'copy' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_TITLE'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('buildNotificationEntity parses config and carries title + description', () => {
  const { entity, error } = buildNotificationEntity(good)
  assert.equal(error, undefined)
  assert.equal(entity?.title, 'SOC Webhook')
  assert.equal((entity?.config as Record<string, unknown>).type, HTTP_NOTIFICATION_TYPE)
})

test('bodyFromLiveNotification includes the id PUT requires', () => {
  const body = bodyFromLiveNotification({ id: 'n1', title: 'X', config: { type: HTTP_NOTIFICATION_TYPE } })
  assert.equal(body.id, 'n1')
  assert.equal(body.title, 'X')
})

test('notificationsFromList + findNotification match by title from the API envelope', () => {
  const live = notificationsFromList({ notifications: [{ id: '1', title: 'A' }, { id: '2', title: 'B' }] })
  assert.equal(live.length, 2)
  assert.equal(findNotification(live, 'B')?.id, '2')
  assert.equal(findNotification(live, 'nope'), null)
})
