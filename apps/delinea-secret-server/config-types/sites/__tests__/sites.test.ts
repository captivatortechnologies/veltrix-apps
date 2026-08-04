import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  extractSiteSpecs,
  findSiteByName,
  siteIdOf,
  siteNameOf,
  buildSiteCreateBody,
  buildSiteUpdateBody,
  buildSiteRestoreBody,
  type LiveSite,
} from '../_shared'
import { recordsFromResponse } from '../../../lib/secretServerApi'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * deploy / rollback / drift / health apply over the Secret Server REST API via
 * node:https inside secretServerApi, which is impractical to mock here. Tests
 * cover validate.ts and the pure, network-free helpers in _shared.ts.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.siteName ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  siteName: 'East Coast DC',
  active: true,
  callbackInterval: 300,
  siteConnectorId: 1,
  winRmEndpoint: 'http://localhost:5985/wsman',
  enableCredSsp: false,
  enableRdpProxy: false,
  enableSshProxy: false,
  comment: 'primary DE site',
}

// --- validate ---------------------------------------------------------------

test('validate rejects a missing site name', async () => {
  const res = await validate(ctxOf([{ ...good, siteName: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate accepts a good site', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate warns on a duplicate site name', async () => {
  const res = await validate(ctxOf([good, { ...good, comment: 'copy' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_SITE'))
})

test('validate rejects a callback interval out of the 30-300 range', async () => {
  const res = await validate(ctxOf([{ ...good, callbackInterval: 10 }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_CALLBACK_INTERVAL'))
})

test('validate requires an RDP proxy port when the RDP proxy is enabled', async () => {
  const res = await validate(ctxOf([{ ...good, enableRdpProxy: true }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'MISSING_RDP_PORT'))
})

test('validate requires an SSH proxy port when the SSH proxy is enabled', async () => {
  const res = await validate(ctxOf([{ ...good, enableSshProxy: true }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'MISSING_SSH_PORT'))
})

test('validate accepts proxy ports when their proxy is enabled', async () => {
  const res = await validate(ctxOf([{ ...good, enableRdpProxy: true, rdpProxyPort: 3389, enableSshProxy: true, sshProxyPort: 22 }]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared helpers --------------------------------------------------------

test('extractSiteSpecs maps and trims canvas fields, applying safe defaults', () => {
  const specs = extractSiteSpecs(toItems([{ siteName: '  East Coast DC  ' }]))
  assert.equal(specs[0].siteName, 'East Coast DC')
  assert.equal(specs[0].callbackInterval, 300)
  assert.equal(specs[0].siteConnectorId, 1)
  assert.equal(specs[0].winRmEndpoint, 'http://localhost:5985/wsman')
  assert.equal(specs[0].powershellRunAsSecretId, null)
})

test('recordsFromResponse parses a paginated envelope and a bare array', () => {
  const env = recordsFromResponse<LiveSite>(JSON.stringify({ records: [{ id: 1, siteName: 'A' }], total: 1 }))
  assert.equal(env.records.length, 1)
  assert.equal(env.total, 1)
  const arr = recordsFromResponse<LiveSite>(JSON.stringify([{ id: 2, siteName: 'B' }]))
  assert.equal(arr.records.length, 1)
})

test('findSiteByName matches case-insensitively on the exact name', () => {
  const sites: LiveSite[] = [
    { id: 1, siteName: 'East Coast DC' },
    { id: 2, siteName: 'West Coast DC' },
  ]
  assert.equal(findSiteByName(sites, 'east coast dc')?.id, 1)
  assert.equal(findSiteByName(sites, 'WEST COAST DC')?.id, 2)
  assert.equal(findSiteByName(sites, 'nope'), null)
})

test('siteIdOf reads id or siteId, rejecting blanks', () => {
  assert.equal(siteIdOf({ id: 8 }), 8)
  assert.equal(siteIdOf({ siteId: '3' }), 3)
  assert.equal(siteIdOf({}), null)
})

test('siteNameOf reads the site name', () => {
  assert.equal(siteNameOf({ siteName: 'East Coast DC' }), 'East Coast DC')
  assert.equal(siteNameOf({}), '')
})

test('buildSiteCreateBody nests managed fields under data and omits unset optionals', () => {
  const spec = extractSiteSpecs(toItems([good]))[0]
  const body = buildSiteCreateBody(spec) as { data: Record<string, unknown> }
  assert.equal(body.data.siteName, 'East Coast DC')
  assert.equal(body.data.heartbeatInterval, 300)
  assert.equal(body.data.siteConnectorId, 1)
  assert.equal('powershellSecretId' in body.data, false)
  assert.equal('rdpProxyPort' in body.data, false)
})

test('buildSiteCreateBody includes the PowerShell run-as secret id reference when set', () => {
  const spec = extractSiteSpecs(toItems([{ ...good, powershellRunAsSecretId: 42 }]))[0]
  const body = buildSiteCreateBody(spec) as { data: Record<string, unknown> }
  assert.equal(body.data.powershellSecretId, 42)
})

test('buildSiteUpdateBody wraps every managed field in { dirty, value }', () => {
  const spec = extractSiteSpecs(toItems([{ ...good, active: false }]))[0]
  const body = buildSiteUpdateBody(spec) as { data: Record<string, { dirty: boolean; value: unknown }> }
  assert.equal(body.data.siteName.dirty, true)
  assert.equal(body.data.siteName.value, 'East Coast DC')
  assert.equal(body.data.active.value, false)
  assert.equal(body.data.heartbeatInterval.value, 300)
})

test('buildSiteRestoreBody restores prior managed fields with the dirty wrapper', () => {
  const body = buildSiteRestoreBody({ siteName: 'Old Site', active: true, heartbeatInterval: 120, siteConnectorId: 2 }) as {
    data: Record<string, { dirty: boolean; value: unknown }>
  }
  assert.equal(body.data.siteName.value, 'Old Site')
  assert.equal(body.data.heartbeatInterval.value, 120)
  assert.equal(body.data.siteConnectorId.value, 2)
})
