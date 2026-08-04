import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'
import { desiredFromItem, buildOrgPatch, normalizeBool } from '../_shared'

/**
 * Deploy/rollback/drift apply over the GitHub REST API via fetch, which is
 * impractical to mock here. Tests focus on validate.ts and _shared.ts, which are
 * pure and network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.org ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  org: 'octo-org',
  default_repository_permission: 'write',
  members_can_create_repositories: true,
  members_can_create_public_repositories: false,
  members_can_create_private_repositories: true,
  members_can_create_internal_repositories: true,
  members_can_fork_private_repositories: false,
  members_can_create_pages: true,
  members_can_create_public_pages: false,
  members_can_create_private_pages: true,
  members_can_delete_repositories: false,
  members_can_delete_issues: false,
  web_commit_signoff_required: true,
}

// --- validate ---------------------------------------------------------------

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate rejects a missing org', async () => {
  const res = await validate(ctxOf([{ ...good, org: '' }]))
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_ORG'))
})

test('validate accepts a good policy', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate warns on a duplicate org', async () => {
  const res = await validate(ctxOf([good, { ...good }]))
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_ORG'))
})

test('validate rejects an invalid default permission', async () => {
  const res = await validate(ctxOf([{ ...good, default_repository_permission: 'superadmin' }]))
  assert.ok(res.errors.some((e) => e.code === 'INVALID_DEFAULT_PERMISSION'))
})

test('validate warns when creation master switch is off but sub-flags are on', async () => {
  const res = await validate(ctxOf([{ ...good, members_can_create_repositories: false, members_can_create_private_repositories: true }]))
  assert.ok(res.warnings.some((w) => w.code === 'CREATE_REPOSITORIES_MASTER_SWITCH_OFF'))
})

// --- _shared ----------------------------------------------------------------

test('normalizeBool applies the fallback for missing values', () => {
  assert.equal(normalizeBool(undefined, true), true)
  assert.equal(normalizeBool(undefined, false), false)
  assert.equal(normalizeBool(false, true), false)
  assert.equal(normalizeBool('true', false), true)
})

test('desiredFromItem reads identity + every privilege flag', () => {
  const d = desiredFromItem(good)
  assert.equal(d.org, 'octo-org')
  assert.equal(d.defaultRepositoryPermission, 'write')
  assert.equal(d.members_can_create_public_repositories, false)
  assert.equal(d.web_commit_signoff_required, true)
})

test('buildOrgPatch produces the exact PATCH /orgs/{org} body', () => {
  const body = buildOrgPatch(desiredFromItem(good))
  assert.equal(body.default_repository_permission, 'write')
  assert.equal(body.members_can_create_public_repositories, false)
  assert.equal(body.web_commit_signoff_required, true)
  assert.equal('members_allowed_repository_creation_type' in body, false)
})
