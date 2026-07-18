import { describe, it, expect, vi, afterEach } from 'vitest'
import React from 'react'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { ByolInfrastructureDetail } from '../ByolInfrastructureDetail'
import type { ByolInfrastructure, ByolDeployment } from '../types'

// =============================================================================
// Failed-run primary action — "Retry deployment" vs "Retry Destroy".
//
// The detail view's header primary action offers to retry whatever failed.
// Historically it always reopened the DEPLOY plan (`openPlan`), which is
// correct when the last run was a deploy but wrong when the last run was a
// destroy (teardown) — clicking it would re-provision an environment the
// user was trying to tear down. The primary action must instead inspect the
// most recent deployment run's `action` (deployments are returned newest
// first — see listDeployments' `ORDER BY started_at DESC`) and, when it was
// a `destroy`, reopen the existing DestroyPlanModal flow instead.
// =============================================================================

const FAILED: ByolInfrastructure = {
  id: 'i1',
  name: 'BYOL001',
  deploymentType: 'distributed',
  indexerCount: 3,
  searchHeadCount: 2,
  status: 'failed',
  hosting_type: 'AWS',
  cloudProviderId: 'cp1',
  region: 'us-east-1',
}

function deployment(action: string, startedAt: string): ByolDeployment {
  return {
    id: `d-${action}-${startedAt}`,
    infrastructureId: 'i1',
    action,
    status: 'failed',
    message: null,
    startedAt,
    completedAt: null,
    steps: [],
  }
}

interface FetchCall {
  url: string
  method: string
}

/** Routes GET (infra/resources/deployments) vs the destroy/deploy POSTs, recording every call. */
function stubFetch(calls: FetchCall[], deployments: ByolDeployment[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      calls.push({ url, method })
      if (method === 'POST' && url.endsWith('/destroy')) {
        return { ok: true, status: 202, json: async () => ({ infrastructure: { ...FAILED, status: 'destroying' } }) }
      }
      if (method === 'POST' && url.endsWith('/deploy')) {
        return { ok: true, status: 202, json: async () => ({ infrastructure: { ...FAILED, status: 'provisioning' } }) }
      }
      if (url.endsWith('/plan')) {
        return { ok: true, status: 200, json: async () => ({ summary: { add: 0, change: 0, destroy: 0, noop: 0 }, groups: [] }) }
      }
      if (url.endsWith('/resources')) return { ok: true, status: 200, json: async () => [] }
      if (url.endsWith('/deployments')) return { ok: true, status: 200, json: async () => deployments }
      return { ok: true, status: 200, json: async () => FAILED }
    }) as unknown as typeof fetch,
  )
}

async function renderDetail() {
  render(
    <ByolInfrastructureDetail
      apiBase="/api/apps/x/byol"
      initialInfra={FAILED}
      onBack={() => {}}
      onEdit={() => {}}
      onDeleted={() => {}}
      onChanged={() => {}}
    />,
  )
  await waitFor(() => expect(screen.getByText('BYOL001')).toBeTruthy())
}

describe('Failed-run primary action', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('shows "Retry Destroy" (danger) and opens the destroy plan when the latest run was a destroy', async () => {
    const calls: FetchCall[] = []
    stubFetch(calls, [
      deployment('destroy', '2026-07-10T12:00:00Z'),
      deployment('deploy', '2026-07-01T12:00:00Z'),
    ])

    await renderDetail()

    const retryDestroy = await screen.findByRole('button', { name: 'Retry Destroy' })
    expect(screen.queryByRole('button', { name: 'Retry deployment' })).toBeNull()

    fireEvent.click(retryDestroy)
    // Opens the existing DestroyPlanModal flow (fresh resource fetch for the preview).
    await waitFor(() => expect(screen.getByText('Destroy infrastructure')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Destroy' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/destroy'))).toBe(true))
  })

  it('shows "Retry deployment" and opens the deploy plan when the latest run was a deploy', async () => {
    const calls: FetchCall[] = []
    stubFetch(calls, [
      deployment('deploy', '2026-07-10T12:00:00Z'),
      deployment('destroy', '2026-07-01T12:00:00Z'),
    ])

    await renderDetail()

    const retryDeploy = await screen.findByRole('button', { name: 'Retry deployment' })
    expect(screen.queryByRole('button', { name: 'Retry Destroy' })).toBeNull()

    fireEvent.click(retryDeploy)
    // Opens the existing ByolPlanModal flow (plan fetch, then Apply).
    await waitFor(() => expect(calls.some((c) => c.method === 'GET' && c.url.endsWith('/plan'))).toBe(true))
  })

  it('shows "Re-provision" for a deprovisioned environment and opens the deploy plan', async () => {
    const calls: FetchCall[] = []
    const DEPROV = { ...FAILED, status: 'deprovisioned' }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        const url = String(input)
        const method = init?.method ?? 'GET'
        calls.push({ url, method })
        if (url.endsWith('/plan')) return { ok: true, status: 200, json: async () => ({ summary: { add: 0, change: 0, destroy: 0, noop: 0 }, groups: [] }) }
        if (url.endsWith('/resources')) return { ok: true, status: 200, json: async () => [] }
        if (url.endsWith('/deployments')) return { ok: true, status: 200, json: async () => [deployment('destroy', '2026-07-10T12:00:00Z')] }
        return { ok: true, status: 200, json: async () => DEPROV }
      }) as unknown as typeof fetch,
    )
    render(
      <ByolInfrastructureDetail apiBase="/api/apps/x/byol" initialInfra={DEPROV} onBack={() => {}} onEdit={() => {}} onDeleted={() => {}} onChanged={() => {}} />,
    )
    await waitFor(() => expect(screen.getByText('BYOL001')).toBeTruthy())

    // Re-provision wins over the destroy-action retry (status isn't 'failed').
    const reprovision = await screen.findByRole('button', { name: 'Re-provision' })
    expect(screen.queryByRole('button', { name: 'Retry Destroy' })).toBeNull()
    fireEvent.click(reprovision)
    await waitFor(() => expect(calls.some((c) => c.method === 'GET' && c.url.endsWith('/plan'))).toBe(true))
  })

  it('falls back to "Retry deployment" when no deployment runs have loaded yet', async () => {
    const calls: FetchCall[] = []
    stubFetch(calls, [])

    await renderDetail()

    await screen.findByRole('button', { name: 'Retry deployment' })
    expect(screen.queryByRole('button', { name: 'Retry Destroy' })).toBeNull()
  })
})
