import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildAssetScopeAttributes,
  buildNotifyFlag,
  createAssetScopeBody,
  updateAssetScopeBody,
  archiveAssetScopeBody,
  groupItemsByOrganization,
  findOrganizationId,
  findProgramId,
  pickAssetByIdentifier,
  scopesByIdentifier,
  normalizeIdentifier,
  type OrganizationResource,
  type ProgramResource,
  type AssetResource,
  type LiveScope,
} from '../_shared'
import type { CanvasItemSnapshot, PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift handlers apply over the HackerOne API via fetch,
 * which is impractical to mock here. Tests focus on validate.ts and the pure
 * _shared helpers (attribute building, write-body shape, identity resolution) —
 * all network-free.
 */
function toItems(list: Array<Record<string, unknown>>): CanvasItemSnapshot[] {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.asset_identifier ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  organization_handle: 'acme',
  program_handle: 'acme-program',
  asset_identifier: 'api.example.com',
  eligible_for_submission: true,
  eligible_for_bounty: true,
  instruction: 'Test the public API only.',
  notify_subscribers_on_changes: true,
}

// --- validate -----------------------------------------------------------------

test('validate accepts a well-formed asset scope', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing organization handle', async () => {
  const res = await validate(ctxOf([{ ...good, organization_handle: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_ORGANIZATION'))
})

test('validate rejects a missing program handle', async () => {
  const res = await validate(ctxOf([{ ...good, program_handle: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_PROGRAM'))
})

test('validate rejects a missing asset identifier', async () => {
  const res = await validate(ctxOf([{ ...good, asset_identifier: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_IDENTIFIER'))
})

test('validate warns on a duplicate attachment within the same organization+program', async () => {
  const res = await validate(ctxOf([good, { ...good, instruction: 'copy' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_ASSET_SCOPE'))
})

test('validate does not flag the same asset attached under a different program', async () => {
  const res = await validate(ctxOf([good, { ...good, program_handle: 'other-program' }]))
  assert.equal(res.valid, true)
  assert.ok(!res.warnings.some((w) => w.code === 'DUPLICATE_ASSET_SCOPE'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- buildAssetScopeAttributes / buildNotifyFlag --------------------------------

test('buildAssetScopeAttributes builds the shared eligibility/instruction set', () => {
  assert.deepEqual(buildAssetScopeAttributes(good), {
    eligible_for_submission: true,
    eligible_for_bounty: true,
    instruction: 'Test the public API only.',
  })
})

test('buildAssetScopeAttributes defaults eligibility and nulls empty instruction', () => {
  const attrs = buildAssetScopeAttributes({ asset_identifier: 'x' })
  assert.equal(attrs.eligible_for_submission, true) // defaults to true
  assert.equal(attrs.eligible_for_bounty, false) // defaults to false
  assert.equal(attrs.instruction, null)
})

test('buildNotifyFlag reads the declared notify flag, defaulting to false', () => {
  assert.equal(buildNotifyFlag(good), true)
  assert.equal(buildNotifyFlag({}), false)
})

// --- createAssetScopeBody / updateAssetScopeBody / archiveAssetScopeBody --------

test('createAssetScopeBody uses "notify_subscribers_on_changes" and a programs relationship', () => {
  const body = createAssetScopeBody({ eligible_for_submission: true, eligible_for_bounty: false, instruction: null }, true, '55')
  assert.deepEqual(body, {
    data: {
      type: 'structured-scope',
      attributes: { eligible_for_submission: true, eligible_for_bounty: false, instruction: null, notify_subscribers_on_changes: true },
    },
    relationships: { programs: { data: [{ id: '55', type: 'program' }] } },
  })
})

test('updateAssetScopeBody uses "notify_subscribers_of_changes" and no relationships', () => {
  const body = updateAssetScopeBody({ eligible_for_submission: false, eligible_for_bounty: true, instruction: 'x' }, false)
  assert.deepEqual(body, {
    data: {
      type: 'structured-scope',
      attributes: { eligible_for_submission: false, eligible_for_bounty: true, instruction: 'x', notify_subscribers_of_changes: false },
    },
  })
  assert.ok(!('relationships' in body))
})

test('archiveAssetScopeBody builds the bulk archive request keyed by program id', () => {
  assert.deepEqual(archiveAssetScopeBody(['10', '20']), { data: [{ id: '10', type: 'program' }, { id: '20', type: 'program' }] })
})

// --- groupItemsByOrganization / findOrganizationId / findProgramId --------------

test('groupItemsByOrganization groups items by handle and skips blank handles', () => {
  const items = toItems([
    { organization_handle: 'acme', asset_identifier: 'a' },
    { organization_handle: 'acme', asset_identifier: 'b' },
    { organization_handle: '', asset_identifier: 'c' },
  ])
  const grouped = groupItemsByOrganization(items)
  assert.equal(grouped.get('acme')?.length, 2)
  assert.equal(grouped.has(''), false)
})

test('findOrganizationId and findProgramId resolve handles to ids, case-insensitively', () => {
  const organizations: OrganizationResource[] = [{ id: '9', type: 'organization', attributes: { handle: 'acme' } }]
  const programs: ProgramResource[] = [{ id: '101', type: 'program', attributes: { handle: 'acme-program', name: 'Acme' } }]
  assert.equal(findOrganizationId(organizations, 'ACME'), '9')
  assert.equal(findProgramId(programs, 'Acme-Program'), '101')
})

// --- pickAssetByIdentifier / scopesByIdentifier ----------------------------------

test('pickAssetByIdentifier matches case-insensitively', () => {
  const assets: AssetResource[] = [{ id: '2', type: 'asset', attributes: { asset_type: 'domain', identifier: 'API.example.com' } }]
  assert.equal(pickAssetByIdentifier(assets, 'api.example.com')?.id, '2')
  assert.equal(pickAssetByIdentifier(assets, 'missing.example.com'), null)
})

test('scopesByIdentifier indexes existing structured scopes by normalized asset_identifier', () => {
  const scopes: LiveScope[] = [{ id: '7', type: 'structured-scope', attributes: { asset_identifier: 'API.example.com' } }]
  const map = scopesByIdentifier(scopes)
  assert.equal(map.get(normalizeIdentifier('api.example.com'))?.id, '7')
})
