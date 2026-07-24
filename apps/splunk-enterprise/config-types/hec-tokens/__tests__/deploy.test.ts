import deploy from '../deploy'
import { __setSplunkTransport } from '../../../lib/splunkApi'
import type { CanvasItemSnapshot, DeployContext } from '@veltrixsecops/app-sdk'

// =============================================================================
// HEC Token deploy — pre-flight index validation.
//
// splunkd rejects a token whose index does not exist on the target with a 400,
// and a raw failure mid-loop leaves a partial deploy. The deploy first fetches
// the target's live index list and fails fast with a precise, per-host message
// when a referenced index is missing — before creating any token.
// =============================================================================

interface RecordedCall {
  url: string
  method: string
}

let calls: RecordedCall[] = []

/**
 * Stub splunkd. `data/indexes` returns `indexNames`; every other GET 404s (the
 * token does not exist yet → getEntityContent null); every write succeeds. When
 * `indexNames` is null, the index list read itself fails (best-effort skip path).
 * Each test calls this first, so the transport is always freshly stubbed.
 */
function stubSplunk(indexNames: string[] | null): void {
  calls = []
  __setSplunkTransport(async (url, init) => {
    const method = init.method ?? 'GET'
    calls.push({ url, method })
    if (url.includes('/services/data/indexes')) {
      if (indexNames === null) return { ok: false, status: 500, text: async () => 'boom' }
      return { ok: true, status: 200, text: async () => JSON.stringify({ entry: indexNames.map((name) => ({ name })) }) }
    }
    if (method === 'GET') return { ok: false, status: 404, text: async () => 'not found' }
    return { ok: true, status: 200, text: async () => '{}' }
  })
}

function makeCtx(fields: Record<string, unknown>): DeployContext {
  const item: CanvasItemSnapshot = { name: 'item-1', fields }
  const sections = [item]
  return {
    appId: 'splunk-enterprise',
    customerId: 'cust-1',
    configTypeId: 'hec-tokens',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'HEC Tokens',
      toolType: 'splunk-enterprise',
      entityType: 'hec-tokens',
      items: sections,
      sections,
      snapshot: {},
    },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: {},
    platform: { getLatestDeployment: async () => null, listComponents: async () => [] },
    component: { id: 'comp-1', hostname: 'splunk-sh1.babong.local', port: '8089', type: ['search-head'], toolId: 'splunk' },
    credential: { id: 'cred-1', name: 'svc', username: 'admin', password: 'pw', apiToken: null, certificate: null },
    connectivity: {
      id: 'conn-1',
      status: 'CONNECTED',
      sshCommand: null,
      httpsUrl: 'https://splunk-sh1.babong.local:8089',
      tailscaleDeviceIP: null,
    },
    connectivityProvider: null,
    previousConfig: null,
    strategy: 'DIRECT',
  }
}

const HEC_CREATE_PATH = '/servicesNS/admin/splunk_httpinput/data/inputs/http'
const wroteToken = (): boolean => calls.some((c) => c.method === 'POST' && c.url.includes(HEC_CREATE_PATH))

describe('HEC deploy pre-flight index validation', () => {
  it('fails fast, before creating any token, when the default index is missing on the target', async () => {
    stubSplunk(['_dsappevent', '_configtracker'])
    const result = await deploy(makeCtx({ name: 'my_token', defaultIndex: 'main', enabled: true }))

    expect(result.success).toBe(false)
    expect(result.message).toContain("'main'")
    expect(result.message).toContain('splunk-sh1.babong.local')
    expect(result.message).toContain('_configtracker, _dsappevent') // available list, sorted
    expect(wroteToken()).toBe(false) // no token created
  })

  it('reports every missing index (defaultIndex + allowedIndexes) with plural phrasing', async () => {
    stubSplunk(['main'])
    const result = await deploy(
      makeCtx({ name: 'my_token', defaultIndex: 'main', allowedIndexes: ['main', 'nope', 'gone'] }),
    )

    expect(result.success).toBe(false)
    expect(result.message).toContain("'nope'")
    expect(result.message).toContain("'gone'")
    expect(result.message).toContain('do not exist') // plural
    expect(String(result.message).includes("'main'")).toBe(false) // main is valid, not flagged
  })

  it('proceeds with the deploy when every referenced index exists', async () => {
    stubSplunk(['main', 'security', 'network'])
    const result = await deploy(
      makeCtx({ name: 'my_token', defaultIndex: 'main', allowedIndexes: ['security'], enabled: true }),
    )

    expect(result.success).toBe(true)
    expect(wroteToken()).toBe(true) // created after validation passed
  })

  it('skips validation (best-effort) and proceeds when the index list cannot be read', async () => {
    stubSplunk(null) // data/indexes 500s
    const result = await deploy(makeCtx({ name: 'my_token', defaultIndex: 'main', enabled: true }))

    expect(result.success).toBe(true)
    expect(wroteToken()).toBe(true)
  })

  it('does not fetch the index list at all when no token references an index', async () => {
    stubSplunk(['main'])
    const result = await deploy(makeCtx({ name: 'my_token', enabled: true }))

    expect(result.success).toBe(true)
    expect(calls.some((c) => c.url.includes('/services/data/indexes'))).toBe(false)
  })
})
