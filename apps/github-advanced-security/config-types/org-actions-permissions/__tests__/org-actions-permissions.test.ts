import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'
import {
  desiredFromItem,
  buildPermissionsBody,
  buildSelectedRepositoriesBody,
  buildAllowedActionsBody,
  buildWorkflowBody,
  parseIdList,
  toStringArray,
} from '../_shared'

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
  enabled_repositories: 'selected',
  selected_repository_ids: '1, 2, 3',
  allowed_actions: 'selected',
  github_owned_allowed: true,
  verified_allowed: true,
  patterns_allowed: ['docker/*'],
  sha_pinning_required: true,
  default_workflow_permissions: 'write',
  can_approve_pull_request_reviews: true,
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

test('validate rejects invalid enums', async () => {
  const res = await validate(ctxOf([{ ...good, enabled_repositories: 'some', allowed_actions: 'any', default_workflow_permissions: 'admin' }]))
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ENABLED_REPOSITORIES'))
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ALLOWED_ACTIONS'))
  assert.ok(res.errors.some((e) => e.code === 'INVALID_WORKFLOW_PERMISSIONS'))
})

test('validate warns when selected repositories has no ids', async () => {
  const res = await validate(ctxOf([{ ...good, selected_repository_ids: '' }]))
  assert.ok(res.warnings.some((w) => w.code === 'SELECTED_REPOSITORIES_WITHOUT_IDS'))
})

test('validate warns when selected actions allows nothing', async () => {
  const res = await validate(ctxOf([{ ...good, github_owned_allowed: false, verified_allowed: false, patterns_allowed: [] }]))
  assert.ok(res.warnings.some((w) => w.code === 'SELECTED_ACTIONS_WITHOUT_ANY_ALLOWANCE'))
})

// --- _shared ----------------------------------------------------------------

test('parseIdList and toStringArray parse tolerant input', () => {
  assert.deepEqual(parseIdList('1, 2  3'), [1, 2, 3])
  assert.deepEqual(toStringArray('a, b\nc'), ['a', 'b', 'c'])
  assert.deepEqual(toStringArray(['x', 'y']), ['x', 'y'])
})

test('desiredFromItem reads every field', () => {
  const d = desiredFromItem(good)
  assert.equal(d.org, 'octo-org')
  assert.equal(d.enabledRepositories, 'selected')
  assert.deepEqual(d.selectedRepositoryIds, [1, 2, 3])
  assert.equal(d.shaPinningRequired, true)
  assert.equal(d.defaultWorkflowPermissions, 'write')
})

test('build*Body functions produce the exact GitHub request shapes', () => {
  const d = desiredFromItem(good)
  assert.deepEqual(buildPermissionsBody(d), { enabled_repositories: 'selected', allowed_actions: 'selected', sha_pinning_required: true })
  assert.deepEqual(buildSelectedRepositoriesBody(d), { selected_repository_ids: [1, 2, 3] })
  assert.deepEqual(buildAllowedActionsBody(d), { github_owned_allowed: true, verified_allowed: true, patterns_allowed: ['docker/*'] })
  assert.deepEqual(buildWorkflowBody(d), { default_workflow_permissions: 'write', can_approve_pull_request_reviews: true })
})
