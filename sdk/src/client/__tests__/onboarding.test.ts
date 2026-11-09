import { afterEach, describe, expect, it, vi } from 'vitest'
import { completeOnboarding, fetchAppOnboarding, startOnboarding } from '../onboarding'

function mockFetch(response: { ok?: boolean; status?: number; jsonBody?: unknown; textBody?: string }) {
  const fetchMock = vi.fn(async () => ({
    ok: response.ok ?? true,
    status: response.status ?? 200,
    json: async () => response.jsonBody,
    text: async () => response.textBody ?? JSON.stringify(response.jsonBody ?? ''),
  })) as unknown as typeof fetch
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock as unknown as ReturnType<typeof vi.fn>
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('startOnboarding', () => {
  it('returns the pending descriptor for providers that never redirect back', async () => {
    const pending = { state: 's1', title: 'Create the role', instructions: ['a'], cliCommands: ['aws iam create-role'], openInNewTab: true, pollIntervalSeconds: 5, expiresInSeconds: 1800 }
    const fetchMock = mockFetch({ jsonBody: { authorizeUrl: '', provider: 'aws-assume-role', pending } })
    const out = await startOnboarding('cloud-governance', { environmentId: 'env', connectionName: 'Prod', settings: { aws_account_id: '123456789012' } })
    expect(out.pending).toEqual(pending)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/apps/cloud-governance/connections/onboard/start')
    expect(JSON.parse(String(init.body))).toEqual({ environmentId: 'env', connectionName: 'Prod', settings: { aws_account_id: '123456789012' } })
  })
})

describe('completeOnboarding', () => {
  it('POSTs the state and reports done on 200', async () => {
    const fetchMock = mockFetch({ jsonBody: { connectionId: 'c1', connectionName: 'Prod', manualStepsPending: false } })
    const out = await completeOnboarding('cloud-governance', 's1')
    expect(out).toEqual({ status: 'done', connectionId: 'c1', connectionName: 'Prod', manualStepsPending: false })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/apps/cloud-governance/connections/onboard/complete')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ state: 's1' })
  })

  it('maps 409 to pending and 410 to expired, carrying the server message', async () => {
    mockFetch({ ok: false, status: 409, jsonBody: { error: 'Waiting for the role', pending: true } })
    expect(await completeOnboarding('a', 's')).toEqual({ status: 'pending', message: 'Waiting for the role' })
    mockFetch({ ok: false, status: 410, jsonBody: { error: 'Session expired' } })
    expect(await completeOnboarding('a', 's')).toEqual({ status: 'expired', message: 'Session expired' })
  })

  it('throws on any other failure', async () => {
    mockFetch({ ok: false, status: 400, jsonBody: { error: 'could not assume role' } })
    await expect(completeOnboarding('a', 's')).rejects.toThrow('could not assume role')
  })
})

describe('fetchAppOnboarding', () => {
  it('returns the descriptor with description and setting labels', async () => {
    mockFetch({
      jsonBody: [
        { appId: 'cloud-governance', connection: { onboarding: { provider: 'aws-assume-role', label: 'Connect AWS account', description: 'Create a role.', requiredSettings: ['aws_account_id'], requiredSettingLabels: { aws_account_id: 'AWS account id' } } } },
      ],
    })
    expect(await fetchAppOnboarding('cloud-governance')).toMatchObject({ provider: 'aws-assume-role', description: 'Create a role.', requiredSettingLabels: { aws_account_id: 'AWS account id' } })
    expect(await fetchAppOnboarding('other')).toBeNull()
  })
})
