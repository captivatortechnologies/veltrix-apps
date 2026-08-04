import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildSamlConfigurationBody, findSamlConfiguration, normalizeBool, toStringList, type SamlConfiguration } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The network handlers (deploy/rollback/drift/health) apply over the Sumo Logic
 * Management API via `fetch`, which is impractical to mock here. Tests focus on
 * the pure, network-free pieces: validate.ts and _shared.ts.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.configurationName ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  configurationName: 'Okta',
  issuer: 'http://www.okta.com/abc123',
  x509cert1: '-----BEGIN CERTIFICATE-----\nMIIC...\n-----END CERTIFICATE-----',
}

// --- validate ---------------------------------------------------------------

test('validate accepts a well-formed configuration (with the always-on blast-radius warning)', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
  assert.ok(res.warnings.some((w) => w.code === 'HIGH_BLAST_RADIUS'))
})

test('validate rejects a missing name/issuer/certificate', async () => {
  assert.ok((await validate(ctxOf([{ ...good, configurationName: '' }]))).errors.some((e) => e.code === 'EMPTY_NAME'))
  assert.ok((await validate(ctxOf([{ ...good, issuer: '' }]))).errors.some((e) => e.code === 'EMPTY_ISSUER'))
  assert.ok((await validate(ctxOf([{ ...good, x509cert1: '' }]))).errors.some((e) => e.code === 'EMPTY_CERTIFICATE'))
})

test('validate warns on a non-PEM-looking certificate', async () => {
  const res = await validate(ctxOf([{ ...good, x509cert1: 'not-a-cert' }]))
  assert.ok(res.warnings.some((w) => w.code === 'CERTIFICATE_NOT_PEM'))
})

test('validate requires authnRequestUrl when SP-initiated login is on', async () => {
  const res = await validate(ctxOf([{ ...good, spInitiatedLoginEnabled: true }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_AUTHN_REQUEST_URL'))
})

test('validate requires first/last name attributes when on-demand provisioning is on', async () => {
  const res = await validate(ctxOf([{ ...good, onDemandProvisioningEnabled: true }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_FIRST_NAME_ATTRIBUTE'))
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_LAST_NAME_ATTRIBUTE'))
})

test('validate requires logoutUrl when logout redirect is on', async () => {
  const res = await validate(ctxOf([{ ...good, logoutEnabled: true }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_LOGOUT_URL'))
})

test('validate warns on a duplicate name', async () => {
  const res = await validate(ctxOf([good, { ...good, issuer: 'other' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

// --- _shared ----------------------------------------------------------------

test('normalizeBool coerces booleans and strings', () => {
  assert.equal(normalizeBool(true), true)
  assert.equal(normalizeBool('true'), true)
  assert.equal(normalizeBool('no'), false)
})

test('toStringList accepts arrays and comma strings, trims and de-dupes', () => {
  assert.deepEqual(toStringList(['a', ' b ', 'a']), ['a', 'b'])
  assert.deepEqual(toStringList('a, b ,,a'), ['a', 'b'])
})

test('buildSamlConfigurationBody nests onDemandProvisioningEnabled only when turned on', () => {
  const off = buildSamlConfigurationBody(good)
  assert.equal('onDemandProvisioningEnabled' in off, false)

  const on = buildSamlConfigurationBody({
    ...good,
    onDemandProvisioningEnabled: true,
    onDemandFirstNameAttribute: 'first',
    onDemandLastNameAttribute: 'last',
    onDemandProvisioningRoles: ['Analyst'],
  })
  assert.deepEqual(on.onDemandProvisioningEnabled, { firstNameAttribute: 'first', lastNameAttribute: 'last', onDemandProvisioningRoles: ['Analyst'] })
})

test('findSamlConfiguration matches by name case-insensitively', () => {
  const configs: SamlConfiguration[] = [{ id: '9', configurationName: 'Okta', issuer: 'x', x509cert1: 'y' }]
  assert.equal(findSamlConfiguration(configs, 'okta')?.id, '9')
  assert.equal(findSamlConfiguration(configs, 'missing'), null)
})
