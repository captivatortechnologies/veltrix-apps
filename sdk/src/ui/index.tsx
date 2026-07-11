// ========================================================================
// @veltrixsecops/app-sdk/ui — the platform's shared component library,
// exposed to app client bundles.
//
// App pages import these instead of hand-rolling raw HTML, so pages render
// themed inside the Veltrix design system (dark/light + tenant branding via
// `var(--vx-*)`), consistent with the rest of the portal, and externalized —
// zero bundle bloat, one React instance. This completes the "predictable
// shell, flexible body" contract: the platform owns the components; apps
// compose their page body from them.
//
// RUNTIME: every export here reads its real implementation off the host at
// render time — globalThis.__VELTRIX_APP_RUNTIME__.ui.<Name>, populated by
// the platform from components/shared/* (see
// client/src/appRuntime/installHostRuntime.ts). At packaging time the CLI's
// client bundler (and the platform's on-demand esbuild bundle routes) shim
// the '@veltrixsecops/app-sdk/ui' specifier straight to that `ui` bag, so
// this module's own render-time lookup only actually executes in
// non-bundled contexts: local dev, unit tests, a bare `tsc --noEmit`, or
// Storybook.
//
// FALLBACK CONTRACT: outside the platform (host runtime absent, or an older
// host that predates a given component) every export here renders a
// minimal, accessible, unstyled fallback instead of throwing — an app page
// under test or local dev keeps working, just without platform theming.
// Never throw on render.
//
// TYPE FIDELITY: prop types are copied from the platform's real components
// in client/src/components/shared (see the ADR at
// _ai_tasks/ui-package/2026-07-10/02_sdk_ui_subpath.md) so app-author
// typechecking matches what actually renders inside Veltrix. Heavy composite
// widgets (ConfigurationCanvas, VersionControl, Pipeline) stay out of scope —
// they carry platform coupling a later phase may expose read-only versions
// of; see the ADR's "Non-goals" section.
//
// EXPORTS: Button, Badge, Card (+ CardHeader/CardBody/CardFooter), Input,
// Textarea, Checkbox, Select, SearchBox, Pagination, FilterBar, SortSelect,
// FormField, Tabs, EmptyState, Skeleton (+ SkeletonText/SkeletonCard),
// Tooltip, Spinner, DataTable, StatsCard, FormDialog, useToast,
// useConfirmDialog.
//
// useToast / useConfirmDialog are included because the platform's root
// App.tsx mounts ToastProvider/ConfirmationDialogProvider around the ENTIRE
// tree (including every app page, since app pages render inside the host's
// own React instance) — so the real context-backed hooks resolve correctly
// from app code with no extra wiring. Outside the platform they degrade to a
// safe, non-throwing fallback (see each hook's docs below) rather than
// crashing or silently doing nothing.
// ========================================================================

import * as React from 'react'
import { getHostRuntime } from '../client'

/** Read one named component off the host's `runtime.ui` bag, or undefined. */
function getHostUi<T>(name: string): T | undefined {
  return getHostRuntime()?.ui?.[name] as T | undefined
}

const fallbackNote: React.CSSProperties = { fontFamily: 'inherit' }

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'success' | 'warning' | 'ghost' | 'link'
export type ButtonSize = 'sm' | 'md' | 'lg'

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  isLoading?: boolean
  loadingText?: string
  fullWidth?: boolean
  leftIcon?: React.ReactNode
  rightIcon?: React.ReactNode
}

type ButtonComponent = React.ForwardRefExoticComponent<ButtonProps & React.RefAttributes<HTMLButtonElement>>

/**
 * Button — delegates to the platform's real Button at render time.
 *
 * @example
 * <Button variant="primary" leftIcon={<RefreshIcon />} onClick={refresh}>Refresh</Button>
 */
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>((props, ref) => {
  const HostButton = getHostUi<ButtonComponent>('Button')
  if (HostButton) return <HostButton ref={ref} {...props} />

  const {
    variant: _variant,
    size: _size,
    isLoading,
    loadingText,
    fullWidth,
    leftIcon,
    rightIcon,
    children,
    disabled,
    type,
    style,
    ...rest
  } = props

  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      disabled={disabled || isLoading}
      aria-busy={isLoading || undefined}
      style={{
        ...fallbackNote,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '6px 14px',
        borderRadius: 6,
        border: '1px solid currentColor',
        background: 'transparent',
        cursor: disabled || isLoading ? 'not-allowed' : 'pointer',
        width: fullWidth ? '100%' : undefined,
        opacity: disabled || isLoading ? 0.6 : 1,
        justifyContent: 'center',
        ...style,
      }}
      {...rest}
    >
      {leftIcon}
      {isLoading ? loadingText ?? children : children}
      {rightIcon}
    </button>
  )
})
Button.displayName = 'Button'

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------

export type BadgeVariant = 'default' | 'primary' | 'secondary' | 'success' | 'danger' | 'warning' | 'info'
export type BadgeSize = 'sm' | 'md' | 'lg'

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant
  size?: BadgeSize
  rounded?: boolean
  dot?: boolean
}

const BADGE_FALLBACK_COLORS: Record<BadgeVariant, string> = {
  default: '#6b7280',
  primary: '#4f46e5',
  secondary: '#6b7280',
  success: '#16a34a',
  danger: '#dc2626',
  warning: '#d97706',
  info: '#0284c7',
}

/**
 * Badge — delegates to the platform's real Badge at render time.
 *
 * @example
 * <Badge variant={row.deployState === 'deployed' ? 'success' : 'warning'}>{row.deployState}</Badge>
 */
export const Badge: React.FC<BadgeProps> = ({ variant = 'default', size = 'md', rounded, dot, children, style, ...rest }) => {
  const HostBadge = getHostUi<React.FC<BadgeProps>>('Badge')
  if (HostBadge) return <HostBadge variant={variant} size={size} rounded={rounded} dot={dot} style={style} {...rest}>{children}</HostBadge>

  const color = BADGE_FALLBACK_COLORS[variant]
  const fontSize = size === 'sm' ? 11 : size === 'lg' ? 14 : 12
  return (
    <span
      style={{
        ...fallbackNote,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: size === 'sm' ? '1px 6px' : size === 'lg' ? '3px 10px' : '2px 8px',
        borderRadius: rounded ? 999 : 4,
        border: `1px solid ${color}`,
        color,
        fontSize,
        fontWeight: 500,
        ...style,
      }}
      {...rest}
    >
      {dot && <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: '50%', background: color }} />}
      {children}
    </span>
  )
}
Badge.displayName = 'Badge'

// ---------------------------------------------------------------------------
// Card (+ Header/Body/Footer)
// ---------------------------------------------------------------------------

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: 'default' | 'bordered' | 'elevated'
  padding?: 'none' | 'sm' | 'md' | 'lg'
}
export interface CardHeaderProps extends React.HTMLAttributes<HTMLDivElement> {
  actions?: React.ReactNode
}
export type CardBodyProps = React.HTMLAttributes<HTMLDivElement>
export interface CardFooterProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: 'default' | 'bordered'
}

/** Card — delegates to the platform's real Card at render time. */
export const Card: React.FC<CardProps> = ({ children, style, ...rest }) => {
  const HostCard = getHostUi<React.FC<CardProps>>('Card')
  if (HostCard) return <HostCard style={style} {...rest}>{children}</HostCard>
  return (
    <div style={{ ...fallbackNote, border: '1px solid #d1d5db', borderRadius: 8, overflow: 'hidden', ...style }} {...rest}>
      {children}
    </div>
  )
}
Card.displayName = 'Card'

/** CardHeader — the header section of a Card, with optional trailing actions. */
export const CardHeader: React.FC<CardHeaderProps> = ({ actions, children, style, ...rest }) => {
  const HostCardHeader = getHostUi<React.FC<CardHeaderProps>>('CardHeader')
  if (HostCardHeader) return <HostCardHeader actions={actions} style={style} {...rest}>{children}</HostCardHeader>
  return (
    <div
      style={{
        ...fallbackNote,
        padding: '12px 16px',
        borderBottom: '1px solid #d1d5db',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        ...style,
      }}
      {...rest}
    >
      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
      {actions && <div>{actions}</div>}
    </div>
  )
}
CardHeader.displayName = 'CardHeader'

/** CardBody — the main content area of a Card. */
export const CardBody: React.FC<CardBodyProps> = ({ children, style, ...rest }) => {
  const HostCardBody = getHostUi<React.FC<CardBodyProps>>('CardBody')
  if (HostCardBody) return <HostCardBody style={style} {...rest}>{children}</HostCardBody>
  return (
    <div style={{ ...fallbackNote, padding: '12px 16px', ...style }} {...rest}>
      {children}
    </div>
  )
}
CardBody.displayName = 'CardBody'

/** CardFooter — the footer section of a Card, typically for actions. */
export const CardFooter: React.FC<CardFooterProps> = ({ children, style, ...rest }) => {
  const HostCardFooter = getHostUi<React.FC<CardFooterProps>>('CardFooter')
  if (HostCardFooter) return <HostCardFooter style={style} {...rest}>{children}</HostCardFooter>
  return (
    <div style={{ ...fallbackNote, padding: '12px 16px', borderTop: '1px solid #d1d5db', ...style }} {...rest}>
      {children}
    </div>
  )
}
CardFooter.displayName = 'CardFooter'

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export type InputSize = 'sm' | 'md' | 'lg'
export type InputVariant = 'default' | 'error' | 'success'

export interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'> {
  label?: string
  error?: string
  helperText?: string
  leftIcon?: React.ReactNode
  rightIcon?: React.ReactNode
  variant?: InputVariant
  inputSize?: InputSize
  isSuccess?: boolean
  fullWidth?: boolean
}

type InputComponent = React.ForwardRefExoticComponent<InputProps & React.RefAttributes<HTMLInputElement>>

/**
 * Input — delegates to the platform's real Input at render time.
 *
 * @example
 * <Input label="Index name" value={name} onChange={(e) => setName(e.target.value)} error={errors.name} />
 */
export const Input = React.forwardRef<HTMLInputElement, InputProps>((props, ref) => {
  const HostInput = getHostUi<InputComponent>('Input')
  if (HostInput) return <HostInput ref={ref} {...props} />

  const { label, error, helperText, leftIcon, rightIcon, fullWidth = true, id, style, ...rest } = props
  const inputId = id ?? (label ? `vx-input-${label.toLowerCase().replace(/\s+/g, '-')}` : undefined)

  return (
    <div style={{ ...fallbackNote, width: fullWidth ? '100%' : undefined }}>
      {label && (
        <label htmlFor={inputId} style={{ display: 'block', fontSize: 13, fontWeight: 500, marginBottom: 4 }}>
          {label}
        </label>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {leftIcon}
        <input
          ref={ref}
          id={inputId}
          aria-invalid={!!error || undefined}
          style={{ flex: 1, padding: '6px 10px', borderRadius: 6, border: '1px solid #9ca3af', ...style }}
          {...rest}
        />
        {rightIcon}
      </div>
      {error && (
        <p role="alert" style={{ marginTop: 4, fontSize: 12, color: '#dc2626' }}>
          {error}
        </p>
      )}
      {helperText && !error && <p style={{ marginTop: 4, fontSize: 12, color: '#6b7280' }}>{helperText}</p>}
    </div>
  )
})
Input.displayName = 'Input'

// ---------------------------------------------------------------------------
// Textarea
// ---------------------------------------------------------------------------

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string
  error?: string
  helperText?: string
  fullWidth?: boolean
}

type TextareaComponent = React.ForwardRefExoticComponent<TextareaProps & React.RefAttributes<HTMLTextAreaElement>>

/**
 * Textarea — delegates to the platform's real Textarea at render time.
 *
 * @example
 * <Textarea label="Description" helperText="Markdown is supported." />
 */
export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>((props, ref) => {
  const HostTextarea = getHostUi<TextareaComponent>('Textarea')
  if (HostTextarea) return <HostTextarea ref={ref} {...props} />

  const { label, error, helperText, fullWidth = true, id, rows = 4, style, ...rest } = props
  const textareaId = id ?? (label ? `vx-textarea-${label.toLowerCase().replace(/\s+/g, '-')}` : undefined)

  return (
    <div style={{ ...fallbackNote, width: fullWidth ? '100%' : undefined }}>
      {label && (
        <label htmlFor={textareaId} style={{ display: 'block', fontSize: 13, fontWeight: 500, marginBottom: 4 }}>
          {label}
        </label>
      )}
      <textarea
        ref={ref}
        id={textareaId}
        rows={rows}
        aria-invalid={!!error || undefined}
        style={{ width: '100%', padding: '6px 10px', borderRadius: 6, border: '1px solid #9ca3af', ...style }}
        {...rest}
      />
      {error && (
        <p role="alert" style={{ marginTop: 4, fontSize: 12, color: '#dc2626' }}>
          {error}
        </p>
      )}
      {helperText && !error && <p style={{ marginTop: 4, fontSize: 12, color: '#6b7280' }}>{helperText}</p>}
    </div>
  )
})
Textarea.displayName = 'Textarea'

// ---------------------------------------------------------------------------
// Checkbox
// ---------------------------------------------------------------------------

export interface CheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label?: React.ReactNode
  error?: string
  helperText?: string
}

type CheckboxComponent = React.ForwardRefExoticComponent<CheckboxProps & React.RefAttributes<HTMLInputElement>>

/**
 * Checkbox — delegates to the platform's real Checkbox at render time.
 *
 * @example
 * <Checkbox label="Enable drift detection" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
 */
export const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>((props, ref) => {
  const HostCheckbox = getHostUi<CheckboxComponent>('Checkbox')
  if (HostCheckbox) return <HostCheckbox ref={ref} {...props} />

  const { label, error, helperText, id, disabled, ...rest } = props
  const generatedId = React.useId()
  const inputId = id ?? generatedId

  return (
    <div style={fallbackNote}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input ref={ref} id={inputId} type="checkbox" disabled={disabled} aria-invalid={!!error || undefined} {...rest} />
        {label && (
          <label htmlFor={inputId} style={{ fontSize: 13, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.6 : 1 }}>
            {label}
          </label>
        )}
      </div>
      {error && (
        <p role="alert" style={{ marginTop: 4, fontSize: 12, color: '#dc2626' }}>
          {error}
        </p>
      )}
      {helperText && !error && <p style={{ marginTop: 4, fontSize: 12, color: '#6b7280' }}>{helperText}</p>}
    </div>
  )
})
Checkbox.displayName = 'Checkbox'

// ---------------------------------------------------------------------------
// Select (controlled; onChange receives the new value string)
// ---------------------------------------------------------------------------

export type SelectSize = 'sm' | 'md' | 'lg'

export interface SelectOption {
  value: string
  label: string
  disabled?: boolean
}

export interface SelectProps {
  options: SelectOption[]
  value?: string
  onChange?: (value: string) => void
  placeholder?: string
  label?: string
  error?: string
  helperText?: string
  size?: SelectSize
  disabled?: boolean
  fullWidth?: boolean
  className?: string
  id?: string
  name?: string
  'aria-label'?: string
}

/**
 * Select — delegates to the platform's real (WAI-ARIA listbox) Select at render time.
 * The fallback is a native `<select>` — functionally equivalent, visually plainer.
 *
 * @example
 * <Select label="Environment" value={env} onChange={setEnv} options={[{ value: 'prod', label: 'Production' }]} />
 */
export const Select: React.FC<SelectProps> = (props) => {
  const HostSelect = getHostUi<React.FC<SelectProps>>('Select')
  if (HostSelect) return <HostSelect {...props} />

  const { options, value, onChange, placeholder = 'Select…', label, error, helperText, disabled, fullWidth = true, id, name, className } = props
  const selectId = id ?? (label ? `vx-select-${label.toLowerCase().replace(/\s+/g, '-')}` : undefined)

  return (
    <div className={className} style={{ ...fallbackNote, width: fullWidth ? '100%' : undefined }}>
      {label && (
        <label htmlFor={selectId} style={{ display: 'block', fontSize: 13, fontWeight: 500, marginBottom: 4 }}>
          {label}
        </label>
      )}
      <select
        id={selectId}
        name={name}
        aria-label={props['aria-label']}
        aria-invalid={!!error || undefined}
        disabled={disabled}
        value={value ?? ''}
        onChange={(event) => onChange?.(event.target.value)}
        style={{ width: '100%', padding: '6px 10px', borderRadius: 6, border: '1px solid #9ca3af' }}
      >
        {placeholder && (
          <option value="" disabled>
            {placeholder}
          </option>
        )}
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
      {error && (
        <p role="alert" style={{ marginTop: 4, fontSize: 12, color: '#dc2626' }}>
          {error}
        </p>
      )}
      {helperText && !error && <p style={{ marginTop: 4, fontSize: 12, color: '#6b7280' }}>{helperText}</p>}
    </div>
  )
}
Select.displayName = 'Select'

// ---------------------------------------------------------------------------
// SearchBox
// ---------------------------------------------------------------------------

export type SearchBoxSize = 'sm' | 'md' | 'lg'

export interface SearchBoxProps {
  /** Controlled search text. */
  value: string
  /** Called with the new text — debounced by `debounceMs` when set. */
  onChange: (value: string) => void
  placeholder?: string
  disabled?: boolean
  size?: SearchBoxSize
  /** Debounces `onChange` by this many ms; omit (or `0`) to call on every keystroke. */
  debounceMs?: number
  className?: string
  'aria-label'?: string
}

/**
 * SearchBox — delegates to the platform's real SearchBox at render time (leading search icon,
 * a clear button once there's text, optional debounce). The fallback is a bare
 * `<input type="search">` wired straight to `value`/`onChange` — no icon, no debounce, no
 * clear button — but functionally sufficient for typing and clearing.
 *
 * @example
 * <SearchBox value={search} onChange={setSearch} placeholder="Search apps…" debounceMs={250} />
 */
export const SearchBox: React.FC<SearchBoxProps> = (props) => {
  const HostSearchBox = getHostUi<React.FC<SearchBoxProps>>('SearchBox')
  if (HostSearchBox) return <HostSearchBox {...props} />

  const { value, onChange, placeholder, disabled, className, 'aria-label': ariaLabel } = props
  return (
    <input
      type="search"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      disabled={disabled}
      aria-label={ariaLabel ?? placeholder ?? 'Search'}
      className={className}
      style={{ ...fallbackNote, width: '100%', padding: '6px 10px', borderRadius: 6, border: '1px solid #9ca3af' }}
    />
  )
}
SearchBox.displayName = 'SearchBox'

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

export interface PaginationProps {
  /** 1-based current page. */
  page: number
  pageSize: number
  totalItems: number
  onPageChange: (page: number) => void
  /** Renders a page-size selector when provided together with `pageSizeOptions`. */
  onPageSizeChange?: (size: number) => void
  pageSizeOptions?: number[]
  disabled?: boolean
  className?: string
}

/**
 * Pagination — delegates to the platform's real Pagination at render time: a "Showing X–Y of
 * N" summary, numbered pages with ellipsis for large ranges, an optional page-size Select, and
 * `aria-current="page"` on the active page — visually consistent with DataTable's built-in
 * pagination footer. The fallback is a plain Prev/Next pair with "page X of Y" text.
 *
 * @example
 * <Pagination page={page} pageSize={20} totalItems={total} onPageChange={setPage} />
 */
export const Pagination: React.FC<PaginationProps> = (props) => {
  const HostPagination = getHostUi<React.FC<PaginationProps>>('Pagination')
  if (HostPagination) return <HostPagination {...props} />

  const { page, pageSize, totalItems, onPageChange, disabled, className } = props
  const pageCount = Math.max(1, Math.ceil(totalItems / pageSize))
  const canGoPrev = !disabled && page > 1
  const canGoNext = !disabled && page < pageCount

  return (
    <nav aria-label="Pagination" className={className} style={{ ...fallbackNote, display: 'flex', alignItems: 'center', gap: 12 }}>
      <button type="button" onClick={() => onPageChange(page - 1)} disabled={!canGoPrev} style={{ padding: '4px 10px' }}>
        Prev
      </button>
      <span>
        page {page} of {pageCount}
      </span>
      <button type="button" onClick={() => onPageChange(page + 1)} disabled={!canGoNext} style={{ padding: '4px 10px' }}>
        Next
      </button>
    </nav>
  )
}
Pagination.displayName = 'Pagination'

// ---------------------------------------------------------------------------
// FilterBar
// ---------------------------------------------------------------------------

export interface FilterOption {
  value: string
  label: string
}

export interface FilterDefinition {
  /** Stable identifier; also the React key for this filter's dropdown. */
  key: string
  /** Shown as the dropdown's placeholder/aria-label, and as its entry in the "Add filter" menu. */
  label: string
  options: FilterOption[]
  /** `null` (not `''`) represents "no selection" — the value FilterBar clears back to. */
  value: string | null
  onChange: (value: string | null) => void
  /** Always rendered when true. Omit/false to make this filter addable/removable via the "Add filter" menu. */
  alwaysVisible?: boolean
}

export interface FilterBarSearchProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
}

export interface FilterBarProps {
  filters: FilterDefinition[]
  /** Renders a SearchBox ahead of the filter dropdowns when provided. */
  search?: FilterBarSearchProps
  /**
   * Called by "Clear all" instead of FilterBar's own clearing logic. Omit it to let FilterBar
   * clear every filter with a value itself (`filter.onChange(null)` for each).
   */
  onClearAll?: () => void
  addFilterLabel?: string
  className?: string
}

/**
 * FilterBar — delegates to the platform's real FilterBar at render time: an optional
 * SearchBox, always-visible filter dropdowns, and optional filters the user can add/remove via
 * an "Add filter" menu (a filter with a non-null `value` is always treated as visible, even
 * before the user explicitly adds it). The fallback renders every filter as a plain,
 * always-visible native `<select>` — no add/remove menu, no styled search box — so an app page
 * under test still exposes every filter's full behavior via `onChange`.
 *
 * @example
 * <FilterBar
 *   search={{ value: search, onChange: setSearch, placeholder: 'Search apps…' }}
 *   filters={[
 *     { key: 'vendor', label: 'Vendor', options: vendorOptions, value: vendor, onChange: setVendor, alwaysVisible: true },
 *     { key: 'category', label: 'Category', options: categoryOptions, value: category, onChange: setCategory },
 *   ]}
 * />
 */
export const FilterBar: React.FC<FilterBarProps> = (props) => {
  const HostFilterBar = getHostUi<React.FC<FilterBarProps>>('FilterBar')
  if (HostFilterBar) return <HostFilterBar {...props} />

  const { filters, search, className } = props
  return (
    <div className={className} style={{ ...fallbackNote, display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
      {search && (
        <input
          type="search"
          aria-label={search.placeholder ?? 'Search'}
          placeholder={search.placeholder}
          value={search.value}
          onChange={(event) => search.onChange(event.target.value)}
          style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid #9ca3af' }}
        />
      )}
      {filters.map((filter) => (
        <label key={filter.key} style={{ display: 'flex', flexDirection: 'column', fontSize: 12 }}>
          {filter.label}
          <select
            aria-label={filter.label}
            value={filter.value ?? ''}
            onChange={(event) => filter.onChange(event.target.value === '' ? null : event.target.value)}
            style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid #9ca3af' }}
          >
            <option value="">{filter.label}</option>
            {filter.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      ))}
    </div>
  )
}
FilterBar.displayName = 'FilterBar'

// ---------------------------------------------------------------------------
// SortSelect
// ---------------------------------------------------------------------------

export type SortDirection = 'asc' | 'desc'

export interface SortOption {
  value: string
  label: string
}

export interface SortSelectProps {
  /** Sortable fields, e.g. `[{ value: 'name', label: 'Name' }, { value: 'updatedAt', label: 'Updated' }]`. */
  options: SortOption[]
  /** Selected field key. */
  value: string
  direction: SortDirection
  /** Called with the field and direction together, whichever one the interaction changed. */
  onChange: (value: string, direction: SortDirection) => void
  disabled?: boolean
  className?: string
}

/**
 * SortSelect — delegates to the platform's real SortSelect at render time: a labeled field
 * Select paired with an asc/desc direction toggle button, styled to sit in the same toolbar
 * row as FilterBar. The standalone sort control for list/card surfaces that aren't a
 * DataTable (which has its own column-header sort). The fallback is a native `<select>` for
 * the field plus a button that flips direction.
 *
 * @example
 * <SortSelect
 *   options={[{ value: 'name', label: 'Name' }, { value: 'updatedAt', label: 'Last updated' }]}
 *   value={sortField}
 *   direction={sortDirection}
 *   onChange={(field, direction) => { setSortField(field); setSortDirection(direction) }}
 * />
 */
export const SortSelect: React.FC<SortSelectProps> = (props) => {
  const HostSortSelect = getHostUi<React.FC<SortSelectProps>>('SortSelect')
  if (HostSortSelect) return <HostSortSelect {...props} />

  const { options, value, direction, onChange, disabled, className } = props
  const directionLabel = direction === 'asc' ? 'Sort ascending' : 'Sort descending'

  return (
    <div className={className} style={{ ...fallbackNote, display: 'flex', alignItems: 'center', gap: 6 }}>
      <select
        aria-label="Sort by"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value, direction)}
        style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid #9ca3af' }}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange(value, direction === 'asc' ? 'desc' : 'asc')}
        aria-label={directionLabel}
        style={{ padding: '4px 10px' }}
      >
        {direction === 'asc' ? '↑' : '↓'}
      </button>
    </div>
  )
}
SortSelect.displayName = 'SortSelect'

// ---------------------------------------------------------------------------
// FormField — generic label + control + error/hint wrapper
// ---------------------------------------------------------------------------

export interface FormFieldProps {
  label?: string
  htmlFor?: string
  error?: string
  hint?: string
  required?: boolean
  className?: string
  children: React.ReactNode
}

/**
 * FormField — wraps a custom control (not already self-labeling like Input/Select) with
 * the platform's label + error/hint visual language.
 *
 * @example
 * <FormField label="Allowed IP ranges" htmlFor="cidrs" hint="One CIDR block per line">
 *   <textarea id="cidrs" />
 * </FormField>
 */
export const FormField: React.FC<FormFieldProps> = (props) => {
  const HostFormField = getHostUi<React.FC<FormFieldProps>>('FormField')
  if (HostFormField) return <HostFormField {...props} />

  const { label, htmlFor, error, hint, required, className, children } = props
  return (
    <div className={className} style={fallbackNote}>
      {label && (
        <label htmlFor={htmlFor} style={{ display: 'block', fontSize: 13, fontWeight: 500, marginBottom: 4 }}>
          {label}
          {required && (
            <span aria-hidden="true" style={{ color: '#dc2626', marginLeft: 2 }}>
              *
            </span>
          )}
        </label>
      )}
      {children}
      {error && (
        <p role="alert" style={{ marginTop: 4, fontSize: 12, color: '#dc2626' }}>
          {error}
        </p>
      )}
      {hint && !error && <p style={{ marginTop: 4, fontSize: 12, color: '#6b7280' }}>{hint}</p>}
    </div>
  )
}
FormField.displayName = 'FormField'

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

export interface TabItem {
  key?: string
  label: string
  content: React.ReactNode
  disabled?: boolean
}

export interface TabsProps {
  tabs: TabItem[]
  defaultActiveIndex?: number
  activeIndex?: number
  onTabChange?: (index: number) => void
  children?: React.ReactNode
  className?: string
}

/**
 * Tabs — delegates to the platform's real (WAI-ARIA tabs pattern) Tabs at render time.
 *
 * @example
 * <Tabs tabs={[{ key: 'indexes', label: 'Indexes', content: <IndexesPanel /> }]} />
 */
export const Tabs: React.FC<TabsProps> = (props) => {
  const HostTabs = getHostUi<React.FC<TabsProps>>('Tabs')
  if (HostTabs) return <HostTabs {...props} />

  const { tabs, defaultActiveIndex = 0, activeIndex, onTabChange, children, className } = props
  const [internalIndex, setInternalIndex] = React.useState(defaultActiveIndex)
  const isControlled = activeIndex !== undefined
  const currentIndex = isControlled ? activeIndex : internalIndex
  const activeTab = tabs[currentIndex]

  const selectTab = (index: number) => {
    if (tabs[index]?.disabled) return
    if (!isControlled) setInternalIndex(index)
    onTabChange?.(index)
  }

  return (
    <div className={className} style={fallbackNote}>
      <div role="tablist" style={{ display: 'flex', gap: 4, borderBottom: '1px solid #d1d5db' }}>
        {tabs.map((tab, index) => (
          <button
            key={tab.key ?? index}
            type="button"
            role="tab"
            aria-selected={index === currentIndex}
            disabled={tab.disabled}
            onClick={() => selectTab(index)}
            style={{
              padding: '6px 12px',
              border: 'none',
              borderBottom: index === currentIndex ? '2px solid currentColor' : '2px solid transparent',
              background: 'transparent',
              cursor: tab.disabled ? 'not-allowed' : 'pointer',
              fontWeight: index === currentIndex ? 600 : 400,
              opacity: tab.disabled ? 0.5 : 1,
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" style={{ padding: 12 }}>
        {children || activeTab?.content}
      </div>
    </div>
  )
}
Tabs.displayName = 'Tabs'

// ---------------------------------------------------------------------------
// EmptyState
// ---------------------------------------------------------------------------

export interface EmptyStateProps {
  icon?: React.ReactNode
  title: string
  description?: string
  action?: React.ReactNode
  className?: string
}

/** EmptyState — delegates to the platform's real EmptyState at render time. */
export const EmptyState: React.FC<EmptyStateProps> = (props) => {
  const HostEmptyState = getHostUi<React.FC<EmptyStateProps>>('EmptyState')
  if (HostEmptyState) return <HostEmptyState {...props} />

  const { icon, title, description, action, className } = props
  return (
    <div className={className} style={{ ...fallbackNote, textAlign: 'center', padding: '32px 16px' }}>
      {icon && <div style={{ marginBottom: 12 }}>{icon}</div>}
      <p style={{ fontWeight: 600, marginBottom: description ? 4 : 0 }}>{title}</p>
      {description && <p style={{ fontSize: 13, color: '#6b7280', marginBottom: action ? 12 : 0 }}>{description}</p>}
      {action}
    </div>
  )
}
EmptyState.displayName = 'EmptyState'

// ---------------------------------------------------------------------------
// Skeleton (+ Text/Card)
// ---------------------------------------------------------------------------

export type SkeletonVariant = 'text' | 'circular' | 'rectangular'

export interface SkeletonProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: SkeletonVariant
  width?: string | number
  height?: string | number
  animation?: 'pulse' | 'wave' | 'none'
}

const skeletonRadius: Record<SkeletonVariant, number | string> = { text: 4, circular: '50%', rectangular: 8 }

/** Skeleton — delegates to the platform's real Skeleton at render time. */
export const Skeleton: React.FC<SkeletonProps> = (props) => {
  const HostSkeleton = getHostUi<React.FC<SkeletonProps>>('Skeleton')
  if (HostSkeleton) return <HostSkeleton {...props} />

  const { variant = 'text', width, height, style, ...rest } = props
  return (
    <div
      aria-hidden="true"
      style={{
        background: '#e5e7eb',
        borderRadius: skeletonRadius[variant],
        width: width ?? (variant === 'text' ? '100%' : undefined),
        height: height ?? (variant === 'text' ? 14 : undefined),
        ...style,
      }}
      {...rest}
    />
  )
}
Skeleton.displayName = 'Skeleton'

export interface SkeletonTextProps {
  lines?: number
  width?: string | number
  lastLineWidth?: string | number
  className?: string
}

/** SkeletonText — a multi-line text skeleton, delegating to the platform's real one. */
export const SkeletonText: React.FC<SkeletonTextProps> = (props) => {
  const HostSkeletonText = getHostUi<React.FC<SkeletonTextProps>>('SkeletonText')
  if (HostSkeletonText) return <HostSkeletonText {...props} />

  const { lines = 3, width = '100%', lastLineWidth = '80%', className } = props
  return (
    <div className={className} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {Array.from({ length: lines }).map((_, index) => (
        <Skeleton key={index} variant="text" width={index === lines - 1 ? lastLineWidth : width} />
      ))}
    </div>
  )
}
SkeletonText.displayName = 'SkeletonText'

export interface SkeletonCardProps {
  hasAvatar?: boolean
  hasActions?: boolean
  className?: string
}

/** SkeletonCard — a card-shaped skeleton, delegating to the platform's real one. */
export const SkeletonCard: React.FC<SkeletonCardProps> = (props) => {
  const HostSkeletonCard = getHostUi<React.FC<SkeletonCardProps>>('SkeletonCard')
  if (HostSkeletonCard) return <HostSkeletonCard {...props} />

  const { hasAvatar, hasActions, className } = props
  return (
    <div className={className} style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 16 }}>
      <div style={{ display: 'flex', gap: 12 }}>
        {hasAvatar && <Skeleton variant="circular" width={40} height={40} />}
        <div style={{ flex: 1 }}>
          <Skeleton variant="text" width="60%" />
          <div style={{ marginTop: 8 }}>
            <SkeletonText lines={2} />
          </div>
        </div>
      </div>
      {hasActions && (
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <Skeleton variant="rectangular" width={72} height={30} />
          <Skeleton variant="rectangular" width={72} height={30} />
        </div>
      )}
    </div>
  )
}
SkeletonCard.displayName = 'SkeletonCard'

// ---------------------------------------------------------------------------
// Tooltip
// ---------------------------------------------------------------------------

export type TooltipPlacement = 'top' | 'bottom' | 'left' | 'right'

export interface TooltipProps {
  content?: React.ReactNode
  placement?: TooltipPlacement
  delayDuration?: number
  disabled?: boolean
  className?: string
  children: React.ReactNode
}

/**
 * Tooltip — delegates to the platform's real Tooltip at render time. The fallback uses the
 * browser's native `title` attribute (only works when `content` is plain text).
 */
export const Tooltip: React.FC<TooltipProps> = (props) => {
  const HostTooltip = getHostUi<React.FC<TooltipProps>>('Tooltip')
  if (HostTooltip) return <HostTooltip {...props} />

  const { content, disabled, className, children } = props
  const titleText = typeof content === 'string' ? content : undefined
  if (disabled || !titleText) return <>{children}</>
  return (
    <span className={className} title={titleText} style={{ display: 'inline-flex' }}>
      {children}
    </span>
  )
}
Tooltip.displayName = 'Tooltip'

// ---------------------------------------------------------------------------
// Spinner
// ---------------------------------------------------------------------------

export type SpinnerSize = 'sm' | 'md' | 'lg'

export interface SpinnerProps {
  size?: SpinnerSize
  className?: string
  label?: string
}

const spinnerDiameter: Record<SpinnerSize, number> = { sm: 16, md: 24, lg: 32 }

/** Spinner — delegates to the platform's real Spinner at render time. */
export const Spinner: React.FC<SpinnerProps> = (props) => {
  const HostSpinner = getHostUi<React.FC<SpinnerProps>>('Spinner')
  if (HostSpinner) return <HostSpinner {...props} />

  const { size = 'md', className, label } = props
  const diameter = spinnerDiameter[size]
  return (
    <div className={className} role="status" aria-live="polite" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      <div
        aria-hidden="true"
        style={{
          width: diameter,
          height: diameter,
          borderRadius: '50%',
          border: '2px solid currentColor',
          borderTopColor: 'transparent',
          animation: 'vx-sdk-spin 0.8s linear infinite',
        }}
      />
      {label && <p style={{ marginTop: 8, fontSize: 12, color: '#6b7280' }}>{label}</p>}
      <span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>{label || 'Loading'}</span>
      <style>{'@keyframes vx-sdk-spin { to { transform: rotate(360deg) } }'}</style>
    </div>
  )
}
Spinner.displayName = 'Spinner'

// ---------------------------------------------------------------------------
// DataTable (generic)
// ---------------------------------------------------------------------------

export type DataTableAlign = 'left' | 'center' | 'right'
export type DataTableSortOrder = 'asc' | 'desc'

export interface DataTableSort {
  field: string
  order: DataTableSortOrder
}

export interface DataTableColumn<T> {
  key: string
  header: React.ReactNode
  render?: (row: T) => React.ReactNode
  sortable?: boolean
  align?: DataTableAlign
  width?: string
  className?: string
}

export interface DataTableEmptyState {
  icon?: React.ReactNode
  title: string
  description?: string
  action?: React.ReactNode
}

export interface DataTablePaginationState {
  page: number
  pageSize: number
  total: number
}

export interface DataTableProps<T> {
  columns: DataTableColumn<T>[]
  data: T[]
  rowKey: (row: T) => string
  isLoading?: boolean
  emptyState?: DataTableEmptyState
  sort?: DataTableSort
  onSortChange?: (sort: DataTableSort) => void
  pagination?: DataTablePaginationState
  onPageChange?: (page: number) => void
  onRowClick?: (row: T) => void
  rowActions?: (row: T) => React.ReactNode
  className?: string
}

type DataTableComponent = (<T>(props: DataTableProps<T>) => React.ReactElement) & { displayName?: string }

function FallbackDataTable<T>(props: DataTableProps<T>): React.ReactElement {
  const { columns, data, rowKey, isLoading, emptyState, onRowClick, rowActions, className } = props
  const showEmpty = !isLoading && data.length === 0

  return (
    <div className={className} style={fallbackNote}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} style={{ textAlign: column.align ?? 'left', padding: '8px 10px', borderBottom: '1px solid #d1d5db' }}>
                {column.header}
              </th>
            ))}
            {rowActions && <th style={{ padding: '8px 10px', borderBottom: '1px solid #d1d5db' }} />}
          </tr>
        </thead>
        <tbody>
          {isLoading && (
            <tr>
              <td colSpan={Math.max(columns.length + (rowActions ? 1 : 0), 1)} style={{ padding: '12px 10px' }}>
                Loading…
              </td>
            </tr>
          )}
          {showEmpty && (
            <tr>
              <td colSpan={Math.max(columns.length + (rowActions ? 1 : 0), 1)}>
                <EmptyState title={emptyState?.title ?? 'No data'} description={emptyState?.description} icon={emptyState?.icon} action={emptyState?.action} />
              </td>
            </tr>
          )}
          {!isLoading &&
            !showEmpty &&
            data.map((row) => (
              <tr
                key={rowKey(row)}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                style={{ cursor: onRowClick ? 'pointer' : undefined, borderBottom: '1px solid #e5e7eb' }}
              >
                {columns.map((column) => (
                  <td key={column.key} style={{ textAlign: column.align ?? 'left', padding: '8px 10px' }}>
                    {column.render ? column.render(row) : String((row as Record<string, unknown>)[column.key] ?? '')}
                  </td>
                ))}
                {rowActions && (
                  <td style={{ padding: '8px 10px' }} onClick={(event) => event.stopPropagation()}>
                    {rowActions(row)}
                  </td>
                )}
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  )
}

/**
 * DataTable — delegates to the platform's real, server-driven DataTable at render time.
 *
 * @example
 * <DataTable
 *   columns={[{ key: 'name', header: 'Name' }, { key: 'deployState', header: 'Status', render: (r) => <Badge>{r.deployState}</Badge> }]}
 *   data={indexes}
 *   rowKey={(row) => row.id}
 * />
 */
export function DataTable<T>(props: DataTableProps<T>): React.ReactElement {
  const HostDataTable = getHostUi<DataTableComponent>('DataTable')
  if (HostDataTable) return <HostDataTable {...props} />
  return <FallbackDataTable {...props} />
}

// ---------------------------------------------------------------------------
// StatsCard
// ---------------------------------------------------------------------------

export type StatsCardVariant = 'default' | 'primary' | 'success' | 'warning' | 'danger' | 'info'

export interface StatsCardDelta {
  value: string
  direction: 'up' | 'down' | 'neutral'
  label?: string
}

export interface StatsCardProps {
  label: string
  value: React.ReactNode
  icon?: React.ReactNode
  delta?: StatsCardDelta
  variant?: StatsCardVariant
  isLoading?: boolean
  onClick?: () => void
  className?: string
}

const DELTA_FALLBACK_COLOR: Record<StatsCardDelta['direction'], string> = {
  up: '#16a34a',
  down: '#dc2626',
  neutral: '#6b7280',
}

/**
 * StatsCard — delegates to the platform's real StatsCard at render time.
 *
 * @example
 * <StatsCard label="Indexes" value={indexes.length} delta={{ value: '+2', direction: 'up' }} />
 */
export const StatsCard: React.FC<StatsCardProps> = (props) => {
  const HostStatsCard = getHostUi<React.FC<StatsCardProps>>('StatsCard')
  if (HostStatsCard) return <HostStatsCard {...props} />

  const { label, value, icon, delta, isLoading, onClick, className } = props
  const isClickable = Boolean(onClick)

  return (
    <div
      role={isClickable ? 'button' : undefined}
      tabIndex={isClickable ? 0 : undefined}
      onClick={onClick}
      onKeyDown={
        isClickable
          ? (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                onClick?.()
              }
            }
          : undefined
      }
      className={className}
      style={{
        ...fallbackNote,
        border: '1px solid #d1d5db',
        borderRadius: 8,
        padding: 16,
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 12,
        cursor: isClickable ? 'pointer' : undefined,
      }}
    >
      <div style={{ minWidth: 0, flex: 1 }}>
        <p style={{ fontSize: 13, color: '#6b7280', margin: 0 }}>{label}</p>
        <p style={{ fontSize: 28, fontWeight: 700, margin: '4px 0 0' }}>{isLoading ? '…' : value}</p>
        {delta && !isLoading && (
          <p style={{ fontSize: 13, color: DELTA_FALLBACK_COLOR[delta.direction], margin: '4px 0 0' }}>
            {delta.value} {delta.label}
          </p>
        )}
      </div>
      {icon && <div aria-hidden="true">{icon}</div>}
    </div>
  )
}
StatsCard.displayName = 'StatsCard'

// ---------------------------------------------------------------------------
// FormDialog
// ---------------------------------------------------------------------------

export type FormDialogSize = 'sm' | 'md' | 'lg'

export interface FormDialogProps {
  isOpen: boolean
  onClose: () => void
  title: string
  description?: string
  children: React.ReactNode
  onSubmit: () => void | Promise<void>
  submitText?: string
  cancelText?: string
  isSubmitting?: boolean
  error?: string | null
  size?: FormDialogSize
  disableBackdropClose?: boolean
  submitDisabled?: boolean
}

const FORM_DIALOG_MAX_WIDTH: Record<FormDialogSize, number> = { sm: 420, md: 520, lg: 680 }

/**
 * FormDialog — delegates to the platform's real FormDialog at render time. The fallback is
 * a minimal, accessible modal shell (role="dialog", Escape-to-close, backdrop click) without
 * the host's focus-trap polish.
 *
 * @example
 * <FormDialog isOpen={isOpen} onClose={close} title="Add index" onSubmit={handleSubmit}>
 *   <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} />
 * </FormDialog>
 */
export const FormDialog: React.FC<FormDialogProps> = (props) => {
  const HostFormDialog = getHostUi<React.FC<FormDialogProps>>('FormDialog')
  if (HostFormDialog) return <HostFormDialog {...props} />

  const {
    isOpen,
    onClose,
    title,
    description,
    children,
    onSubmit,
    submitText = 'Save',
    cancelText = 'Cancel',
    isSubmitting = false,
    error = null,
    size = 'md',
    disableBackdropClose = false,
    submitDisabled = false,
  } = props

  React.useEffect(() => {
    if (!isOpen) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isSubmitting) onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, isSubmitting, onClose])

  if (!isOpen) return null

  const requestClose = () => {
    if (!isSubmitting) onClose()
  }

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }}
      onClick={disableBackdropClose ? undefined : requestClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{ background: 'white', color: 'black', borderRadius: 8, width: '100%', maxWidth: FORM_DIALOG_MAX_WIDTH[size], maxHeight: '80vh', overflow: 'auto', ...fallbackNote }}
        onClick={(event) => event.stopPropagation()}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void onSubmit()
          }}
        >
          <div style={{ padding: 16, borderBottom: '1px solid #d1d5db' }}>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{title}</h3>
            {description && <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7280' }}>{description}</p>}
          </div>
          <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
            {error && (
              <p role="alert" style={{ margin: 0, fontSize: 13, color: '#dc2626' }}>
                {error}
              </p>
            )}
            {children}
          </div>
          <div style={{ padding: 16, borderTop: '1px solid #d1d5db', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Button type="button" variant="secondary" onClick={requestClose} disabled={isSubmitting}>
              {cancelText}
            </Button>
            <Button type="submit" variant="primary" isLoading={isSubmitting} disabled={submitDisabled}>
              {submitText}
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}
FormDialog.displayName = 'FormDialog'

// ---------------------------------------------------------------------------
// useToast / useConfirmDialog
//
// Unlike the components above, these are HOOKS the host backs with real React
// context (ToastContext / ConfirmationDialogContext), whose providers the
// platform's root App.tsx mounts around the entire tree — including app
// pages, since they render inside the host's own React instance. So inside
// Veltrix these resolve to the real, working implementation with no extra
// wiring. Outside the platform (no host, or an older host) they degrade to a
// safe, non-throwing fallback instead of crashing: `toast()` logs to the
// console and `confirm()` resolves to `false` (fails closed — no destructive
// action proceeds without an explicit user confirmation the fallback cannot
// provide).
// ---------------------------------------------------------------------------

export type ToastVariant = 'success' | 'error' | 'warning' | 'info'

export interface ToastOptions {
  variant?: ToastVariant
  duration?: number
  action?: { label: string; onClick: () => void }
}

export interface Toast {
  id: string
  message: string
  variant: ToastVariant
  duration?: number
  action?: { label: string; onClick: () => void }
}

export interface ToastContextValue {
  toasts: Toast[]
  toast: (message: string, options?: ToastOptions) => string
  success: (message: string, duration?: number) => string
  error: (message: string, duration?: number) => string
  warning: (message: string, duration?: number) => string
  info: (message: string, duration?: number) => string
  promise: <T>(
    promise: Promise<T>,
    messages: { loading: string; success: string | ((data: T) => string); error: string | ((error: unknown) => string) },
  ) => Promise<T>
  dismiss: (id: string) => void
  dismissAll: () => void
}

function fallbackToast(message: string, options?: ToastOptions): string {
  // eslint-disable-next-line no-console -- deliberate: this IS the fallback surface.
  console.warn(`[@veltrixsecops/app-sdk/ui] Toast (${options?.variant ?? 'info'}): ${message}`)
  return 'fallback-toast'
}

const fallbackToastContext: ToastContextValue = {
  toasts: [],
  toast: fallbackToast,
  success: (message) => fallbackToast(message, { variant: 'success' }),
  error: (message) => fallbackToast(message, { variant: 'error' }),
  warning: (message) => fallbackToast(message, { variant: 'warning' }),
  info: (message) => fallbackToast(message, { variant: 'info' }),
  promise: (promise) => promise,
  dismiss: () => {},
  dismissAll: () => {},
}

/**
 * useToast — delegates to the platform's real toast system when running inside Veltrix.
 * Outside it, `toast()`/`success()`/etc. log to the console instead of throwing.
 *
 * @example
 * const toast = useToast()
 * toast.success('Index saved')
 */
export function useToast(): ToastContextValue {
  const hostUseToast = getHostUi<() => ToastContextValue>('useToast')
  // eslint-disable-next-line react-hooks/rules-of-hooks -- `hostUseToast` IS the real hook;
  // its presence is fixed for the app's lifetime (the host runtime installs once at boot),
  // so this never actually violates the "same hooks every render" invariant in practice.
  if (hostUseToast) return hostUseToast()
  return fallbackToastContext
}

export type ConfirmationVariant = 'danger' | 'warning' | 'info'

export interface ConfirmationOptions {
  title: string
  message: string
  confirmText?: string
  cancelText?: string
  variant?: ConfirmationVariant
}

export interface ConfirmationDialogContextValue {
  confirm: (options: ConfirmationOptions) => Promise<boolean>
}

const fallbackConfirmationContext: ConfirmationDialogContextValue = {
  confirm: (options) => {
    // eslint-disable-next-line no-console -- deliberate: this IS the fallback surface.
    console.warn(
      `[@veltrixsecops/app-sdk/ui] ConfirmationDialog is only available inside the Veltrix platform — ` +
        `"${options.title}" auto-resolved to "not confirmed" (fail closed).`,
    )
    return Promise.resolve(false)
  },
}

/**
 * useConfirmDialog — delegates to the platform's real confirmation dialog when running
 * inside Veltrix. Outside it, `confirm()` resolves to `false` (fails closed) rather than
 * throwing, so a guarded destructive action simply never proceeds instead of crashing.
 *
 * @example
 * const { confirm } = useConfirmDialog()
 * if (await confirm({ title: 'Delete index', message: 'This cannot be undone.', variant: 'danger' })) {
 *   await deleteIndex(id)
 * }
 */
export function useConfirmDialog(): ConfirmationDialogContextValue {
  const hostUseConfirmDialog = getHostUi<() => ConfirmationDialogContextValue>('useConfirmDialog')
  // eslint-disable-next-line react-hooks/rules-of-hooks -- see useToast's note above.
  if (hostUseConfirmDialog) return hostUseConfirmDialog()
  return fallbackConfirmationContext
}
