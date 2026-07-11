// ========================================================================
// Tests: @veltrixsecops/app-sdk/ui — SortSelect
// ========================================================================

import * as React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, afterEach } from 'vitest'
import { HOST_RUNTIME_GLOBAL } from '../../client'
import { SortSelect } from '../index'

function installFakeHost() {
  const ui: Record<string, unknown> = {
    SortSelect: (props: { value: string; direction: string }) => (
      <div data-testid="host-sort-select">
        {props.value}-{props.direction}
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

const options = [
  { value: 'name', label: 'Name' },
  { value: 'updatedAt', label: 'Last updated' },
]

describe('SortSelect', () => {
  it('renders the host SortSelect when present', () => {
    installFakeHost()
    render(<SortSelect options={options} value="name" direction="asc" onChange={() => {}} />)
    expect(screen.getByTestId('host-sort-select')).toHaveTextContent('name-asc')
  })

  it('fallback: renders a native <select> for the field that calls onChange with the same direction', () => {
    let result: [string, string] | undefined
    render(
      <SortSelect
        options={options}
        value="name"
        direction="desc"
        onChange={(value, direction) => (result = [value, direction])}
      />,
    )
    const select = screen.getByLabelText('Sort by') as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'updatedAt' } })
    expect(result).toEqual(['updatedAt', 'desc'])
  })

  it('fallback: the direction button flips direction and reflects it in its accessible name', () => {
    let result: [string, string] | undefined
    render(
      <SortSelect
        options={options}
        value="name"
        direction="asc"
        onChange={(value, direction) => (result = [value, direction])}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Sort ascending' }))
    expect(result).toEqual(['name', 'desc'])
  })
})
