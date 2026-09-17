// ============================================================================
// driftDetect for Entra application registrations, against a fake Microsoft Graph.
//
// Drift here is a security signal: a redirect URI added out of band is a token
// exfiltration route, and an appRole flipped on grants callers a claim the
// canvas never declared. Two properties of the handler are worth pinning down
// beyond the diffs themselves — it compares a field only when the config
// DECLARES it (mirroring deploy, which only writes declared fields, so drift is
// never raised on something a re-deploy would not correct), and a TRUNCATED
// listing never becomes a false "absent", because an unfetched page cannot
// prove a registration is gone.
// ============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  collection,
  driftContext,
  graphError,
  item,
  leaksSecret,
  page,
  recordFetch,
  routeFetch,
  writeCalls,
} from '../../../lib/__tests__/fakeGraph'
import driftDetect from '../driftDetect'

const LIST = /\/applications\?\$select=id,displayName,uniqueName/
const USERS = /\/users\?\$select=/
const SPS = /\/servicePrincipals\?\$select=/
const OWNERS = /\/applications\/[^/]+\/owners/

/** A nextLink that matches LIST, so the fake keeps paging until the budget runs out. */
const ENDLESS = 'https://graph.microsoft.com/v1.0/applications?$select=id,displayName,uniqueName&$skiptoken=more'

const APP_ROLE = {
  allowedMemberTypes: ['User'],
  description: 'Read Contoso data',
  displayName: 'Reader',
  id: 'a0a0a0a0-0000-4000-8000-000000000001',
  isEnabled: true,
  value: 'Contoso.Read',
}

function liveApp(over: Record<string, unknown> = {}) {
  return {
    id: 'app-1',
    displayName: 'Contoso API',
    uniqueName: 'Contoso-API',
    signInAudience: 'AzureADMyOrg',
    identifierUris: [],
    web: { redirectUris: [] },
    spa: { redirectUris: [] },
    appRoles: [],
    requiredResourceAccess: [],
    groupMembershipClaims: null,
    tags: [],
    ...over,
  }
}

function appItem(fields: Record<string, unknown> = {}) {
  return item('Contoso API', { name: 'Contoso API', ...fields })
}

test('driftDetect makes no Graph call at all without a credential', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await driftDetect(driftContext([appItem()], { credential: null }))

    assert.deepEqual(result, { hasDrift: false, diffs: [], checked: false })
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('a failed listing reports no drift and writes nothing', async () => {
  const { calls, restore } = routeFetch([
    { url: LIST, respond: graphError(403, 'Insufficient privileges to complete the operation.') },
  ])
  try {
    const result = await driftDetect(driftContext([appItem()]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0, 'drift detection must never write')
  } finally {
    restore()
  }
})

test('reports no drift when the live registration matches the deployed canvas', async () => {
  const { calls, restore } = routeFetch([
    { url: LIST, respond: collection([liveApp({ web: { redirectUris: ['https://app.contoso.com/callback'] } })]) },
    { url: USERS, respond: collection([]) },
    { url: SPS, respond: collection([]) },
    { url: OWNERS, respond: collection([]) },
  ])
  try {
    const result = await driftDetect(
      driftContext([appItem({ redirectUris: 'https://app.contoso.com/callback' })]),
    )

    assert.deepEqual(result.diffs, [])
    assert.equal(result.hasDrift, false)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('a deleted registration is critical drift', async () => {
  const { restore } = routeFetch([
    { url: LIST, respond: collection([]) },
    { url: USERS, respond: collection([]) },
    { url: SPS, respond: collection([]) },
  ])
  try {
    const result = await driftDetect(driftContext([appItem()]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs, [
      { field: 'Contoso API', expected: 'present', actual: 'absent', severity: 'critical' },
    ])
  } finally {
    restore()
  }
})

test('an audience widened and a redirect URI swapped in the portal both surface', async () => {
  const { restore } = routeFetch([
    {
      url: LIST,
      respond: collection([
        liveApp({
          signInAudience: 'AzureADandPersonalMicrosoftAccount',
          web: { redirectUris: ['https://attacker.example/callback'] },
        }),
      ]),
    },
    { url: USERS, respond: collection([]) },
    { url: SPS, respond: collection([]) },
    { url: OWNERS, respond: collection([]) },
  ])
  try {
    const result = await driftDetect(
      driftContext([appItem({ redirectUris: 'https://app.contoso.com/callback' })]),
    )

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs, [
      {
        field: 'Contoso API.signInAudience',
        expected: 'AzureADMyOrg',
        actual: 'AzureADandPersonalMicrosoftAccount',
        severity: 'warning',
      },
      {
        field: 'Contoso API.redirectUris',
        expected: '["https://app.contoso.com/callback"]',
        actual: '["https://attacker.example/callback"]',
        severity: 'warning',
      },
    ])
    assert.equal(leaksSecret(result), false, 'diffs are persisted — they must not carry the token')
  } finally {
    restore()
  }
})

test('an appRole disabled in the portal is drift', async () => {
  const { restore } = routeFetch([
    { url: LIST, respond: collection([liveApp({ appRoles: [{ ...APP_ROLE, isEnabled: false }] })]) },
    { url: USERS, respond: collection([]) },
    { url: SPS, respond: collection([]) },
    { url: OWNERS, respond: collection([]) },
  ])
  try {
    const result = await driftDetect(driftContext([appItem({ appRoles: JSON.stringify([APP_ROLE]) })]))

    assert.deepEqual(result.diffs, [
      {
        field: 'Contoso API.appRoles',
        expected:
          '[{"allowedMemberTypes":["User"],"description":"Read Contoso data","displayName":"Reader","id":"a0a0a0a0-0000-4000-8000-000000000001","isEnabled":true,"value":"Contoso.Read"}]',
        actual:
          '[{"allowedMemberTypes":["User"],"description":"Read Contoso data","displayName":"Reader","id":"a0a0a0a0-0000-4000-8000-000000000001","isEnabled":false,"value":"Contoso.Read"}]',
        severity: 'warning',
      },
    ])
  } finally {
    restore()
  }
})

test('the read-only appRole origin Graph returns is not reported as drift', async () => {
  const { restore } = routeFetch([
    { url: LIST, respond: collection([liveApp({ appRoles: [{ ...APP_ROLE, origin: 'Application' }] })]) },
    { url: USERS, respond: collection([]) },
    { url: SPS, respond: collection([]) },
    { url: OWNERS, respond: collection([]) },
  ])
  try {
    const result = await driftDetect(driftContext([appItem({ appRoles: JSON.stringify([APP_ROLE]) })]))

    assert.deepEqual(result.diffs, [], 'origin is server-assigned and never written, so it cannot drift')
  } finally {
    restore()
  }
})

test('a field the canvas does not declare is left unmanaged, not flagged', async () => {
  const { restore } = routeFetch([
    { url: LIST, respond: collection([liveApp({ tags: ['HideApp'], identifierUris: ['api://legacy'] })]) },
    { url: USERS, respond: collection([]) },
    { url: SPS, respond: collection([]) },
    { url: OWNERS, respond: collection([]) },
  ])
  try {
    const result = await driftDetect(driftContext([appItem()]))

    assert.deepEqual(result.diffs, [], 'deploy would not correct these, so drift must not claim them')
  } finally {
    restore()
  }
})

test('a declared owner missing from the live app is drift', async () => {
  const { restore } = routeFetch([
    { url: LIST, respond: collection([liveApp()]) },
    { url: USERS, respond: collection([{ id: 'u-1', displayName: 'Ada Lovelace' }]) },
    { url: SPS, respond: collection([]) },
    { url: OWNERS, respond: collection([{ id: 'u-someone-else' }]) },
  ])
  try {
    const result = await driftDetect(driftContext([appItem({ owners: 'Ada Lovelace' })]))

    assert.deepEqual(result.diffs, [
      {
        field: 'Contoso API.owners',
        expected: '["u-1"]',
        actual: '["u-someone-else"]',
        severity: 'warning',
      },
    ])
  } finally {
    restore()
  }
})

test('an extra live owner alone is not drift', async () => {
  const { restore } = routeFetch([
    { url: LIST, respond: collection([liveApp()]) },
    { url: USERS, respond: collection([{ id: 'u-1', displayName: 'Ada Lovelace' }]) },
    { url: SPS, respond: collection([]) },
    { url: OWNERS, respond: collection([{ id: 'u-1' }, { id: 'u-extra' }]) },
  ])
  try {
    const result = await driftDetect(driftContext([appItem({ owners: 'Ada Lovelace' })]))

    assert.deepEqual(result.diffs, [], 'this app never revokes what it did not grant, so extras are not its drift')
  } finally {
    restore()
  }
})

test('an owner name that no longer resolves is critical drift, not a silent pass', async () => {
  const { restore } = routeFetch([
    { url: LIST, respond: collection([liveApp()]) },
    { url: USERS, respond: collection([]) },
    { url: SPS, respond: collection([]) },
    { url: OWNERS, respond: collection([]) },
  ])
  try {
    const result = await driftDetect(driftContext([appItem({ owners: 'Ghost Owner' })]))

    assert.deepEqual(result.diffs, [
      {
        field: 'Contoso API.owners',
        expected: 'resolvable',
        actual: 'unknown owner(s): Ghost Owner',
        severity: 'critical',
      },
    ])
  } finally {
    restore()
  }
})

test('a truncated listing never becomes a false "absent" — it reports the gap instead', async () => {
  // The page budget ran out with a nextLink still pending, so the declared app
  // may simply be on a page that was never fetched.
  const { calls, restore } = routeFetch([
    { url: LIST, respond: page([], ENDLESS) },
    { url: USERS, respond: collection([]) },
    { url: SPS, respond: collection([]) },
  ])
  try {
    const result = await driftDetect(driftContext([appItem()]))

    assert.equal(
      result.diffs.some((d) => d.actual === 'absent'),
      false,
      'an unfetched page cannot prove a registration is gone',
    )
    const gap = result.diffs.find((d) => d.field === '(directory listing)')
    assert.ok(gap, 'the incomplete listing itself has to be reported')
    assert.equal(gap.expected, 'complete')
    assert.equal(gap.severity, 'info')
    assert.match(String(gap.actual), /truncated/)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})
