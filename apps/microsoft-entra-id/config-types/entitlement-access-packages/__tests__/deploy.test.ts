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
