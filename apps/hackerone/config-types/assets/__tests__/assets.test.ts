import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  ASSET_TYPES,
  MAX_SEVERITIES,
  CIA_LEVELS,
  buildAssetCreateAttributes,
  buildAssetUpdateAttributes,
  assetWriteBody,
  archiveAssetsBody,
  groupItemsByOrganization,
  findOrganizationId,
  pickAssetByIdentifier,
  type AssetResource,
  type OrganizationResource,
} from '../_shared'
import type { CanvasItemSnapshot, PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift handlers apply over the HackerOne API via fetch,
 * which is impractical to mock here. Tests focus on validate.ts and the pure
 * _shared helpers (attribute building, identity matching, organization
 * resolution) — all network-free.
 */
function toItems(list: Array<Record<string, unknown>>): CanvasItemSnapshot[] {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.identifier ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  organization_handle: 'acme',
  identifier: 'api.example.com',
  asset_type: 'domain',
  description: 'Primary API host.',
  max_severity: 'critical',
  confidentiality_requirement: 'high',
  integrity_requirement: 'high',
  availability_requirement: 'medium',
  reference: 'CMDB-1234',
}

// --- validate -----------------------------------------------------------------

test('validate accepts a well-formed asset', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing organization handle', async () => {
  const res = await validate(ctxOf([{ ...good, organization_handle: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_ORGANIZATION'))
})

test('validate rejects a missing identifier', async () => {
  const res = await validate(ctxOf([{ ...good, identifier: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_IDENTIFIER'))
})

test('validate rejects an unknown asset type', async () => {
  const res = await validate(ctxOf([{ ...good, asset_type: 'ftp' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ASSET_TYPE'))
})

test('validate rejects an unknown max severity', async () => {
  const res = await validate(ctxOf([{ ...good, max_severity: 'urgent' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_MAX_SEVERITY'))
})

test('validate rejects "critical" as a CIA requirement level (severity-only value)', async () => {
  const res = await validate(ctxOf([{ ...good, confidentiality_requirement: 'critical' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_CIA_LEVEL'))
})

test('validate accepts every documented asset type, severity and CIA level', async () => {
  for (const asset_type of ASSET_TYPES) {
    const res = await validate(ctxOf([{ ...good, asset_type }]))
    assert.equal(res.valid, true, `expected asset_type ${asset_type} to be valid`)
  }
  for (const max_severity of MAX_SEVERITIES) {
    const res = await validate(ctxOf([{ ...good, max_severity }]))
    assert.equal(res.valid, true, `expected max_severity ${max_severity} to be valid`)
  }
  for (const level of CIA_LEVELS) {
    const res = await validate(ctxOf([{ ...good, confidentiality_requirement: level, integrity_requirement: level, availability_requirement: level }]))
    assert.equal(res.valid, true, `expected CIA level ${level} to be valid`)
  }
})

test('validate warns on a duplicate identifier within the same organization', async () => {
  const res = await validate(ctxOf([good, { ...good, description: 'copy' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_ASSET'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- buildAssetCreateAttributes / buildAssetUpdateAttributes --------------------

test('buildAssetCreateAttributes builds the full writable attribute set', () => {
  assert.deepEqual(buildAssetCreateAttributes(good), {
    asset_type: 'domain',
    identifier: 'api.example.com',
    description: 'Primary API host.',
    max_severity: 'critical',
    confidentiality_requirement: 'high',
    integrity_requirement: 'high',
    availability_requirement: 'medium',
    reference: 'CMDB-1234',
  })
})

test('buildAssetCreateAttributes defaults CIA/severity to none and nulls blank text', () => {
  const attrs = buildAssetCreateAttributes({ organization_handle: 'acme', identifier: 'x', asset_type: 'url' })
  assert.equal(attrs.max_severity, 'none')
  assert.equal(attrs.confidentiality_requirement, 'none')
  assert.equal(attrs.integrity_requirement, 'none')
  assert.equal(attrs.availability_requirement, 'none')
  assert.equal(attrs.description, null)
  assert.equal(attrs.reference, null)
})

test('buildAssetUpdateAttributes omits the immutable asset_type/identifier fields', () => {
  const attrs = buildAssetUpdateAttributes(good) as Record<string, unknown>
  assert.equal('asset_type' in attrs, false)
  assert.equal('identifier' in attrs, false)
  assert.equal(attrs.description, 'Primary API host.')
  assert.equal(attrs.max_severity, 'critical')
})

// --- assetWriteBody / archiveAssetsBody ------------------------------------------

test('assetWriteBody wraps attributes in a JSON:API document', () => {
  assert.deepEqual(assetWriteBody({ description: 'x' }), { data: { type: 'asset', attributes: { description: 'x' } } })
})

test('archiveAssetsBody builds the bulk archive request', () => {
  assert.deepEqual(archiveAssetsBody(['1', '2']), { data: [{ id: '1', type: 'asset' }, { id: '2', type: 'asset' }] })
})

// --- groupItemsByOrganization / findOrganizationId (lib/organizations) ----------

test('groupItemsByOrganization groups items by handle and skips blank handles', () => {
  const items = toItems([
    { organization_handle: 'acme', identifier: 'a' },
    { organization_handle: 'acme', identifier: 'b' },
    { organization_handle: 'globex', identifier: 'c' },
    { organization_handle: '', identifier: 'd' },
  ])
  const grouped = groupItemsByOrganization(items)
  assert.equal(grouped.get('acme')?.length, 2)
  assert.equal(grouped.get('globex')?.length, 1)
  assert.equal(grouped.has(''), false)
})

test('findOrganizationId resolves a handle to its id, case-insensitively', () => {
  const organizations: OrganizationResource[] = [
    { id: '9', type: 'organization', attributes: { handle: 'acme' } },
    { id: '10', type: 'organization', attributes: { handle: 'Globex' } },
  ]
  assert.equal(findOrganizationId(organizations, 'ACME'), '9')
  assert.equal(findOrganizationId(organizations, 'globex'), '10')
  assert.equal(findOrganizationId(organizations, 'missing'), null)
})

// --- pickAssetByIdentifier (lib/organizations) -----------------------------------

test('pickAssetByIdentifier matches case-insensitively among filtered results', () => {
  const assets: AssetResource[] = [
    { id: '2', type: 'asset', attributes: { asset_type: 'domain', identifier: 'API.example.com' } },
    { id: '3', type: 'asset', attributes: { asset_type: 'domain', identifier: 'other.example.com' } },
  ]
  assert.equal(pickAssetByIdentifier(assets, 'api.example.com')?.id, '2')
  assert.equal(pickAssetByIdentifier(assets, 'missing.example.com'), null)
})
