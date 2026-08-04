import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildSyslogIntegrationBody, findSyslogIntegration, syslogIntegrationsFromReply, normalizeName } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift handlers apply over the Cortex XDR REST API via fetch,
 * which is impractical to mock here. Tests focus on validate.ts and the pure
 * _shared helpers (identity matching + body building) — both network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  name: 'Primary SIEM',
  address: 'siem.internal.example.com',
  port: 6514,
  protocol: 'TLS',
  facility: 'local0',
}

// --- validate -----------------------------------------------------------------

test('validate accepts a well-formed syslog integration', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a missing address', async () => {
  const res = await validate(ctxOf([{ ...good, address: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_ADDRESS'))
})

test('validate rejects an out-of-range port', async () => {
  const res = await validate(ctxOf([{ ...good, port: 70000 }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_PORT'))
})

test('validate rejects a non-integer port', async () => {
  const res = await validate(ctxOf([{ ...good, port: 'syslog-port' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_PORT'))
})

test('validate rejects an unknown protocol', async () => {
  const res = await validate(ctxOf([{ ...good, protocol: 'QUIC' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_PROTOCOL'))
})

test('validate warns when a certificate is set without TLS', async () => {
  const res = await validate(ctxOf([{ ...good, protocol: 'UDP', certificate_content: '-----BEGIN CERTIFICATE-----' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'CERTIFICATE_WITHOUT_TLS'))
})

test('validate warns on a duplicate name', async () => {
  const res = await validate(ctxOf([good, { ...good, facility: 'local1' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared helpers ----------------------------------------------------------

test('buildSyslogIntegrationBody omits security_info when no TLS fields are set', () => {
  const body = buildSyslogIntegrationBody({ name: 'A', address: '10.0.0.1', port: 514, protocol: 'UDP' })
  assert.equal('security_info' in body, false)
})

test('buildSyslogIntegrationBody includes security_info when a cert is provided', () => {
  const body = buildSyslogIntegrationBody({ ...good, certificate_content: 'PEM-DATA' })
  assert.equal(body.security_info?.certificate_content, 'PEM-DATA')
})

test('buildSyslogIntegrationBody defaults protocol to TCP when blank', () => {
  const body = buildSyslogIntegrationBody({ name: 'A', address: '10.0.0.1', port: 514 })
  assert.equal(body.protocol, 'TCP')
})

test('findSyslogIntegration matches case-insensitively on name', () => {
  const live = [{ SYSLOG_INTEGRATION_NAME: 'PRIMARY SIEM', SYSLOG_INTEGRATION_ID: 7 }]
  const match = findSyslogIntegration(live, 'primary siem')
  assert.ok(match)
  assert.equal(match?.SYSLOG_INTEGRATION_ID, 7)
})

test('syslogIntegrationsFromReply unwraps both the array and { objects } shapes', () => {
  assert.equal(syslogIntegrationsFromReply([{ SYSLOG_INTEGRATION_NAME: 'a' }]).length, 1)
  assert.equal(syslogIntegrationsFromReply({ objects: [{ SYSLOG_INTEGRATION_NAME: 'b' }] }).length, 1)
  assert.equal(syslogIntegrationsFromReply(null).length, 0)
})

test('normalizeName trims and lowercases', () => {
  assert.equal(normalizeName('  Primary SIEM  '), 'primary siem')
})
