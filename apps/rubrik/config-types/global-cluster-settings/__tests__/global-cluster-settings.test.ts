import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildClusterInfoPatch,
  buildClusterSettingsSpec,
  buildNtpServersBody,
  normalizeTimezone,
  ntpServersFrom,
  stringListFrom,
  stringListsEqual,
  toStringArray,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift/health handlers apply over the Rubrik CDM REST API via
 * node:https inside rubrikApi, which is impractical to mock here. Tests focus on
 * validate.ts and the pure _shared.ts builders, which are network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: `item-${i}`, fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { timezone: 'America/New_York', clusterName: 'prod-cluster', dnsServers: ['10.0.0.1'] }

// --- validate ---------------------------------------------------------------

test('validate rejects a missing timezone', async () => {
  const res = await validate(ctxOf([{ ...good, timezone: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_TIMEZONE'))
})

test('validate rejects an unsupported timezone', async () => {
  const res = await validate(ctxOf([{ ...good, timezone: 'Mars/Olympus_Mons' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_TIMEZONE'))
})

test('validate errors when there is no item', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate rejects more than one declared item (singleton)', async () => {
  const res = await validate(ctxOf([good, good]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'SINGLETON'))
})

test('validate warns when only the timezone is set', async () => {
  const res = await validate(ctxOf([{ timezone: 'UTC' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'MOSTLY_EMPTY'))
})

test('validate accepts a well-formed cluster settings item', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

// --- normalizeTimezone ---------------------------------------------------------

test('normalizeTimezone keeps known zones and falls back to UTC', () => {
  assert.equal(normalizeTimezone('Europe/London'), 'Europe/London')
  assert.equal(normalizeTimezone('bogus'), 'UTC')
})

// --- toStringArray --------------------------------------------------------------

test('toStringArray accepts arrays and comma/newline-separated strings, dedupes, trims', () => {
  assert.deepEqual(toStringArray(['10.0.0.1', ' 10.0.0.2 ', '10.0.0.1']), ['10.0.0.1', '10.0.0.2'])
  assert.deepEqual(toStringArray('a, b\nc'), ['a', 'b', 'c'])
  assert.deepEqual(toStringArray(undefined), [])
})

// --- buildClusterSettingsSpec / buildClusterInfoPatch ---------------------------

test('buildClusterSettingsSpec normalizes every field', () => {
  const spec = buildClusterSettingsSpec({
    clusterName: '  prod  ',
    timezone: 'Europe/London',
    location: '  London  ',
    dnsServers: ['10.0.0.1'],
    dnsSearchDomains: 'corp.example.com',
    ntpServers: ['ntp.example.com'],
    loginBanner: '  Authorized access only  ',
  })
  assert.equal(spec.clusterName, 'prod')
  assert.equal(spec.timezone, 'Europe/London')
  assert.equal(spec.location, 'London')
  assert.deepEqual(spec.dnsServers, ['10.0.0.1'])
  assert.deepEqual(spec.dnsSearchDomains, ['corp.example.com'])
  assert.deepEqual(spec.ntpServers, ['ntp.example.com'])
  assert.equal(spec.loginBanner, 'Authorized access only')
})

test('buildClusterInfoPatch emits name only when set, always emits timezone + geolocation', () => {
  const withName = buildClusterInfoPatch({ clusterName: 'prod', timezone: 'UTC', location: 'NYC' })
  assert.deepEqual(withName, { name: 'prod', timezone: { timezone: 'UTC' }, geolocation: { address: 'NYC' } })

  const withoutName = buildClusterInfoPatch({ clusterName: '', timezone: 'UTC', location: '' })
  assert.equal('name' in withoutName, false)
  assert.deepEqual(withoutName.geolocation, { address: '' })
})

// --- list wire-format helpers ----------------------------------------------------

test('stringListFrom unwraps bare arrays and { data }-wrapped arrays', () => {
  assert.deepEqual(stringListFrom(['1.1.1.1', '8.8.8.8']), ['1.1.1.1', '8.8.8.8'])
  assert.deepEqual(stringListFrom({ data: ['1.1.1.1'] }), ['1.1.1.1'])
  assert.deepEqual(stringListFrom(null), [])
})

test('ntpServersFrom accepts CDM 5+ { data: [{ server }] } and bare string arrays', () => {
  assert.deepEqual(ntpServersFrom({ data: [{ server: 'ntp1.example.com' }, { server: 'ntp2.example.com' }] }), [
    'ntp1.example.com',
    'ntp2.example.com',
  ])
  assert.deepEqual(ntpServersFrom(['ntp1.example.com']), ['ntp1.example.com'])
  assert.deepEqual(ntpServersFrom(null), [])
})

test('buildNtpServersBody wraps each server as { server }', () => {
  assert.deepEqual(buildNtpServersBody(['ntp1.example.com', 'ntp2.example.com']), [
    { server: 'ntp1.example.com' },
    { server: 'ntp2.example.com' },
  ])
})

test('stringListsEqual ignores order but not membership', () => {
  assert.equal(stringListsEqual(['a', 'b'], ['b', 'a']), true)
  assert.equal(stringListsEqual(['a'], ['a', 'b']), false)
  assert.equal(stringListsEqual([], []), true)
})
