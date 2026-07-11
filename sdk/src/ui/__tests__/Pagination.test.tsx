// ========================================================================
// Tests: @veltrixsecops/app-sdk/ui — Pagination
// ========================================================================

import * as React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, afterEach } from 'vitest'
import { HOST_RUNTIME_GLOBAL } from '../../client'
import { Pagination } from '../index'

function installFakeHost() {
  const ui: Record<string, unknown> = {
    Pagination: (props: { page: number; totalItems: number }) => (
      <div data-testid="host-pagination">
        page {props.page} of {props.totalItems}
      </div>
    ),
  }
  ;(globalThis as Record<string, unknown>)[HOST_RUNTIME_GLOBAL] = {
    react: React,
    authFetch: () => Promise.resolve(new Response()),
    AppContext: React.createContext(null),
    sdk: {},
    ui,
  }
}

function uninstallHost() {
  delete (globalThis as Record<string, unknown>)[HOST_RUNTIME_GLOBAL]
}

afterEach(() => {
  uninstallHost()
})

describe('Pagination', () => {
  it('renders the host Pagination when present', () => {
    installFakeHost()
    render(<Pagination page={2} pageSize={10} totalItems={30} onPageChange={() => {}} />)
    expect(screen.getByTestId('host-pagination')).toHaveTextContent('page 2 of 30')
  })

  it('fallback: renders a nav landmark with "page X of Y" text and working Prev/Next buttons', () => {
    let currentPage = 2
    const handlePageChange = (page: number) => (currentPage = page)
    render(<Pagination page={2} pageSize={10} totalItems={35} onPageChange={handlePageChange} />)

    expect(screen.getByRole('navigation', { name: 'Pagination' })).toBeInTheDocument()
    expect(screen.getByText('page 2 of 4')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /next/i }))
    expect(currentPage).toBe(3)

    fireEvent.click(screen.getByRole('button', { name: /prev/i }))
    expect(currentPage).toBe(1)
  })

  it('fallback: disables Prev on the first page and Next on the last page, without throwing on click', () => {
    render(<Pagination page={1} pageSize={10} totalItems={10} onPageChange={() => {}} />)
    expect(screen.getByRole('button', { name: /prev/i })).toBeDisabled()
    expect(screen.getByRole('button', { name: /next/i })).toBeDisabled()
  })
})
