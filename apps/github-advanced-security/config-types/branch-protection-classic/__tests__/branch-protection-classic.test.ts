import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'
import { desiredFromItem, buildProtectionBody, restoreBody, normalizeActorSet, parseRepository, readEnabled } from '../_shared'

/**
 * Deploy/rollback/drift apply over the GitHub REST API via fetch, which is
 * impractical to mock here. Tests focus on validate.ts and _shared.ts, which are
 * pure and network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.branch ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  repository: 'octo-org/octo-repo',
  branch: 'main',
  require_status_checks: true,
  strict: true,
  contexts: ['ci/build'],
  require_pull_request_reviews: true,
  required_approving_review_count: 2,
  dismiss_stale_reviews: true,
  require_code_owner_reviews: true,
  dismissal_restrictions: '{"teams":["security"]}',
  bypass_pull_request_allowances: '',
  restrict_pushes: true,
  restrictions: '{"users":["octocat"],"teams":["release-managers"]}',
  enforce_admins: true,
}

// --- validate ---------------------------------------------------------------

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate rejects missing repository / branch', async () => {
  const res = await validate(ctxOf([{ repository: '', branch: '' }]))
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_REPOSITORY'))
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_BRANCH'))
})

test('validate accepts a good branch protection', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate warns on a duplicate (repository, branch)', async () => {
  const res = await validate(ctxOf([good, { ...good, comment: 'copy' }]))
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_BRANCH'))
})

test('validate rejects malformed restrictions JSON', async () => {
  const res = await validate(ctxOf([{ ...good, restrictions: '{bad' }]))
  assert.ok(res.errors.some((e) => e.code === 'INVALID_RESTRICTIONS_JSON'))
})

test('validate warns on zero required approvals and empty push restrictions', async () => {
  const res = await validate(ctxOf([{ ...good, required_approving_review_count: 0, restrictions: '' }]))
  assert.ok(res.warnings.some((w) => w.code === 'ZERO_REQUIRED_APPROVALS'))
  assert.ok(res.warnings.some((w) => w.code === 'RESTRICT_PUSHES_WITHOUT_ACTORS'))
})

// --- _shared ----------------------------------------------------------------

test('parseRepository / readEnabled behave as expected', () => {
  assert.deepEqual(parseRepository('a/b'), { owner: 'a', repo: 'b' })
  assert.equal(readEnabled(true), true)
  assert.equal(readEnabled({ enabled: false }), false)
  assert.equal(readEnabled(undefined), false)
})

test('normalizeActorSet handles write-shape strings and read-shape objects identically', () => {
  const fromStrings = normalizeActorSet({ users: ['octocat'], teams: ['sec'] })
  const fromObjects = normalizeActorSet({ users: [{ login: 'octocat' }], teams: [{ slug: 'sec' }] })
  assert.deepEqual(fromStrings, fromObjects)
})

test('buildProtectionBody sends null for disabled sections and full shape when enabled', () => {
  const { body, errors } = buildProtectionBody(desiredFromItem(good))
  assert.equal(errors.length, 0)
  assert.deepEqual(body.required_status_checks, { strict: true, contexts: ['ci/build'] })
  assert.equal((body.required_pull_request_reviews as Record<string, unknown>).required_approving_review_count, 2)
  assert.deepEqual((body.required_pull_request_reviews as Record<string, unknown>).dismissal_restrictions, { teams: ['security'] })
  assert.equal('bypass_pull_request_allowances' in (body.required_pull_request_reviews as Record<string, unknown>), false)
})

test('buildProtectionBody sends null when a section is turned off', () => {
  const { body } = buildProtectionBody(desiredFromItem({ ...good, require_status_checks: false, require_pull_request_reviews: false, restrict_pushes: false }))
  assert.equal(body.required_status_checks, null)
  assert.equal(body.required_pull_request_reviews, null)
  assert.equal(body.restrictions, null)
})

test('buildProtectionBody surfaces JSON errors', () => {
  const { errors } = buildProtectionBody(desiredFromItem({ ...good, restrictions: '{bad' }))
  assert.ok(errors.some((e) => e.startsWith('restrictions:')))
})

test('restoreBody projects rich live actor objects down to plain login/slug arrays', () => {
  const body = restoreBody({
    required_status_checks: { strict: true, contexts: ['ci'] },
    enforce_admins: { enabled: true },
    required_pull_request_reviews: {
      dismiss_stale_reviews: true,
      require_code_owner_reviews: false,
      required_approving_review_count: 1,
      require_last_push_approval: false,
      dismissal_restrictions: { teams: [{ slug: 'security' }] },
    },
    restrictions: { users: [{ login: 'octocat' }], teams: [{ slug: 'release-managers' }] },
  })
  assert.deepEqual(body.restrictions, { users: ['octocat'], teams: ['release-managers'], apps: [] })
  assert.equal(body.enforce_admins, true)
  assert.deepEqual((body.required_pull_request_reviews as Record<string, unknown>).dismissal_restrictions, { users: [], teams: ['security'], apps: [] })
})
