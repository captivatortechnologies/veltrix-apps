import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { spec } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift/health handlers apply over the ServiceNow Table API
 * (network) through the shared table-config engine, which is impractical to
 * mock here. Tests focus on validate.ts and the pure spec.buildBody mapping.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  name: 'Notify SOC on Priority 1',
  collection: 'sn_si_incident',
  eventName: 'sn_si_incident.priority1',
  condition: '',
  active: true,
  weight: 0,
  recipientUsers: [],
  recipientGroups: ['abc123def456abc123def456abc123de'],
  recipientFields: ['assigned_to'],
  mandatory: false,
  subject: 'Priority 1 security incident opened',
  messageHtml: '<p>A priority 1 security incident was opened.</p>',
  replyTo: 'soc@example.com',
}

test('validate accepts a well-formed notification', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a missing table', async () => {
  const res = await validate(ctxOf([{ ...good, collection: '' }]))
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_TABLE'))
})

test('validate rejects a missing event name', async () => {
  const res = await validate(ctxOf([{ ...good, eventName: '' }]))
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_EVENT_NAME'))
})

test('validate rejects a missing subject', async () => {
  const res = await validate(ctxOf([{ ...good, subject: '' }]))
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_SUBJECT'))
})

test('validate rejects a missing message', async () => {
  const res = await validate(ctxOf([{ ...good, messageHtml: '' }]))
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_MESSAGE'))
})

test('validate warns on an invalid reply-to address', async () => {
  const res = await validate(ctxOf([{ ...good, replyTo: 'not-an-email' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'INVALID_REPLY_TO'))
})

test('validate warns when there are no recipients', async () => {
  const res = await validate(ctxOf([{ ...good, recipientUsers: [], recipientGroups: [], recipientFields: [] }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'NO_RECIPIENTS'))
})

test('validate warns on a duplicate identity', async () => {
  const res = await validate(ctxOf([good, { ...good, subject: 'other' }]))
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_IDENTITY'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('spec.buildBody joins recipient lists into comma strings', () => {
  const body = spec.buildBody(good)
  assert.equal(body.recipient_groups, 'abc123def456abc123def456abc123de')
  assert.equal(body.recipient_fields, 'assigned_to')
  assert.equal(body.recipient_users, '')
  assert.equal(body.event_name, 'sn_si_incident.priority1')
})
