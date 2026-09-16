// =============================================================================
// The two handlers every Cortex XDR config type ships IDENTICALLY.
//
// All 12 config types compile the same healthCheck (a read-only reachability
// probe against POST /public_api/v1/endpoints/get_endpoint_groups/) and the same
// getStatus (platform records only, no vendor call). Twelve hand-copied test
// files would assert the same twelve things twelve times and drift apart the
// first time one of them changed, so the assertions live here once and each
// config type's `healthCheck.test.ts` / `getStatus.test.ts` passes in ITS OWN
// handler module — the module under test is still per-config-type, only the
// expectations are shared.
// =============================================================================

import type { ConfigStatus, HealthCheckResult, PipelineContext } from '@veltrixsecops/app-sdk'
import {
  API_KEY,
  API_KEY_ID,
  COMPLETED_AT,
  EMPTY_SECRET_CREDENTIAL,
  HEALTH_PATH,
  NO_KEY_ID_CREDENTIAL,
  STARTED_AT,
  TENANT_HOST,
  cortexError,
  cortexReply,
  healthContext,
  mentionsApiKey,
  pipelineContext,
  withFailingFetch,
  withFetch,
} from './fakeCortex'

type HealthCheckHandler = (ctx: never) => Promise<HealthCheckResult>
type GetStatusHandler = (ctx: PipelineContext) => Promise<ConfigStatus>

/**
 * The reachability-probe contract: refuse before touching the tenant when the
 * connection is not usable, carry the Standard-security headers on the very first
 * call, and never put the API Key in a check message.
 */
export function healthCheckSuite(configTypeId: string, healthCheck: HealthCheckHandler): void {
  const ctx = (opts: Record<string, unknown> = {}) =>
    healthContext({ configTypeId, ...opts }) as unknown as never

  describe(`cortex-xdr ${configTypeId} healthCheck handler`, () => {
    it('fails closed without a credential instead of probing the tenant', async () => {
      await withFetch([], async (calls) => {
        const result = await healthCheck(ctx({ credential: null }))

        expect(result.healthy).toBe(false)
        expect(result.score).toBe(0)
        expect(result.checks).toHaveLength(1)
        expect(result.checks[0].name).toBe('credential')
        expect(result.checks[0].passed).toBe(false)
        expect(calls).toHaveLength(0)
      })
    })

    it('fails closed when the credential carries no API Key value', async () => {
      await withFetch([], async (calls) => {
        const result = await healthCheck(ctx({ credential: EMPTY_SECRET_CREDENTIAL }))

        expect(result.healthy).toBe(false)
        expect(result.checks[0].name).toBe('credential')
        expect(result.checks[0].message).toMatch(/API Key/)
        expect(calls).toHaveLength(0)
      })
    })

    it('fails closed when the credential carries no API Key ID', async () => {
      // Cortex Standard auth needs BOTH halves; one alone is unusable.
      await withFetch([], async (calls) => {
        const result = await healthCheck(ctx({ credential: NO_KEY_ID_CREDENTIAL }))

        expect(result.healthy).toBe(false)
        expect(calls).toHaveLength(0)
      })
    })

    it('fails closed when the connection has no tenant API FQDN', async () => {
      await withFetch([], async (calls) => {
        const result = await healthCheck(ctx({ noHostname: true }))

        expect(result.healthy).toBe(false)
        expect(result.checks[0].message).toMatch(/FQDN/)
        expect(calls).toHaveLength(0)
      })
    })

    it('probes the tenant with the API key headers on its first call', async () => {
      await withFetch([cortexReply([])], async (calls) => {
        const result = await healthCheck(ctx())

        expect(calls).toHaveLength(1)
        expect(calls[0].method).toBe('POST')
        expect(calls[0].apiPath).toBe(HEALTH_PATH)
        expect(calls[0].url).toBe(`https://${TENANT_HOST}/public_api/v1${HEALTH_PATH}`)
        // Standard security: the key id and the key itself, the key sent verbatim.
        expect(calls[0].authId).toBe(API_KEY_ID)
        expect(calls[0].authorization).toBe(API_KEY)
        expect(result.healthy).toBe(true)
        expect(result.score).toBe(1)
        expect(result.checks[0].name).toBe('cortex_reachable')
        expect(result.checks[0].passed).toBe(true)
        expect(result.checks[0].latencyMs).toBeDefined()
      })
    })

    it('reports unhealthy when the tenant answers with a server error', async () => {
      await withFetch([cortexError('internal error', 500)], async () => {
        const result = await healthCheck(ctx())

        expect(result.healthy).toBe(false)
        expect(result.score).toBe(0)
        expect(result.checks[0].passed).toBe(false)
        expect(result.checks[0].message).toMatch(/HTTP 500/)
        expect(mentionsApiKey(result.checks[0].message)).toBe(false)
      })
    })

    it('reports unhealthy when the tenant rejects the API key', async () => {
      // The probe used to pass anything under 500, so an expired or de-scoped
      // key showed the connection green while every deploy against it failed.
      // Each healthCheck's own doc comment already said 401/403 mean the key
      // is bad; the condition did not.
      for (const status of [401, 403]) {
        await withFetch([cortexError('forbidden', status)], async () => {
          const result = await healthCheck(ctx())

          expect(result.healthy).toBe(false)
          expect(result.score).toBe(0)
          expect(result.checks[0].name).toBe('cortex_reachable')
          expect(result.checks[0].passed).toBe(false)
          expect(result.checks[0].message).toMatch(new RegExp(`HTTP ${status}`))
          expect(result.checks[0].message).toMatch(/API key/)
          // The remedy has to be nameable without leaking the key itself.
          expect(mentionsApiKey(result.checks[0].message)).toBe(false)
        })
      }
    })

    it('still counts a 4xx that is not an auth rejection as reachable', async () => {
      // 404 on the probe path means the tenant answered and authenticated us;
      // narrowing must not turn every 4xx into an outage.
      await withFetch([cortexError('not found', 404)], async () => {
        const result = await healthCheck(ctx())

        expect(result.checks[0].passed).toBe(true)
        expect(result.healthy).toBe(true)
      })
    })

    it('reports unhealthy rather than throwing when the tenant is unreachable', async () => {
      await withFailingFetch('ECONNREFUSED', async () => {
        const result = await healthCheck(ctx())

        expect(result.healthy).toBe(false)
        expect(result.score).toBe(0)
        expect(result.checks[0].passed).toBe(false)
        expect(result.checks[0].message).toMatch(/ECONNREFUSED/)
        expect(result.checks[0].latencyMs).toBeDefined()
        expect(mentionsApiKey(result.checks[0].message)).toBe(false)
      })
    })
  })
}

/**
 * The status contract: platform records only. getStatus must never reach the
 * vendor, and must date the report from the deployment that actually succeeded.
 */
export function getStatusSuite(configTypeId: string, getStatus: GetStatusHandler): void {
  const ctx = (opts: Record<string, unknown> = {}) => pipelineContext({ configTypeId, ...opts })

  describe(`cortex-xdr ${configTypeId} getStatus handler`, () => {
    it('reports not deployed when the canvas has never been deployed', async () => {
      await withFetch([], async (calls) => {
        const result = await getStatus(ctx({ latestDeployment: null }))

        expect(result.deployed).toBe(false)
        expect(result.version).toBe('1')
        expect(result.lastDeployedAt).toBe('')
        expect(result.componentStatuses).toHaveLength(0)
        // Status is read from platform records — it must not touch the tenant.
        expect(calls).toHaveLength(0)
      })
    })

    it('reports deployed, dated by the deployment that succeeded', async () => {
      await withFetch([], async (calls) => {
        const result = await getStatus(ctx({ latestDeployment: {} }))

        expect(result.deployed).toBe(true)
        expect(result.version).toBe('1')
        expect(result.lastDeployedAt).toBe(COMPLETED_AT)
        expect(calls).toHaveLength(0)
      })
    })

    it('falls back to the start time when the deployment never recorded a completion', async () => {
      const result = await getStatus(ctx({ latestDeployment: { completedAt: null } }))

      expect(result.deployed).toBe(true)
      expect(result.lastDeployedAt).toBe(STARTED_AT)
      // The per-component date has no fallback, so it stays blank rather than lying.
      expect(result.componentStatuses[0].lastDeployedAt).toBe('')
    })

    it('attributes the status to the tenant component it deploys through', async () => {
      const result = await getStatus(ctx({ latestDeployment: {} }))

      expect(result.componentStatuses).toHaveLength(1)
      expect(result.componentStatuses[0].componentId).toBe('comp-1')
      expect(result.componentStatuses[0].hostname).toBe(TENANT_HOST)
      expect(result.componentStatuses[0].deployed).toBe(true)
      expect(result.componentStatuses[0].version).toBe('1')
    })

    it('carries the health score through and calls 80+ healthy', async () => {
      const result = await getStatus(ctx({ latestDeployment: { healthScore: 80 } }))

      expect(result.componentStatuses[0].healthScore).toBe(80)
      expect(result.componentStatuses[0].healthy).toBe(true)
    })

    it('calls a score below 80 unhealthy', async () => {
      const result = await getStatus(ctx({ latestDeployment: { healthScore: 79 } }))

      expect(result.componentStatuses[0].healthScore).toBe(79)
      expect(result.componentStatuses[0].healthy).toBe(false)
    })

    it('leaves health unknown rather than false when no score was recorded', async () => {
      const result = await getStatus(ctx({ latestDeployment: { healthScore: null } }))

      expect(result.componentStatuses[0].healthScore).toBeUndefined()
      expect(result.componentStatuses[0].healthy).toBeUndefined()
    })

    it('reports no component statuses when the customer has no tenant component', async () => {
      const result = await getStatus(ctx({ latestDeployment: {}, components: [] }))

      expect(result.deployed).toBe(true)
      expect(result.componentStatuses).toHaveLength(0)
    })
  })
}
