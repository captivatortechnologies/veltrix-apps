import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildConnectionBody,
  buildConnectionRestoreBody,
  connectionsFromList,
  definitionTypeToConnectionType,
  findConnection,
  toHeaderList,
  type Connection,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The network handlers (deploy/rollback/drift/health) apply over the Sumo Logic
 * Management API via `fetch`, which is impractical to mock here. Tests focus on
 * the pure, network-free pieces: validate.ts and _shared.ts.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const webhook = {
  name: 'Slack Alerts',
  type: 'WebhookDefinition',
  url: 'https://hooks.slack.com/services/x',
  webhookType: 'Slack',
  defaultPayload: '{"text":"{{AlertName}}"}',
}

const serviceNow = {
  name: 'SNOW Incidents',
  type: 'ServiceNowDefinition',
  url: 'https://acme.service-now.com',
  username: 'svc-sumo',
  password: 'shh',
}

// --- validate ---------------------------------------------------------------

test('validate accepts a well-formed webhook connection', async () => {
  const res = await validate(ctxOf([webhook]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate accepts a well-formed ServiceNow connection', async () => {
  const res = await validate(ctxOf([serviceNow]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...webhook, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects an invalid type', async () => {
  const res = await validate(ctxOf([{ ...webhook, type: 'SlackConnection' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_TYPE'))
})

test('validate requires defaultPayload for webhook connections', async () => {
  const res = await validate(ctxOf([{ ...webhook, defaultPayload: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_DEFAULT_PAYLOAD'))
})

test('validate requires username/password for ServiceNow connections', async () => {
  const res = await validate(ctxOf([{ ...serviceNow, username: '', password: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_USERNAME'))
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_PASSWORD'))
})

test('validate warns when authorization headers are declared', async () => {
  const res = await validate(ctxOf([{ ...webhook, headers: { Authorization: 'Bearer x' } }]))
  assert.ok(res.warnings.some((w) => w.code === 'HEADERS_NOT_RESTORABLE'))
})

test('validate rejects more than 5 custom headers', async () => {
  const customHeaders = { a: '1', b: '2', c: '3', d: '4', e: '5', f: '6' }
  const res = await validate(ctxOf([{ ...webhook, customHeaders }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'TOO_MANY_CUSTOM_HEADERS'))
})

test('validate warns on a duplicate name', async () => {
  const res = await validate(ctxOf([webhook, { ...webhook, url: 'https://hooks.slack.com/services/y' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

// --- _shared ----------------------------------------------------------------

test('toHeaderList converts a keyvalue map into a Header list', () => {
  assert.deepEqual(toHeaderList({ Authorization: 'Bearer x' }), [{ name: 'Authorization', value: 'Bearer x' }])
  assert.deepEqual(toHeaderList([{ name: 'X', value: 'Y' }]), [{ name: 'X', value: 'Y' }])
  assert.deepEqual(toHeaderList(null), [])
})

test('definitionTypeToConnectionType maps write types to read/delete types', () => {
  assert.equal(definitionTypeToConnectionType('WebhookDefinition'), 'WebhookConnection')
  assert.equal(definitionTypeToConnectionType('ServiceNowDefinition'), 'ServiceNowConnection')
})

test('buildConnectionBody builds a webhook body with headers converted to lists', () => {
  const body = buildConnectionBody({ ...webhook, headers: { Authorization: 'Bearer x' } })
  assert.equal(body.type, 'WebhookDefinition')
  assert.deepEqual(body.headers, [{ name: 'Authorization', value: 'Bearer x' }])
})

test('buildConnectionBody builds a ServiceNow body without webhook fields', () => {
  const body = buildConnectionBody(serviceNow)
  assert.equal(body.type, 'ServiceNowDefinition')
  assert.equal(body.username, 'svc-sumo')
  assert.equal('defaultPayload' in body, false)
})

test('buildConnectionRestoreBody excludes headers and password', () => {
  const prior: Connection = {
    id: '1',
    name: 'n',
    type: 'WebhookConnection',
    url: 'https://x',
    defaultPayload: 'p',
    headers: [{ name: 'Authorization', value: 'masked' }],
  }
  const body = buildConnectionRestoreBody(prior)
  assert.equal('headers' in body, false)
  assert.equal(body.type, 'WebhookDefinition')
})

test('connectionsFromList unwraps the { data: [...] } envelope and bare arrays', () => {
  const conns: Connection[] = [{ id: '1', name: 'a', type: 'WebhookConnection' }]
  assert.deepEqual(connectionsFromList({ data: conns }), conns)
  assert.deepEqual(connectionsFromList(conns), conns)
  assert.deepEqual(connectionsFromList(null), [])
})

test('findConnection matches by name case-insensitively', () => {
  const conns: Connection[] = [{ id: '9', name: 'Slack Alerts', type: 'WebhookConnection' }]
  assert.equal(findConnection(conns, 'slack alerts')?.id, '9')
  assert.equal(findConnection(conns, 'missing'), null)
})
