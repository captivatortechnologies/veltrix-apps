import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { accountIdentity, accountsFromList, buildCreateBody, findFunctionalAccount, toPlatformId } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * These handlers apply over the BeyondInsight REST API via node:https inside
 * beyondtrustApi, which is impractical to mock here. Tests focus on validate.ts
 * and the pure _shared helpers (identity, list-unwrap, create-body), which are
 * network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.accountName ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { platformId: 1, accountName: 'svc-backup', domainName: 'corp.example.com', displayName: 'Backup Service', description: 'Used by backups', elevationCommand: 'sudo' }

test('validate rejects a missing account name', async () => {
  const res = await validate(ctxOf([{ ...good, accountName: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_ACCOUNT_NAME'))
})

test('validate rejects a missing / non-positive platform id', async () => {
  for (const platformId of ['', 0, -3, 'abc', 1.5]) {
    const res = await validate(ctxOf([{ ...good, platformId }]))
    assert.equal(res.valid, false, `expected platformId ${platformId} to be invalid`)
    assert.ok(res.errors.some((e) => e.code === 'INVALID_PLATFORM_ID'))
  }
})

test('validate rejects an over-long account name', async () => {
  const res = await validate(ctxOf([{ ...good, accountName: 'a'.repeat(246) }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'ACCOUNT_NAME_TOO_LONG'))
})

test('validate rejects an unknown elevation command', async () => {
  const res = await validate(ctxOf([{ ...good, elevationCommand: 'doas' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ELEVATION'))
})

test('validate warns on a duplicate (platform, domain, account) identity', async () => {
  const res = await validate(ctxOf([good, { ...good, displayName: 'Copy' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_ACCOUNT'))
})

test('validate treats same account on a different platform as distinct', async () => {
  const res = await validate(ctxOf([good, { ...good, platformId: 4 }]))
  assert.equal(res.valid, true)
  assert.equal(res.warnings.length, 0)
})

test('validate accepts a good account for each elevation command', async () => {
  for (const elevationCommand of ['', 'sudo', 'pbrun', 'pmrun']) {
    const res = await validate(ctxOf([{ ...good, elevationCommand }]))
    assert.equal(res.valid, true, `expected elevation ${elevationCommand || '(none)'} to be valid`)
    assert.equal(res.errors.length, 0)
  }
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('toPlatformId coerces positive integers and rejects the rest', () => {
  assert.equal(toPlatformId(1), 1)
  assert.equal(toPlatformId('4'), 4)
  assert.equal(toPlatformId(0), null)
  assert.equal(toPlatformId(-1), null)
  assert.equal(toPlatformId(2.5), null)
  assert.equal(toPlatformId(''), null)
  assert.equal(toPlatformId(undefined), null)
})

test('accountsFromList unwraps arrays and paginated containers', () => {
  assert.equal(accountsFromList([{ AccountName: 'a' }]).length, 1)
  assert.equal(accountsFromList({ Data: [{ AccountName: 'a' }, { AccountName: 'b' }] }).length, 2)
  assert.equal(accountsFromList(null).length, 0)
})

test('findFunctionalAccount matches on the (platform, domain, account) triple, case-insensitively', () => {
  const live = [
    { FunctionalAccountID: 10, PlatformID: 1, DomainName: 'corp.example.com', AccountName: 'svc-backup' },
    { FunctionalAccountID: 11, PlatformID: 4, DomainName: '', AccountName: 'root' },
  ]
  assert.equal(findFunctionalAccount(live, 1, 'CORP.EXAMPLE.COM', 'SVC-Backup')?.FunctionalAccountID, 10)
  assert.equal(findFunctionalAccount(live, 4, '', 'root')?.FunctionalAccountID, 11)
  assert.equal(findFunctionalAccount(live, 1, '', 'svc-backup'), null)
  assert.equal(findFunctionalAccount(live, 99, 'corp.example.com', 'svc-backup'), null)
})

test('accountIdentity is stable across casing and blank domains', () => {
  assert.equal(accountIdentity(1, 'Corp', 'Svc'), accountIdentity(1, 'corp', 'svc'))
  assert.notEqual(accountIdentity(1, '', 'svc'), accountIdentity(2, '', 'svc'))
})

test('buildCreateBody omits blank optional fields and keeps the required ones', () => {
  const body = buildCreateBody({ platformId: 1, accountName: 'svc', domainName: '', displayName: '', description: '', elevationCommand: '', password: '' })
  assert.deepEqual(body, { PlatformID: 1, AccountName: 'svc' })

  const full = buildCreateBody({ platformId: '4', accountName: 'root', domainName: 'd', displayName: 'Root', description: 'desc', elevationCommand: 'sudo', password: 's3cret' })
  assert.deepEqual(full, { PlatformID: 4, AccountName: 'root', DomainName: 'd', DisplayName: 'Root', Description: 'desc', ElevationCommand: 'sudo', Password: 's3cret' })
})
