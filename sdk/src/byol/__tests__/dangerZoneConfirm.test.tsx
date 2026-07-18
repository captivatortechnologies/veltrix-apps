import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { HOST_RUNTIME_GLOBAL } from '../../client'
import { ByolInfrastructureDetail } from '../ByolInfrastructureDetail'
import type { ByolInfrastructure, ByolResource } from '../types'
import type { ConfirmationOptions } from '../../ui'

// =============================================================================
// Danger-zone confirmations (Destroy / Delete).
//
// Delete still goes through the SDK's shared useConfirmDialog hook, which
// delegates to the platform's real (portaled, themed) confirmation dialog
// inside Veltrix and fails closed (resolves false, no native dialog) outside
// it. Since useConfirmDialog's actual dialog UI (render, Escape-to-cancel,
// backdrop click) is the HOST's implementation — already covered by
// sdk/src/ui/__tests__/ui.test.tsx — these tests assert the CONSUMER
// contract: the view calls confirm() with the right title/message/variant,
// proceeds only when it resolves true, does nothing on cancel/false, and
// never touches window.confirm/alert directly.
//
// Destroy no longer uses a generic yes/no text confirmation at all — it opens
// DestroyPlanModal (a Terraform-style destroy plan, mirroring the Apply-plan
// modal) showing exactly what will be torn down. Like the Apply-plan modal,
// it is a self-contained in-app Modal with its own working fallback outside
// the platform (see planModal.test.tsx) — so, unlike Delete, it does not rely
// on / fail closed with useConfirmDialog. These tests assert: opening it
// fetches + previews the current resources, only POSTs /destroy when the
// user clicks the modal's own danger Destroy button, and never touches
// window.confirm/alert.
// =============================================================================

const RUNNING: ByolInfrastructure = {
  id: 'i1',
  name: 'BYOL001',
  deploymentType: 'distributed',
  indexerCount: 3,
  searchHeadCount: 2,
  status: 'running',
  hosting_type: 'AWS',
  cloudProviderId: 'cp1',
  region: 'us-east-1',
}

const RESOURCES: ByolResource[] = [
  {
    id: 'r1',
    infrastructureId: 'i1',
    tier: 'data',
    kind: 'indexer',
    name: 'Indexer peer 1',
    role: 'peer',
    region: 'us-east-1',
    status: 'ready',
    externalRef: 'i-1',
    message: null,
    planKey: 'data/indexer-1',
    sortOrder: 0,
  },
]

interface FetchCall {
  url: string
  method: string
}

function installFakeHostWithConfirm(confirmImpl: (options: ConfirmationOptions) => Promise<boolean>) {
  const confirm = vi.fn(confirmImpl)
  const ui: Record<string, unknown> = {
    useConfirmDialog: () => ({ confirm }),
  }
  ;(globalThis as Record<string, unknown>)[HOST_RUNTIME_GLOBAL] = {
    react: React,
    authFetch: (input: string, init?: RequestInit) => fetch(input, init),
    AppContext: React.createContext(null),
    sdk: {},
    ui,
  }
  return confirm
}

function uninstallHost() {
  delete (globalThis as Record<string, unknown>)[HOST_RUNTIME_GLOBAL]
}

/** Routes GET (infra/resources/deployments) vs the destroy POST / delete DELETE, recording every call. */
function stubFetch(calls: FetchCall[], resources: ByolResource[] = []) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      calls.push({ url, method })
      if (method === 'POST' && url.endsWith('/destroy')) {
        return { ok: true, status: 202, json: async () => ({ infrastructure: { ...RUNNING, status: 'destroying' } }) }
      }
      if (method === 'DELETE') {
        return { ok: true, status: 204, json: async () => ({}) }
      }
      if (url.endsWith('/resources')) return { ok: true, status: 200, json: async () => resources }
      if (url.endsWith('/deployments')) return { ok: true, status: 200, json: async () => [] }
      return { ok: true, status: 200, json: async () => RUNNING }
    }) as unknown as typeof fetch,
  )
}

async function renderOnSettings(props: Partial<React.ComponentProps<typeof ByolInfrastructureDetail>> = {}) {
  const onDeleted = props.onDeleted ?? vi.fn()
  const onChanged = props.onChanged ?? vi.fn()
  render(
    <ByolInfrastructureDetail
      apiBase="/api/apps/x/byol"
      initialInfra={RUNNING}
      onBack={() => {}}
      onEdit={() => {}}
      onDeleted={onDeleted}
      onChanged={onChanged}
      {...props}
    />,
  )
  await waitFor(() => expect(screen.getByTitle('Settings')).toBeTruthy())
  fireEvent.click(screen.getByTitle('Settings'))
  await waitFor(() => expect(screen.getByText('Destroy infrastructure')).toBeTruthy())
  return { onDeleted, onChanged }
}

describe('Danger zone — Destroy / Delete confirmation', () => {
  // `vi.spyOn`'s overloaded generic return type doesn't narrow cleanly to a
  // hoisted `let` — these are only ever used for mockRestore()/toHaveBeenCalled().
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let windowConfirmSpy: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let windowAlertSpy: any

  beforeEach(() => {
    windowConfirmSpy = vi.spyOn(window, 'confirm').mockImplementation(() => {
      throw new Error('window.confirm() must not be called — use the shared confirmation dialog instead')
    })
    windowAlertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {
      throw new Error('window.alert() must not be called — use the shared confirmation dialog instead')
    })
  })

  afterEach(() => {
    windowConfirmSpy.mockRestore()
    windowAlertSpy.mockRestore()
    uninstallHost()
    vi.unstubAllGlobals()
  })

  it('never calls the native window.confirm/alert dialogs for Destroy or Delete', async () => {
    const calls: FetchCall[] = []
    stubFetch(calls, RESOURCES)
    installFakeHostWithConfirm(async () => true)

    await renderOnSettings()
    fireEvent.click(screen.getByText('Destroy infrastructure'))
    await waitFor(() => expect(screen.getByText('Indexer peer 1')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Destroy' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/destroy'))).toBe(true))

    expect(windowConfirmSpy).not.toHaveBeenCalled()
    expect(windowAlertSpy).not.toHaveBeenCalled()
  })

  it('Destroy: opens the destroy plan showing every current resource, and only POSTs /destroy when confirmed in the modal', async () => {
    const calls: FetchCall[] = []
    stubFetch(calls, RESOURCES)

    await renderOnSettings()
    fireEvent.click(screen.getByText('Destroy infrastructure'))

    // Fetches a fresh resource list to build the destroy preview.
    await waitFor(() => expect(calls.some((c) => c.method === 'GET' && c.url.endsWith('/resources'))).toBe(true))
    // Renders one destroy row per current resource, plus the "cannot be undone" warning.
    await waitFor(() => expect(screen.getByText('Indexer peer 1')).toBeTruthy())
    expect(screen.getByText('This cannot be undone')).toBeTruthy()
    expect(screen.getByText('−1 to destroy')).toBeTruthy()

    // Not yet destroyed — only opening the modal must not call /destroy.
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/destroy'))).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: 'Destroy' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/destroy'))).toBe(true))
  })

  it('Destroy: does NOT call /destroy when the user cancels the destroy plan modal', async () => {
    const calls: FetchCall[] = []
    stubFetch(calls, RESOURCES)

    await renderOnSettings()
    fireEvent.click(screen.getByText('Destroy infrastructure'))
    await waitFor(() => expect(screen.getByText('Indexer peer 1')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    // Give any stray async work a tick.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/destroy'))).toBe(false)
  })

  it('Destroy: still allows confirming when the resource inventory is empty (does not block)', async () => {
    const calls: FetchCall[] = []
    stubFetch(calls, [])

    await renderOnSettings()
    fireEvent.click(screen.getByText('Destroy infrastructure'))
    await waitFor(() => expect(screen.getByText(/No resource inventory is available/i)).toBeTruthy())

    const destroyButton = screen.getByRole('button', { name: 'Destroy' }) as HTMLButtonElement
    expect(destroyButton.disabled).toBe(false)

    fireEvent.click(destroyButton)
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/destroy'))).toBe(true))
  })

  it('Destroy: works through its own fallback modal even outside the platform (no host confirm dialog needed)', async () => {
    const calls: FetchCall[] = []
    stubFetch(calls, RESOURCES)
    // No fake host installed — unlike Delete, Destroy does not depend on useConfirmDialog.

    await renderOnSettings()
    fireEvent.click(screen.getByText('Destroy infrastructure'))
    await waitFor(() => expect(screen.getByText('Indexer peer 1')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Destroy' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/destroy'))).toBe(true))
    expect(windowConfirmSpy).not.toHaveBeenCalled()
  })

  it('Delete: asks for confirmation with a danger variant, and only DELETEs the record when confirmed', async () => {
    const calls: FetchCall[] = []
    stubFetch(calls)
    const confirm = installFakeHostWithConfirm(async () => true)

    const { onDeleted } = await renderOnSettings()
    fireEvent.click(screen.getByText('Delete record'))

    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1))
    expect(confirm.mock.calls[0][0]).toMatchObject({
      title: 'Delete infrastructure record',
      message: 'Delete "BYOL001"? This cannot be undone.',
      confirmText: 'Delete',
      variant: 'danger',
    })

    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true))
    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1))
  })

  it('Delete: does NOT delete the record when the user cancels the confirmation', async () => {
    const calls: FetchCall[] = []
    stubFetch(calls)
    installFakeHostWithConfirm(async () => false)

    const { onDeleted } = await renderOnSettings()
    fireEvent.click(screen.getByText('Delete record'))

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
    expect(onDeleted).not.toHaveBeenCalled()
  })

  it('Delete: fails closed outside the platform — no host confirmation dialog means Delete never proceeds', async () => {
    const calls: FetchCall[] = []
    stubFetch(calls)
    // No fake host installed — useConfirmDialog() resolves to the fail-closed fallback.

    await renderOnSettings()
    fireEvent.click(screen.getByText('Delete record'))

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
    expect(windowConfirmSpy).not.toHaveBeenCalled()
  })
})
