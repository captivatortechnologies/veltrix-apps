import test from 'node:test'
import assert from 'node:assert/strict'
import {
  NO_CONTENT,
  assertAuthenticatedFirst,
  bodyOf,
  collection,
  created,
  deployContext,
  graphError,
  item,
  leaksSecret,
  ok,
  recordFetch,
  routeFetch,
  writeCalls,
} from '../../../lib/__tests__/fakeGraph'
import deploy, { buildCreateBody, buildPatchBody } from '../deploy'
import type { AccessPackageSpec } from '../validate'
import type { DeployContext } from '@veltrixsecops/app-sdk'

const SPEC: AccessPackageSpec = {
  itemId: 'item-1',
  name: 'Sales reps',
  catalogId: 'Sales',
  description: 'outside sales representatives',
  isHidden: false,
}

describe('buildPatchBody / buildCreateBody', () => {
  it('builds the PATCH body from the spec', () => {
    expect(buildPatchBody(SPEC)).toEqual({
      displayName: 'Sales reps',
      description: 'outside sales representatives',
      isHidden: false,
    })
  })

  it('builds the POST body with only the catalog id, per the Graph create contract', () => {
    expect(buildCreateBody(SPEC, '66584aae-98bb-48cc-9458-7bee5d2a6577')).toEqual({
      displayName: 'Sales reps',
      description: 'outside sales representatives',
      isHidden: false,
      catalog: { id: '66584aae-98bb-48cc-9458-7bee5d2a6577' },
    })
  })
})

function mockGraphFetch(responder: (url: string) => { status: number; body: unknown }): void {
  globalThis.fetch = (async (url: unknown) => {
    const u = String(url)
    if (u.includes('login.microsoftonline.com')) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({ access_token: 'test-token', expires_in: 3600 }),
      }
    }
    const { status, body } = responder(u)
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      text: async () => JSON.stringify(body),
    }
  }) as unknown as typeof fetch
}

const CATALOG_ID = '66584aae-98bb-48cc-9458-7bee5d2a6577'

function baseCtx(items: Array<{ id?: string; fields: Record<string, unknown> }>): DeployContext {
  return {
    appId: 'microsoft-entra-id',
    customerId: 'cust-1',
    configTypeId: 'entitlement-access-packages',
    component: null,
    settings: { tenant_id: 'tenant-1' } as Record<string, unknown>,
    credential: { id: 'c1', name: 'Prod tenant', username: 'client-id', password: 'secret', apiToken: null, certificate: null },
    canvas: { canvasId: 'canvas-1', version: 1, items } as unknown as DeployContext['canvas'],
    platform: { getLatestDeployment: async () => null } as unknown as DeployContext['platform'],
  } as unknown as DeployContext
}

describe('deploy — catalogId is id-aware (GUID passthrough or hand-typed name resolution)', () => {
  it('resolves a hand-typed catalog display name via the live catalog list, then creates the package', async () => {
    mockGraphFetch((u) => {
      if (u.includes('/identityGovernance/entitlementManagement/catalogs')) {
        return { status: 200, body: { value: [{ id: CATALOG_ID, displayName: 'Sales' }] } }
      }
      if (u.includes('/identityGovernance/entitlementManagement/accessPackages')) {
        return { status: 200, body: { value: [] } }
      }
      return { status: 404, body: {} }
    })

    const result = await deploy(baseCtx([{ id: 'item-1', fields: { name: 'Sales reps', catalogId: 'Sales' } }]))
    expect(result.success).toBe(true)
  })

  it('fails clearly when the catalog cannot be resolved', async () => {
    mockGraphFetch((u) => {
      if (u.includes('/catalogs')) return { status: 200, body: { value: [] } }
      if (u.includes('/accessPackages')) return { status: 200, body: { value: [] } }
      return { status: 404, body: {} }
    })
    const result = await deploy(baseCtx([{ id: 'item-1', fields: { name: 'Sales reps', catalogId: 'Ghost Catalog' } }]))
    expect(result.success).toBe(false)
    expect(result.message).toContain('Ghost Catalog')
  })
})

// ============================================================================
// deploy, end to end against a fake Microsoft Graph.
//
// Everything above tests the exported body builders in isolation. What follows
// drives the DEFAULT export — the handler that creates and updates the access
// packages a directory's users request their entitlements through.
//
// `isHidden` is the only audience control this configuration type owns: a
// package written visible when the canvas said hidden is one every user in the
// directory can suddenly see and request. So the assertions below are about the
// bytes on the wire — which request, to which URL, carrying exactly what.
// ============================================================================

/** The catalog the canvas items below live in, as a picker-stored id. */
const CATALOG_GUID = '66584aae-98bb-48cc-9458-7bee5d2a6577'

const LIST = /accessPackages\?/
const CREATE = /accessPackages$/
const BY_ID = /accessPackages\/[^/?]+$/
const CATALOGS = /entitlementManagement\/catalogs\?/

/** A live access package matching the canvas item below, except where drifted. */
function livePackage(over: Record<string, unknown> = {}) {
  return { id: 'ap-1', displayName: 'Sales reps', description: 'Old description', isHidden: false, ...over }
}

function packageItem(fields: Record<string, unknown> = {}, id?: string) {
  return item(
    'Sales reps',
    { name: 'Sales reps', catalogId: CATALOG_GUID, description: 'Outside sales', isHidden: true, ...fields },
    id,
  )
}

test('deploy refuses without a credential instead of calling Graph', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([packageItem()], { credential: null }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /credential/i)
    assert.equal(calls.length, 0, 'must not reach Graph without a credential')
  } finally {
    restore()
  }
})

test('deploy refuses when the tenant id setting is missing', async () => {
  // Client-credentials has no token endpoint without the directory (tenant) id,
  // so this must fail closed BEFORE any network call, not half way through.
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([packageItem()], { settings: {} }))

    assert.equal(result.success, false)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('a failed access-package listing stops the deploy before it writes anything', async () => {
  const { calls, restore } = routeFetch([
    { url: CATALOGS, respond: collection([]) },
    { url: LIST, method: 'GET', respond: graphError(403, 'Insufficient privileges to complete the operation.') },
  ])
  try {
    const result = await deploy(deployContext([packageItem()]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Failed to list access packages/)
    assert.match(String(result.message), /Insufficient privileges/)
    assert.equal(
      writeCalls(calls).length,
      0,
      'a deploy that cannot see the live packages must not create or patch any',
    )
  } finally {
    restore()
  }
})

test('deploy authenticates first, then creates the package hidden exactly as declared', async () => {
  const { calls, restore } = routeFetch([
    { url: LIST, method: 'GET', respond: collection([]) },
    { url: CREATE, method: 'POST', respond: created({ id: 'ap-new' }) },
    { url: CATALOGS, respond: collection([]) },
  ])
  try {
    const result = await deploy(deployContext([packageItem()]))

    const graphCalls = assertAuthenticatedFirst(assert, calls)
    const write = graphCalls.find((c) => c.method === 'POST')
    assert.ok(write, 'expected a POST creating the access package')
    assert.ok(write.url.endsWith('/identityGovernance/entitlementManagement/accessPackages'))

    // The canvas said hidden. A package created visible is one the whole
    // directory can browse and request the moment it lands.
    assert.deepEqual(bodyOf(write), {
      displayName: 'Sales reps',
      description: 'Outside sales',
      isHidden: true,
      catalog: { id: CATALOG_GUID },
    })

    assert.equal(result.success, true)
    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.deepEqual(entries, [{ itemId: undefined, name: 'Sales reps', existed: false, id: 'ap-new' }])
    assert.equal(leaksSecret(result), false, 'the token must not reach the result or rollbackData')
  } finally {
    restore()
  }
})

test('a picker-stored catalog id is used verbatim, with no catalog lookup on the wire', async () => {
  const { calls, restore } = routeFetch([
    { url: LIST, method: 'GET', respond: collection([]) },
    { url: CREATE, method: 'POST', respond: created({ id: 'ap-new' }) },
    // A GUID must never be looked up — if the handler did, this empty catalog
    // listing would make it "missing" and the create would never happen.
    { url: CATALOGS, respond: collection([]) },
  ])
  try {
    const result = await deploy(deployContext([packageItem()]))

    assert.equal(result.success, true)
    const body = bodyOf(writeCalls(calls)[0])
    assert.deepEqual(body?.catalog, { id: CATALOG_GUID })
  } finally {
    restore()
  }
})

test('deploy updates a package that already exists and records its LIVE prior state', async () => {
  const live = livePackage()
  const { calls, restore } = routeFetch([
    { url: LIST, method: 'GET', respond: collection([live]) },
    { url: BY_ID, method: 'PATCH', respond: ok({}) },
    { url: CATALOGS, respond: collection([]) },
  ])
  try {
    const result = await deploy(deployContext([packageItem()]))

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1, 'an existing package is updated, not duplicated')
    assert.equal(writes[0].method, 'PATCH')
    assert.ok(writes[0].url.endsWith('/accessPackages/ap-1'))
    // The PATCH body never re-binds the catalog — Graph rejects that, and it
    // would silently move a package between delegated-admin boundaries.
    assert.deepEqual(bodyOf(writes[0]), {
      displayName: 'Sales reps',
      description: 'Outside sales',
      isHidden: true,
    })

    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries.length, 1)
    assert.equal(entries[0].existed, true)
    assert.equal(entries[0].id, 'ap-1')
    // Rollback has to restore what the tenant HAD, not what the canvas wanted:
    // the recorded prior is the live object's fields, visibility included.
    assert.deepEqual(entries[0].prior, {
      displayName: 'Sales reps',
      description: 'Old description',
      isHidden: false,
    })
    assert.notDeepEqual(entries[0].prior, bodyOf(writes[0]))
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('an unresolvable catalog name fails the item without writing a partial package', async () => {
  const { calls, restore } = routeFetch([
    { url: LIST, method: 'GET', respond: collection([]) },
    { url: CATALOGS, respond: collection([{ id: CATALOG_GUID, displayName: 'Sales' }]) },
  ])
  try {
    const result = await deploy(deployContext([packageItem({ catalogId: 'Ghost Catalog' })]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Ghost Catalog/)
    assert.equal(
      writeCalls(calls).length,
      0,
      'a package whose catalog cannot be resolved must not be written at all',
    )
  } finally {
    restore()
  }
})

test('deploy reports a rejected write rather than throwing, and leaks no secret', async () => {
  const { restore } = routeFetch([
    { url: LIST, method: 'GET', respond: collection([]) },
    { url: CREATE, method: 'POST', respond: graphError(400, 'Access package name must be unique.', 'BadRequest') },
    { url: CATALOGS, respond: collection([]) },
  ])
  try {
    const result = await deploy(deployContext([packageItem()]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /must be unique/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('deploy deletes a package it created earlier and the canvas no longer declares', async () => {
  const { calls, restore } = routeFetch([
    { url: LIST, method: 'GET', respond: collection([]) },
    { url: BY_ID, method: 'DELETE', respond: NO_CONTENT },
    { url: CATALOGS, respond: collection([]) },
  ])
  try {
    const result = await deploy(
      deployContext([], {
        priorRollbackData: {
          entries: [
            { name: 'Retired package', existed: false, id: 'ap-old' },
            { name: 'Pre-existing package', existed: true, id: 'ap-keep', prior: {} },
          ],
        },
      }),
    )

    const deletes = writeCalls(calls).filter((c) => c.method === 'DELETE')
    assert.equal(deletes.length, 1, 'only the package this app created may be deleted')
    assert.ok(deletes[0].url.endsWith('/accessPackages/ap-old'))
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})
