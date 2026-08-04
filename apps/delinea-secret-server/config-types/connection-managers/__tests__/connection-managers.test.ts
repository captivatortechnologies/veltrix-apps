import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  extractConnectorSpecs,
  findConnectorByName,
  connectorIdOf,
  connectorNameOf,
  buildConnectorCreateBody,
  buildConnectorUpdateBody,
  buildConnectorRestoreBody,
  type LiveConnector,
} from '../_shared'
import { recordsFromResponse } from '../../../lib/secretServerApi'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * deploy / rollback / drift / health apply over the Secret Server REST API via
 * node:https inside secretServerApi, which is impractical to mock here. Tests
 * cover validate.ts and the pure, network-free helpers in _shared.ts.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  name: 'Corp Connector 1',
  hostname: 'connector1.corp.local',
  transportType: 'MemoryMq',
  useSsl: false,
  active: true,
  comment: 'primary connector',
}

// --- validate ---------------------------------------------------------------

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a missing hostname', async () => {
  const res = await validate(ctxOf([{ ...good, hostname: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_HOSTNAME'))
})

test('validate accepts a good connection manager', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects an unsupported transport type', async () => {
  const res = await validate(ctxOf([{ ...good, transportType: 'Kafka' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_TRANSPORT_TYPE'))
})

test('validate requires an SSL thumbprint when useSsl is on', async () => {
  const res = await validate(ctxOf([{ ...good, useSsl: true }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'MISSING_SSL_THUMBPRINT'))
})

test('validate accepts useSsl with a thumbprint supplied', async () => {
  const res = await validate(ctxOf([{ ...good, useSsl: true, sslCertificateThumbprint: 'AB12CD34' }]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate warns on a duplicate name', async () => {
  const res = await validate(ctxOf([good, { ...good, comment: 'copy' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_CONNECTOR'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared helpers --------------------------------------------------------

test('extractConnectorSpecs maps and trims canvas fields, defaulting an unknown transport to MemoryMq', () => {
  const specs = extractConnectorSpecs(toItems([{ name: '  Corp Connector 1  ', hostname: ' host.local ', transportType: 'Bogus' }]))
  assert.equal(specs[0].name, 'Corp Connector 1')
  assert.equal(specs[0].hostname, 'host.local')
  assert.equal(specs[0].transportType, 'MemoryMq')
})

test('recordsFromResponse parses a paginated envelope and a bare array', () => {
  const env = recordsFromResponse<LiveConnector>(JSON.stringify({ records: [{ id: 1, name: 'A' }], total: 1 }))
  assert.equal(env.records.length, 1)
  assert.equal(env.total, 1)
})

test('connectorNameOf reads name or siteConnectorName', () => {
  assert.equal(connectorNameOf({ name: 'A' }), 'A')
  assert.equal(connectorNameOf({ siteConnectorName: 'B' }), 'B')
  assert.equal(connectorNameOf({}), '')
})

test('findConnectorByName matches case-insensitively across either name field', () => {
  const connectors: LiveConnector[] = [
    { id: 1, name: 'Corp Connector 1' },
    { id: 2, siteConnectorName: 'Corp Connector 2' },
  ]
  assert.equal(findConnectorByName(connectors, 'corp connector 1')?.id, 1)
  assert.equal(findConnectorByName(connectors, 'CORP CONNECTOR 2')?.id, 2)
  assert.equal(findConnectorByName(connectors, 'nope'), null)
})

test('connectorIdOf reads id or siteConnectorId, rejecting blanks', () => {
  assert.equal(connectorIdOf({ id: 8 }), 8)
  assert.equal(connectorIdOf({ siteConnectorId: '3' }), 3)
  assert.equal(connectorIdOf({}), null)
})

test('buildConnectorCreateBody nests managed fields under data using siteConnectorName', () => {
  const spec = extractConnectorSpecs(toItems([good]))[0]
  const body = buildConnectorCreateBody(spec) as { data: Record<string, unknown> }
  assert.equal(body.data.siteConnectorName, 'Corp Connector 1')
  assert.equal(body.data.hostName, 'connector1.corp.local')
  assert.equal(body.data.queueType, 'MemoryMq')
  assert.equal('sslCertificateThumbprint' in body.data, false)
})

test('buildConnectorCreateBody includes the thumbprint only when useSsl is on', () => {
  const spec = extractConnectorSpecs(toItems([{ ...good, useSsl: true, sslCertificateThumbprint: 'AB12' }]))[0]
  const body = buildConnectorCreateBody(spec) as { data: Record<string, unknown> }
  assert.equal(body.data.sslCertificateThumbprint, 'AB12')
})

test('buildConnectorUpdateBody wraps managed fields in { dirty, value } using name (not siteConnectorName)', () => {
  const spec = extractConnectorSpecs(toItems([{ ...good, active: false }]))[0]
  const body = buildConnectorUpdateBody(spec) as { data: Record<string, { dirty: boolean; value: unknown }> }
  assert.equal(body.data.name.value, 'Corp Connector 1')
  assert.equal(body.data.active.value, false)
  assert.equal('siteConnectorName' in body.data, false)
})

test('buildConnectorRestoreBody restores prior managed fields with the dirty wrapper', () => {
  const body = buildConnectorRestoreBody({ name: 'Old Connector', hostName: 'old.local', active: true, queueType: 'RabbitMq', useSsl: false }) as {
    data: Record<string, { dirty: boolean; value: unknown }>
  }
  assert.equal(body.data.name.value, 'Old Connector')
  assert.equal(body.data.hostName.value, 'old.local')
  assert.equal(body.data.queueType.value, 'RabbitMq')
})
