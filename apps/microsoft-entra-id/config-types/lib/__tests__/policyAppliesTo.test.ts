import {
  applicationOrServicePrincipalOptions,
  buildPolicyTargetMaps,
  listPolicyAppliesTo,
  reconcilePolicyAppliesTo,
  resolvePolicyTarget,
  resolvePolicyTargets,
  type PolicyAppliesToEntry,
} from '../policyAppliesTo'
import { buildGraphClient } from '../../../lib/graph'

// --- Fetch mock ------------------------------------------------------------

interface Call {
  method: string
  url: string
  body?: unknown
}

function mockGraphFetch(responder: (method: string, url: string) => { status: number; body: unknown }): Call[] {
  const calls: Call[] = []
  globalThis.fetch = (async (url: unknown, init?: { method?: string; body?: string }) => {
    const u = String(url)
    const method = init?.method ?? 'GET'
    if (u.includes('login.microsoftonline.com')) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({ access_token: 'test-token', expires_in: 3600 }),
      }
    }
    calls.push({ method, url: u, body: init?.body ? JSON.parse(init.body) : undefined })
    const { status, body } = responder(method, u)
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      text: async () => JSON.stringify(body),
    }
  }) as unknown as typeof fetch
  return calls
}

function client() {
  return buildGraphClient(
    { tenantId: 'tenant-1', clientId: 'client-id', clientSecret: 'secret' },
    { timeoutMs: 5000, tenantId: 'tenant-1' }
  )
}

const baseCtx = {
  appId: 'microsoft-entra-id',
  customerId: 'cust-1',
  configTypeId: 'app-management-policies',
  source: 'applicationOrServicePrincipal',
  component: null,
  settings: { tenant_id: 'tenant-1' } as Record<string, unknown>,
  credential: { id: 'c1', name: 'Prod tenant', username: 'client-id', password: 'secret', apiToken: null, certificate: null },
}

const POLICY_ID = 'policy-1'
// GUID-shaped so the "picker-selected GUID passthrough" resolvePolicyTarget
// tests exercise the isGuid branch rather than the hand-typed-name branch.
const APP_ID = '11111111-1111-1111-1111-111111111111'
const SP_ID = '22222222-2222-2222-2222-222222222222'

describe('applicationOrServicePrincipalOptions', () => {
  it('merges applicationObjects (object id) + servicePrincipals, labelling each by kind', async () => {
    mockGraphFetch((_m, u) => {
      if (u.includes('/applications')) return { status: 200, body: { value: [{ id: APP_ID, appId: 'client-1', displayName: 'API App' }] } }
      if (u.includes('/servicePrincipals')) return { status: 200, body: { value: [{ id: SP_ID, appId: 'client-2', displayName: 'Deploy Bot' }] } }
      return { status: 404, body: {} }
    })
    const opts = await applicationOrServicePrincipalOptions(baseCtx)
    expect(opts).toEqual([
      { value: APP_ID, label: 'API App (application)', description: 'client-1' },
      { value: SP_ID, label: 'Deploy Bot (service principal)', description: 'client-2' },
    ])
  })
})

describe('resolvePolicyTarget / resolvePolicyTargets', () => {
  const maps = {
    appNameToId: new Map([['api app', APP_ID]]),
    appIds: new Set([APP_ID]),
    spNameToId: new Map([['deploy bot', SP_ID]]),
    spIds: new Set([SP_ID]),
  }
  const BOTH = ['application', 'servicePrincipal'] as const

  it('treats an empty value as unset, not missing', () => {
    expect(resolvePolicyTarget('', maps, BOTH)).toEqual({ target: null, missing: false })
  })

  it('passes a known application-object GUID through, classified by live id-set membership', () => {
    expect(resolvePolicyTarget(APP_ID, maps, BOTH)).toEqual({ target: { id: APP_ID, kind: 'application' }, missing: false })
  })

  it('passes a known service-principal GUID through, classified by live id-set membership', () => {
    expect(resolvePolicyTarget(SP_ID, maps, BOTH)).toEqual({ target: { id: SP_ID, kind: 'servicePrincipal' }, missing: false })
  })

  it('reports an unrecognized GUID as missing', () => {
    expect(resolvePolicyTarget('99999999-9999-9999-9999-999999999999', maps, BOTH)).toEqual({ target: null, missing: true })
  })

  it('resolves a hand-typed application display name', () => {
    expect(resolvePolicyTarget('API App', maps, BOTH)).toEqual({ target: { id: APP_ID, kind: 'application' }, missing: false })
  })

  it('resolves a hand-typed service-principal display name', () => {
    expect(resolvePolicyTarget('Deploy Bot', maps, BOTH)).toEqual({ target: { id: SP_ID, kind: 'servicePrincipal' }, missing: false })
  })

  it('reports an unresolved name as missing', () => {
    expect(resolvePolicyTarget('Ghost', maps, BOTH)).toEqual({ target: null, missing: true })
  })

  it('honors allowedKinds — an application-only field never resolves a service principal', () => {
    expect(resolvePolicyTarget(SP_ID, maps, ['application'])).toEqual({ target: null, missing: true })
    expect(resolvePolicyTarget('Deploy Bot', maps, ['application'])).toEqual({ target: null, missing: true })
  })

  it('resolves a batch, collecting missing names separately', () => {
    const r = resolvePolicyTargets(['API App', 'Deploy Bot', 'Ghost'], maps, BOTH)
    expect(r.targets).toEqual([
      { id: APP_ID, kind: 'application' },
      { id: SP_ID, kind: 'servicePrincipal' },
    ])
    expect(r.missing).toEqual(['Ghost'])
  })
})

describe('buildPolicyTargetMaps', () => {
  it('builds application-object and service-principal name/id maps from the live directory', async () => {
    mockGraphFetch((_m, u) => {
      if (u.includes('/applications')) return { status: 200, body: { value: [{ id: APP_ID, displayName: 'API App' }] } }
      if (u.includes('/servicePrincipals')) return { status: 200, body: { value: [{ id: SP_ID, displayName: 'Deploy Bot' }] } }
      return { status: 404, body: {} }
    })
    const maps = await buildPolicyTargetMaps(client())
    expect(maps.appNameToId.get('api app')).toBe(APP_ID)
    expect(maps.appIds.has(APP_ID)).toBe(true)
    expect(maps.spNameToId.get('deploy bot')).toBe(SP_ID)
    expect(maps.spIds.has(SP_ID)).toBe(true)
  })
})

describe('listPolicyAppliesTo', () => {
  it('classifies each target by its @odata.type discriminator', async () => {
    mockGraphFetch((_m, u) => {
      if (u.includes('/appliesTo')) {
        return {
          status: 200,
          body: {
            value: [
              { '@odata.type': '#microsoft.graph.application', id: APP_ID },
              { '@odata.type': '#microsoft.graph.servicePrincipal', id: SP_ID },
            ],
          },
        }
      }
      return { status: 404, body: {} }
    })
    const result = await listPolicyAppliesTo(client(), 'appManagementPolicies', POLICY_ID)
    expect(result.ok).toBe(true)
    expect(result.targets).toEqual([
      { id: APP_ID, kind: 'application' },
      { id: SP_ID, kind: 'servicePrincipal' },
    ])
  })

  it('drops an item whose @odata.type is unrecognized', async () => {
    mockGraphFetch(() => ({ status: 200, body: { value: [{ '@odata.type': '#microsoft.graph.group', id: 'g-1' }] } }))
    const result = await listPolicyAppliesTo(client(), 'appManagementPolicies', POLICY_ID)
    expect(result.targets).toEqual([])
  })
})

describe('reconcilePolicyAppliesTo', () => {
  it('assigns every desired target not already live, via POST {base}/{id}/{type}/$ref referencing the policy', async () => {
    const calls = mockGraphFetch((method, u) => {
      if (method === 'GET' && u.includes('/appliesTo')) return { status: 200, body: { value: [] } }
      if (method === 'POST') return { status: 204, body: {} }
      return { status: 404, body: {} }
    })
    const { entries, failures } = await reconcilePolicyAppliesTo(
      client(),
      'appManagementPolicies',
      POLICY_ID,
      [
        { id: APP_ID, kind: 'application' },
        { id: SP_ID, kind: 'servicePrincipal' },
      ],
      []
    )
    expect(failures).toEqual([])
    expect(entries).toEqual([
      { id: APP_ID, kind: 'application', existed: false },
      { id: SP_ID, kind: 'servicePrincipal', existed: false },
    ])
    const appPost = calls.find((c) => c.method === 'POST' && c.url.includes(`/applications/${APP_ID}/appManagementPolicies/$ref`))
    const spPost = calls.find((c) => c.method === 'POST' && c.url.includes(`/servicePrincipals/${SP_ID}/appManagementPolicies/$ref`))
    expect(appPost).toBeTruthy()
    expect(spPost).toBeTruthy()
    expect((appPost!.body as { '@odata.id'?: string })['@odata.id']).toContain(
      `policies/appManagementPolicies/${POLICY_ID}`
    )
  })

  it('does not re-assign a target that is already live', async () => {
    const calls = mockGraphFetch((method, u) => {
      if (method === 'GET' && u.includes('/appliesTo')) {
        return { status: 200, body: { value: [{ '@odata.type': '#microsoft.graph.application', id: APP_ID }] } }
      }
      return { status: 204, body: {} }
    })
    await reconcilePolicyAppliesTo(client(), 'appManagementPolicies', POLICY_ID, [{ id: APP_ID, kind: 'application' }], [])
    const postCalls = calls.filter((c) => c.method === 'POST')
    expect(postCalls).toHaveLength(0)
  })

  it('a target already live but untracked is treated as pre-existing (existed:true)', async () => {
    mockGraphFetch((method, u) =>
      method === 'GET' && u.includes('/appliesTo')
        ? { status: 200, body: { value: [{ '@odata.type': '#microsoft.graph.application', id: APP_ID }] } }
        : { status: 204, body: {} }
    )
    const { entries } = await reconcilePolicyAppliesTo(client(), 'appManagementPolicies', POLICY_ID, [{ id: APP_ID, kind: 'application' }], [])
    expect(entries).toEqual([{ id: APP_ID, kind: 'application', existed: true }])
  })

  it('removes ONLY assignments this app previously made (existed:false) that are no longer declared', async () => {
    const calls = mockGraphFetch((method, u) => {
      if (method === 'GET' && u.includes('/appliesTo')) {
        return {
          status: 200,
          body: {
            value: [
              { '@odata.type': '#microsoft.graph.application', id: APP_ID },
              { '@odata.type': '#microsoft.graph.servicePrincipal', id: SP_ID },
            ],
          },
        }
      }
      return { status: 204, body: {} }
    })
    const prior: PolicyAppliesToEntry[] = [
      { id: APP_ID, kind: 'application', existed: false }, // app-owned, no longer declared -> unassign
      { id: SP_ID, kind: 'servicePrincipal', existed: true }, // pre-existing -> leave alone
    ]
    const { entries } = await reconcilePolicyAppliesTo(client(), 'appManagementPolicies', POLICY_ID, [], prior)

    const deleteCalls = calls.filter((c) => c.method === 'DELETE')
    expect(deleteCalls).toHaveLength(1)
    expect(deleteCalls[0].url).toContain(`/applications/${APP_ID}/appManagementPolicies/${POLICY_ID}/$ref`)
    expect(entries).toEqual([])
  })

  it('leaves assignments unchanged and reports a failure when the live listing cannot be read', async () => {
    mockGraphFetch(() => ({ status: 500, body: { error: { message: 'boom' } } }))
    const prior: PolicyAppliesToEntry[] = [{ id: APP_ID, kind: 'application', existed: false }]
    const { entries, failures } = await reconcilePolicyAppliesTo(client(), 'appManagementPolicies', POLICY_ID, [{ id: SP_ID, kind: 'servicePrincipal' }], prior)
    expect(entries).toEqual(prior)
    expect(failures.length).toBeGreaterThan(0)
  })

  it('reports a per-target failure without throwing when an assign fails (e.g. the singleton-policy conflict Graph enforces)', async () => {
    mockGraphFetch((method, u) => {
      if (method === 'GET' && u.includes('/appliesTo')) return { status: 200, body: { value: [] } }
      if (method === 'POST') return { status: 400, body: { error: { code: 'Request_BadRequest', message: 'already has a different policy assigned' } } }
      return { status: 404, body: {} }
    })
    const { entries, failures } = await reconcilePolicyAppliesTo(client(), 'appManagementPolicies', POLICY_ID, [{ id: APP_ID, kind: 'application' }], [])
    expect(entries).toEqual([])
    expect(failures.some((f) => f.includes('already has a different policy assigned'))).toBe(true)
  })
})
