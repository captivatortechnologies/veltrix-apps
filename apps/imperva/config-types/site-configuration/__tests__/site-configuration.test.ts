import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PipelineContext } from '@veltrixsecops/app-sdk'
import validate from '../validate'
import { declaredConfigureParams, liveSiteConfigValues, readSiteConfigFields } from '../_shared'

/**
 * The deploy/rollback/drift handlers call the Cloud WAF v1 API via fetch, which is
 * impractical to mock here. Tests cover validate.ts and the pure _shared helpers.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.siteId ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  siteId: '123456',
  active: 'active',
  accelerationLevel: 'standard',
  refId: 'customer-42',
  logLevel: 'security',
}

// --- validate ---------------------------------------------------------------

test('validate accepts a good site configuration', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true, JSON.stringify(res.errors))
})

test('validate accepts an item with only a Site ID (no-op deploy) but warns', async () => {
  const res = await validate(ctxOf([{ siteId: '1' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'NO_SETTINGS'))
})

test('validate rejects a missing / non-numeric site ID', async () => {
  assert.ok((await validate(ctxOf([{ ...good, siteId: '' }]))).errors.some((e) => e.code === 'EMPTY_SITE_ID'))
  assert.ok((await validate(ctxOf([{ ...good, siteId: 'x' }]))).errors.some((e) => e.code === 'INVALID_SITE_ID'))
})

test('validate rejects invalid enum values', async () => {
  assert.ok((await validate(ctxOf([{ ...good, active: 'on' }]))).errors.some((e) => e.code === 'INVALID_ACTIVE'))
  assert.ok((await validate(ctxOf([{ ...good, accelerationLevel: 'extreme' }]))).errors.some((e) => e.code === 'INVALID_ACCELERATION_LEVEL'))
  assert.ok((await validate(ctxOf([{ ...good, logLevel: 'verbose' }]))).errors.some((e) => e.code === 'INVALID_LOG_LEVEL'))
  assert.ok((await validate(ctxOf([{ ...good, domainValidation: 'sms' }]))).errors.some((e) => e.code === 'INVALID_DOMAIN_VALIDATION'))
  assert.ok((await validate(ctxOf([{ ...good, sealLocation: 'top' }]))).errors.some((e) => e.code === 'INVALID_SEAL_LOCATION'))
})

test('validate rejects a malformed approver email', async () => {
  const res = await validate(ctxOf([{ ...good, approver: 'not-an-email' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_APPROVER'))
})

test('validate rejects a non-boolean-string toggle', async () => {
  assert.ok((await validate(ctxOf([{ ...good, ignoreSsl: 'yes' }]))).errors.some((e) => e.code === 'INVALID_IGNORE_SSL'))
  assert.ok((await validate(ctxOf([{ ...good, restrictedCnameReuse: 'yes' }]))).errors.some((e) => e.code === 'INVALID_RESTRICTED_CNAME_REUSE'))
})

test('validate warns on a duplicate site ID', async () => {
  const res = await validate(ctxOf([good, good]))
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_SITE'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared helpers --------------------------------------------------------

test('declaredConfigureParams includes only non-empty declared fields, mapped to API param names', () => {
  const params = declaredConfigureParams(readSiteConfigFields(good))
  assert.deepEqual(params, [
    { param: 'active', value: 'active' },
    { param: 'acceleration_level', value: 'standard' },
    { param: 'ref_id', value: 'customer-42' },
  ])
})

test('declaredConfigureParams is empty when nothing is declared', () => {
  assert.deepEqual(declaredConfigureParams(readSiteConfigFields({ siteId: '1' })), [])
})

test('liveSiteConfigValues reads the readable fields from a /sites/status envelope', () => {
  const status = {
    res: 0,
    active: 'active',
    acceleration_level: 'aggressive',
    ref_id: 'ref-1',
    restricted_cname_reuse: true,
    add_naked_domain_san: 'false',
    use_wildcard_san_instead_of_full_domain_san: true,
    sealLocation: { id: 'api.seal_location.bottom' },
    log_level: 'full',
  }
  assert.deepEqual(liveSiteConfigValues(status), {
    active: 'active',
    accelerationLevel: 'aggressive',
    refId: 'ref-1',
    restrictedCnameReuse: 'true',
    nakedDomainSan: 'false',
    wildcardSan: 'true',
    sealLocation: 'api.seal_location.bottom',
    logLevel: 'full',
  })
  assert.deepEqual(liveSiteConfigValues(null), {})
})
