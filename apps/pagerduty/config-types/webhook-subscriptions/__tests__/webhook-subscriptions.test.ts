import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  extractWebhookSubscriptionSpecs,
  parseEvents,
  parseCustomHeaders,
  buildWebhookSubscriptionBody,
  webhookSubscriptionRestoreBody,
  findWebhookSubscription,
  findFilterTargetId,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

// These handlers apply over the PagerDuty REST API via fetch inside pagerdutyApi,
// which is impractical to mock here. Tests focus on validate.ts + the pure _shared
// helpers (parsing / extraction / body building), which are network-free.

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.description ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const EVENTS = '["incident.triggered", "incident.resolved"]'
const good = {
  description: 'Ops Slack relay',
  url: 'https://example.com/receive_a_pagerduty_webhook',
  active: true,
  events: EVENTS,
  filter_type: 'service_reference',
  filter_target: 'My Service',
  custom_headers: '[{"name":"X-Auth-Token","value":"secret"}]',
}

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate accepts a valid subscription', async () => {
  const res = await validate(ctxOf([{ ...good }]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing description', async () => {
  const res = await validate(ctxOf([{ ...good, description: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_DESCRIPTION'))
})

test('validate warns on a duplicate description', async () => {
  const res = await validate(ctxOf([good, { ...good, url: 'https://example.com/other' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_DESCRIPTION'))
})

test('validate rejects a missing url', async () => {
  const res = await validate(ctxOf([{ ...good, url: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_URL'))
})

test('validate rejects a malformed url', async () => {
  const res = await validate(ctxOf([{ ...good, url: 'not a url' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_URL'))
})

test('validate rejects missing events', async () => {
  const res = await validate(ctxOf([{ ...good, events: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_EVENTS'))
})

test('validate rejects an unknown event type', async () => {
  const res = await validate(ctxOf([{ ...good, events: '["incident.triggered", "incident.made_up"]' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_EVENTS'))
})

test('validate rejects a missing filter_type', async () => {
  const res = await validate(ctxOf([{ ...good, filter_type: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_FILTER_TYPE'))
})

test('validate rejects an invalid filter_type', async () => {
  const res = await validate(ctxOf([{ ...good, filter_type: 'user_reference' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_FILTER_TYPE'))
})

test('validate requires filter_target for a service_reference filter', async () => {
  const res = await validate(ctxOf([{ ...good, filter_target: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_FILTER_TARGET'))
})

test('validate requires filter_target for a team_reference filter', async () => {
  const res = await validate(ctxOf([{ ...good, filter_type: 'team_reference', filter_target: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_FILTER_TARGET'))
})

test('validate accepts account_reference with a blank filter_target', async () => {
  const res = await validate(ctxOf([{ ...good, filter_type: 'account_reference', filter_target: '' }]))
  assert.equal(res.valid, true)
})

test('validate warns (not errors) on a non-blank filter_target under account_reference', async () => {
  const res = await validate(ctxOf([{ ...good, filter_type: 'account_reference', filter_target: 'Ignored' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'IGNORED_FILTER_TARGET'))
})

test('validate accepts blank custom_headers', async () => {
  const res = await validate(ctxOf([{ ...good, custom_headers: '' }]))
  assert.equal(res.valid, true)
})

test('validate rejects malformed custom_headers', async () => {
  const res = await validate(ctxOf([{ ...good, custom_headers: '[{"name":""}]' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_CUSTOM_HEADERS'))
})

test('parseEvents returns typed events for a valid array', () => {
  const parsed = parseEvents(EVENTS)
  assert.equal(parsed.error, null)
  assert.deepEqual(parsed.events, ['incident.triggered', 'incident.resolved'])
})

test('parseEvents rejects an unknown event type', () => {
  const parsed = parseEvents('["incident.bogus"]')
  assert.equal(parsed.events, null)
  assert.ok(parsed.error)
})

test('parseCustomHeaders accepts a blank value', () => {
  const parsed = parseCustomHeaders('')
  assert.equal(parsed.headers, null)
  assert.equal(parsed.error, null)
})

test('parseCustomHeaders parses valid name/value pairs', () => {
  const parsed = parseCustomHeaders('[{"name":"X-Foo","value":"bar"}]')
  assert.equal(parsed.error, null)
  assert.deepEqual(parsed.headers, [{ name: 'X-Foo', value: 'bar' }])
})

test('parseCustomHeaders rejects an entry missing a name', () => {
  const parsed = parseCustomHeaders('[{"value":"bar"}]')
  assert.equal(parsed.headers, null)
  assert.ok(parsed.error)
})

test('extractWebhookSubscriptionSpecs trims fields and defaults active to true', () => {
  const specs = extractWebhookSubscriptionSpecs(
    ctxOf([{ description: '  Ops Slack relay  ', url: '  https://example.com/hook  ', filter_type: 'account_reference' }]).canvas,
  )
  assert.equal(specs[0].description, 'Ops Slack relay')
  assert.equal(specs[0].url, 'https://example.com/hook')
  assert.equal(specs[0].active, true)
})

test('buildWebhookSubscriptionBody sets type + filter and omits headers when none', () => {
  const body = buildWebhookSubscriptionBody(
    {
      itemName: 'g',
      description: 'Ops Slack relay',
      url: 'https://example.com/hook',
      active: true,
      eventsJson: EVENTS,
      filterType: 'service_reference',
      filterTarget: 'My Service',
      customHeadersJson: '',
    },
    ['incident.triggered', 'incident.resolved'],
    'PIJ90N7',
    null,
  )
  assert.equal(body.type, 'webhook_subscription')
  assert.equal(body.active, true)
  assert.equal(body.delivery_method?.type, 'http_delivery_method')
  assert.equal(body.delivery_method?.url, 'https://example.com/hook')
  assert.equal(body.delivery_method?.custom_headers, undefined)
  assert.equal(body.filter?.type, 'service_reference')
  assert.equal(body.filter?.id, 'PIJ90N7')
  assert.deepEqual(body.events, ['incident.triggered', 'incident.resolved'])
})

test('buildWebhookSubscriptionBody omits the filter id for account_reference', () => {
  const body = buildWebhookSubscriptionBody(
    {
      itemName: 'g',
      description: 'Ops Slack relay',
      url: 'https://example.com/hook',
      active: true,
      eventsJson: EVENTS,
      filterType: 'account_reference',
      filterTarget: '',
      customHeadersJson: '',
    },
    ['incident.triggered'],
    null,
    [{ name: 'X-Foo', value: 'bar' }],
  )
  assert.equal(body.filter?.type, 'account_reference')
  assert.equal(body.filter?.id, undefined)
  assert.deepEqual(body.delivery_method?.custom_headers, [{ name: 'X-Foo', value: 'bar' }])
})

test('webhookSubscriptionRestoreBody reconstructs the prior body including its filter', () => {
  const body = webhookSubscriptionRestoreBody({
    id: 'PUABCDL',
    description: 'Ops Slack relay',
    active: false,
    delivery_method: { type: 'http_delivery_method', url: 'https://example.com/hook', custom_headers: [{ name: 'X-Foo', value: '***' }] },
    events: ['incident.triggered'],
    filter: { id: 'PIJ90N7', type: 'service_reference' },
  })
  assert.equal(body.type, 'webhook_subscription')
  assert.equal(body.active, false)
  assert.equal(body.filter?.id, 'PIJ90N7')
  assert.deepEqual(body.events, ['incident.triggered'])
  assert.deepEqual(body.delivery_method?.custom_headers, [{ name: 'X-Foo', value: '***' }])
})

test('findWebhookSubscription matches by description case-insensitively', () => {
  const live = [{ id: 'P1', description: 'Ops Slack relay' }, { id: 'P2', description: 'Other' }]
  assert.equal(findWebhookSubscription(live, 'ops slack relay')?.id, 'P1')
  assert.equal(findWebhookSubscription(live, 'missing'), null)
})

test('findFilterTargetId resolves a service or team name to its id', () => {
  const targets = [{ id: 'PIJ90N7', name: 'My Service' }, { id: 'PT1', name: 'SRE' }]
  assert.equal(findFilterTargetId(targets, 'my service'), 'PIJ90N7')
  assert.equal(findFilterTargetId(targets, 'nope'), null)
})
