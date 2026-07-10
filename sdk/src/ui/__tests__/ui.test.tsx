// ========================================================================
// Tests: @veltrixsecops/app-sdk/ui
//
// Every exported component must:
//   1. render the platform's real implementation when the host runtime's
//      `ui` bag contains it (simulating running inside Veltrix, where the
//      bundler shim resolves this whole module to `rt.ui` — but this
//      module's own render-time lookup is exercised for non-bundled
//      contexts: local dev, tests, tsc-only checks), and
//   2. render a minimal, accessible fallback — never throw — when the host
//      runtime is absent (outside the platform) or the host predates this
//      component (key missing from `rt.ui`).
// ========================================================================

import * as React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, afterEach } from 'vitest'
import { HOST_RUNTIME_GLOBAL } from '../../client'
import {
  Button,
  Badge,
  Card,
  CardHeader,
  CardBody,
  CardFooter,
  Input,
  Textarea,
  Checkbox,
  Select,
  FormField,
  Tabs,
  EmptyState,
  Skeleton,
  SkeletonText,
  SkeletonCard,
  Tooltip,
  Spinner,
  DataTable,
  StatsCard,
  FormDialog,
  useToast,
  useConfirmDialog,
} from '../index'

// ---------------------------------------------------------------------------
// Fake host runtime — stub components carry a `data-testid="host-*"` marker
// so tests can assert the SDK delegated to them (as opposed to rendering its
// own fallback markup).
// ---------------------------------------------------------------------------

function installFakeHost() {
  const FakeButton = React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement>>(
    ({ children, ...props }, ref) => (
      <button ref={ref} data-testid="host-button" {...props}>
        {children}
      </button>
    ),
  )
  const FakeInput = React.forwardRef<HTMLInputElement, { label?: string }>((props, ref) => (
    <input ref={ref} data-testid="host-input" aria-label={props.label} />
  ))

  const ui: Record<string, unknown> = {
    Button: FakeButton,
    Badge: (props: { children?: React.ReactNode }) => <mark data-testid="host-badge">{props.children}</mark>,
    Card: (props: { children?: React.ReactNode }) => <section data-testid="host-card">{props.children}</section>,
    CardHeader: (props: { children?: React.ReactNode }) => <header data-testid="host-card-header">{props.children}</header>,
    CardBody: (props: { children?: React.ReactNode }) => <div data-testid="host-card-body">{props.children}</div>,
    CardFooter: (props: { children?: React.ReactNode }) => <footer data-testid="host-card-footer">{props.children}</footer>,
    Input: FakeInput,
    Select: () => <select data-testid="host-select" />,
    FormField: (props: { children?: React.ReactNode }) => <div data-testid="host-form-field">{props.children}</div>,
    Tabs: () => <div data-testid="host-tabs" />,
    EmptyState: (props: { title: string }) => <div data-testid="host-empty-state">{props.title}</div>,
    Skeleton: () => <div data-testid="host-skeleton" />,
    SkeletonText: () => <div data-testid="host-skeleton-text" />,
    SkeletonCard: () => <div data-testid="host-skeleton-card" />,
    Tooltip: (props: { children?: React.ReactNode }) => <span data-testid="host-tooltip">{props.children}</span>,
    DataTable: () => <div data-testid="host-data-table" />,
    Textarea: React.forwardRef<HTMLTextAreaElement>((props, ref) => <textarea ref={ref} data-testid="host-textarea" {...props} />),
    Checkbox: React.forwardRef<HTMLInputElement>((props, ref) => <input ref={ref} type="checkbox" data-testid="host-checkbox" {...props} />),
    Spinner: () => <div data-testid="host-spinner" />,
    StatsCard: (props: { label: string }) => <div data-testid="host-stats-card">{props.label}</div>,
    FormDialog: (props: { isOpen: boolean; title: string; children?: React.ReactNode }) =>
      props.isOpen ? (
        <div data-testid="host-form-dialog">
          {props.title}
          {props.children}
        </div>
      ) : null,
    useToast: () => ({
      toasts: [],
      toast: () => 'host-toast-id',
      success: () => 'host-toast-id',
      error: () => 'host-toast-id',
      warning: () => 'host-toast-id',
      info: () => 'host-toast-id',
      promise: (p: Promise<unknown>) => p,
      dismiss: () => {},
      dismissAll: () => {},
    }),
    useConfirmDialog: () => ({ confirm: async () => true }),
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

interface Row {
  id: string
  name: string
}

describe('Button', () => {
  it('renders the host Button when present', () => {
    installFakeHost()
    render(<Button>Save</Button>)
    expect(screen.getByTestId('host-button')).toHaveTextContent('Save')
  });

  it('renders an accessible native <button> fallback when the host is absent', () => {
    render(<Button onClick={() => {}}>Save</Button>)
    const button = screen.getByRole('button', { name: 'Save' })
    expect(button).toBeInTheDocument()
    expect(button.tagName).toBe('BUTTON')
  });

  it('fallback: fires onClick and reflects isLoading via aria-busy without throwing', () => {
    let clicked = false
    render(
      <Button onClick={() => (clicked = true)} isLoading loadingText="Saving…">
        Save
      </Button>,
    )
    const button = screen.getByRole('button', { name: 'Saving…' })
    expect(button).toHaveAttribute('aria-busy', 'true')
    expect(button).toBeDisabled()
    fireEvent.click(button)
    // Disabled buttons don't fire click handlers — assert no throw occurred and state is stable.
    expect(clicked).toBe(false)
  });
});

describe('Badge', () => {
  it('renders the host Badge when present', () => {
    installFakeHost()
    render(<Badge>Active</Badge>)
    expect(screen.getByTestId('host-badge')).toHaveTextContent('Active')
  });

  it('renders a fallback <span> when the host is absent', () => {
    render(<Badge variant="success">Active</Badge>)
    expect(screen.getByText('Active').tagName).toBe('SPAN')
  });
});

describe('Card', () => {
  it('renders the host Card + subcomponents when present', () => {
    installFakeHost()
    render(
      <Card>
        <CardHeader>Title</CardHeader>
        <CardBody>Body</CardBody>
        <CardFooter>Footer</CardFooter>
      </Card>,
    )
    expect(screen.getByTestId('host-card')).toBeInTheDocument()
    expect(screen.getByTestId('host-card-header')).toHaveTextContent('Title')
    expect(screen.getByTestId('host-card-body')).toHaveTextContent('Body')
    expect(screen.getByTestId('host-card-footer')).toHaveTextContent('Footer')
  });

  it('renders a fallback bordered div structure when the host is absent', () => {
    render(
      <Card>
        <CardHeader>Title</CardHeader>
        <CardBody>Body</CardBody>
      </Card>,
    )
    expect(screen.getByText('Title')).toBeInTheDocument()
    expect(screen.getByText('Body')).toBeInTheDocument()
  });
});

describe('Input', () => {
  it('renders the host Input when present', () => {
    installFakeHost()
    render(<Input label="Name" />)
    expect(screen.getByTestId('host-input')).toBeInTheDocument()
  });

  it('fallback: renders a labeled, accessible native input and surfaces an error message', () => {
    render(<Input label="Name" error="Name is required" />);
    expect(screen.getByLabelText('Name')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('Name is required')
  });
});

describe('Select', () => {
  it('renders the host Select when present', () => {
    installFakeHost()
    render(<Select options={[]} />)
    expect(screen.getByTestId('host-select')).toBeInTheDocument()
  });

  it('fallback: renders a native <select> that calls onChange with the new value', () => {
    let changedTo: string | undefined
    render(
      <Select
        label="Environment"
        options={[
          { value: 'prod', label: 'Production' },
          { value: 'staging', label: 'Staging' },
        ]}
        onChange={(value) => (changedTo = value)}
      />,
    )
    const select = screen.getByLabelText('Environment') as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'staging' } })
    expect(changedTo).toBe('staging')
  });
});

describe('FormField', () => {
  it('renders the host FormField when present', () => {
    installFakeHost()
    render(
      <FormField label="CIDRs">
        <textarea />
      </FormField>,
    )
    expect(screen.getByTestId('host-form-field')).toBeInTheDocument()
  });

  it('fallback: renders the label, hint, and children without a host', () => {
    render(
      <FormField label="CIDRs" hint="One per line">
        <textarea aria-label="cidrs-input" />
      </FormField>,
    )
    expect(screen.getByText('CIDRs')).toBeInTheDocument()
    expect(screen.getByText('One per line')).toBeInTheDocument()
    expect(screen.getByLabelText('cidrs-input')).toBeInTheDocument()
  });
});

describe('Tabs', () => {
  const tabs = [
    { key: 'a', label: 'Alpha', content: <p>Alpha panel</p> },
    { key: 'b', label: 'Beta', content: <p>Beta panel</p> },
  ]

  it('renders the host Tabs when present', () => {
    installFakeHost()
    render(<Tabs tabs={tabs} />)
    expect(screen.getByTestId('host-tabs')).toBeInTheDocument()
  });

  it('fallback: renders working, clickable tabs without a host', () => {
    render(<Tabs tabs={tabs} />)
    expect(screen.getByText('Alpha panel')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'Beta' }))
    expect(screen.getByText('Beta panel')).toBeInTheDocument()
  });
});

describe('EmptyState', () => {
  it('renders the host EmptyState when present', () => {
    installFakeHost()
    render(<EmptyState title="No indexes" />)
    expect(screen.getByTestId('host-empty-state')).toHaveTextContent('No indexes')
  });

  it('fallback: renders the title and description without a host', () => {
    render(<EmptyState title="No indexes" description="Create one from the canvas" />)
    expect(screen.getByText('No indexes')).toBeInTheDocument()
    expect(screen.getByText('Create one from the canvas')).toBeInTheDocument()
  });
});

describe('Skeleton family', () => {
  it('Skeleton/SkeletonText/SkeletonCard render the host versions when present', () => {
    installFakeHost()
    render(
      <>
        <Skeleton />
        <SkeletonText />
        <SkeletonCard />
      </>,
    )
    expect(screen.getByTestId('host-skeleton')).toBeInTheDocument()
    expect(screen.getByTestId('host-skeleton-text')).toBeInTheDocument()
    expect(screen.getByTestId('host-skeleton-card')).toBeInTheDocument()
  });

  it('fallback: renders decorative placeholders without throwing', () => {
    const { container } = render(
      <>
        <Skeleton variant="circular" width={40} height={40} />
        <SkeletonText lines={2} />
        <SkeletonCard hasAvatar hasActions />
      </>,
    )
    expect(container.querySelectorAll('[aria-hidden="true"]').length).toBeGreaterThan(0)
  });
});

describe('Tooltip', () => {
  it('renders the host Tooltip when present', () => {
    installFakeHost()
    render(
      <Tooltip content="Sandboxes">
        <button>Icon</button>
      </Tooltip>,
    )
    expect(screen.getByTestId('host-tooltip')).toBeInTheDocument()
  });

  it('fallback: renders children with a native title attribute, no throw', () => {
    render(
      <Tooltip content="Sandboxes">
        <button>Icon</button>
      </Tooltip>,
    )
    const wrapper = screen.getByText('Icon').closest('span')
    expect(wrapper).toHaveAttribute('title', 'Sandboxes')
  });
});

describe('DataTable', () => {
  const rows: Row[] = [
    { id: '1', name: 'main-index' },
    { id: '2', name: 'secondary-index' },
  ]

  it('renders the host DataTable when present', () => {
    installFakeHost()
    render(<DataTable<Row> columns={[{ key: 'name', header: 'Name' }]} data={rows} rowKey={(r) => r.id} />)
    expect(screen.getByTestId('host-data-table')).toBeInTheDocument()
  });

  it('fallback: renders a plain table with the given rows', () => {
    render(<DataTable<Row> columns={[{ key: 'name', header: 'Name' }]} data={rows} rowKey={(r) => r.id} />)
    expect(screen.getByText('main-index')).toBeInTheDocument()
    expect(screen.getByText('secondary-index')).toBeInTheDocument()
  });

  it('fallback: renders the EmptyState when data is empty and not loading', () => {
    render(
      <DataTable<Row>
        columns={[{ key: 'name', header: 'Name' }]}
        data={[]}
        rowKey={(r) => r.id}
        emptyState={{ title: 'No rows yet' }}
      />,
    )
    expect(screen.getByText('No rows yet')).toBeInTheDocument()
  });
});

describe('Textarea', () => {
  it('renders the host Textarea when present', () => {
    installFakeHost()
    render(<Textarea label="Description" />)
    expect(screen.getByTestId('host-textarea')).toBeInTheDocument()
  });

  it('fallback: renders a labeled, accessible native textarea', () => {
    render(<Textarea label="Description" helperText="Markdown supported" />)
    expect(screen.getByLabelText('Description').tagName).toBe('TEXTAREA')
    expect(screen.getByText('Markdown supported')).toBeInTheDocument()
  });
});

describe('Checkbox', () => {
  it('renders the host Checkbox when present', () => {
    installFakeHost()
    render(<Checkbox label="Enable drift detection" />)
    expect(screen.getByTestId('host-checkbox')).toBeInTheDocument()
  });

  it('fallback: renders a labeled, toggleable native checkbox', () => {
    render(<Checkbox label="Enable drift detection" />)
    const checkbox = screen.getByLabelText('Enable drift detection') as HTMLInputElement
    expect(checkbox.type).toBe('checkbox')
    fireEvent.click(checkbox)
    expect(checkbox.checked).toBe(true)
  });
});

describe('Spinner', () => {
  it('renders the host Spinner when present', () => {
    installFakeHost()
    render(<Spinner label="Loading indexes…" />)
    expect(screen.getByTestId('host-spinner')).toBeInTheDocument()
  });

  it('fallback: renders a status role without throwing', () => {
    render(<Spinner label="Loading indexes…" />)
    expect(screen.getByRole('status')).toBeInTheDocument()
  });
});

describe('StatsCard', () => {
  it('renders the host StatsCard when present', () => {
    installFakeHost()
    render(<StatsCard label="Indexes" value={2} />)
    expect(screen.getByTestId('host-stats-card')).toHaveTextContent('Indexes')
  });

  it('fallback: renders the label and value', () => {
    render(<StatsCard label="Indexes" value={2} />)
    expect(screen.getByText('Indexes')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()
  });
});

describe('FormDialog', () => {
  it('renders the host FormDialog when present', () => {
    installFakeHost()
    render(
      <FormDialog isOpen title="Add index" onClose={() => {}} onSubmit={() => {}}>
        <p>Fields</p>
      </FormDialog>,
    )
    expect(screen.getByTestId('host-form-dialog')).toHaveTextContent('Add index')
  });

  it('fallback: renders an accessible dialog with submit/cancel wired up', () => {
    let submitted = false
    let closed = false
    render(
      <FormDialog
        isOpen
        title="Add index"
        onClose={() => {
          closed = true
        }}
        onSubmit={() => {
          submitted = true
        }}
      >
        <p>Fields</p>
      </FormDialog>,
    )
    expect(screen.getByRole('dialog', { name: 'Add index' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(submitted).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(closed).toBe(true)
  });

  it('fallback: renders nothing when isOpen is false', () => {
    const { container } = render(
      <FormDialog isOpen={false} title="Add index" onClose={() => {}} onSubmit={() => {}}>
        <p>Fields</p>
      </FormDialog>,
    )
    expect(container).toBeEmptyDOMElement()
  });
});

describe('useToast', () => {
  function ToastHarness() {
    const toast = useToast()
    return <button onClick={() => toast.success('Saved')}>Save</button>
  }

  it('delegates to the host toast system when present', () => {
    installFakeHost()
    render(<ToastHarness />)
    // No throw on click — the host's real (stubbed) implementation handled it.
    expect(() => fireEvent.click(screen.getByRole('button'))).not.toThrow()
  });

  it('fallback: does not throw outside the platform (logs instead)', () => {
    render(<ToastHarness />)
    expect(() => fireEvent.click(screen.getByRole('button'))).not.toThrow()
  });
});

describe('useConfirmDialog', () => {
  function ConfirmHarness({ onResult }: { onResult: (v: boolean) => void }) {
    const { confirm } = useConfirmDialog()
    return (
      <button
        onClick={async () => {
          const result = await confirm({ title: 'Delete index', message: 'This cannot be undone.' })
          onResult(result)
        }}
      >
        Delete
      </button>
    )
  }

  it('delegates to the host confirmation dialog when present', async () => {
    installFakeHost()
    const results: boolean[] = []
    render(<ConfirmHarness onResult={(v) => results.push(v)} />)
    fireEvent.click(screen.getByRole('button'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(results).toEqual([true])
  });

  it('fallback: fails closed (resolves false) instead of throwing outside the platform', async () => {
    const results: boolean[] = []
    render(<ConfirmHarness onResult={(v) => results.push(v)} />)
    fireEvent.click(screen.getByRole('button'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(results).toEqual([false])
  });
});
