import React, { useState } from 'react'
import type { OnboardPending } from '../client'
import { Badge, Button, Modal, Spinner } from '../ui'
import type { OnboardingCompletionStatus } from './useOnboardingCompletion'

export interface OnboardingPendingPanelProps {
  pending: OnboardPending
  /** The provider's hosted page, when there is one (opens in a new tab). */
  authorizeUrl: string
  status: OnboardingCompletionStatus
  onVerifyNow: () => void
  onClose: () => void
}

function CopyableCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
      <pre
        style={{
          flex: 1,
          margin: 0,
          padding: '8px 10px',
          fontSize: 12,
          lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
          borderRadius: 6,
          border: '1px solid rgb(var(--color-border) / 1)',
          background: 'rgb(var(--color-surface-muted) / 1)',
          color: 'rgb(var(--color-content-primary) / 1)',
        }}
      >
        <code>{command}</code>
      </pre>
      <Button variant="ghost" size="sm" onClick={() => void copy()} aria-label="Copy command">
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  )
}

function StatusLine({ status }: { status: OnboardingCompletionStatus }) {
  switch (status.phase) {
    case 'done':
      return (
        <Badge variant="success" size="sm">
          Connected: {status.connectionName}
        </Badge>
      )
    case 'expired':
      return <p role="alert" style={{ margin: 0 }}>{status.message}</p>
    case 'error':
      return <p role="alert" style={{ margin: 0 }}>{status.message}</p>
    case 'checking':
    case 'waiting':
      return (
        <div role="status" style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
          <Spinner size="sm" />
          <span>{status.phase === 'checking' ? 'Checking…' : status.message ?? 'Waiting for the step to complete…'}</span>
        </div>
      )
  }
}

/**
 * Shown after `startOnboarding` returns a `pending` descriptor: what the admin
 * must do elsewhere, the hosted page link and the manual commands, plus the
 * live verification status driven by `useOnboardingCompletion`.
 */
export function OnboardingPendingPanel({ pending, authorizeUrl, status, onVerifyNow, onClose }: OnboardingPendingPanelProps) {
  const finished = status.phase === 'done' || status.phase === 'expired'
  return (
    <Modal
      isOpen
      onClose={onClose}
      title={pending.title}
      size="lg"
      disableBackdropClose
      footer={
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button variant="secondary" size="sm" onClick={onClose}>
            {finished ? 'Close' : 'Cancel'}
          </Button>
          {!finished ? (
            <Button variant="primary" size="sm" onClick={onVerifyNow} isLoading={status.phase === 'checking'}>
              Verify now
            </Button>
          ) : null}
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <ol style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 6, fontSize: 14 }}>
          {pending.instructions.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ol>
        {authorizeUrl ? (
          <div>
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                if (typeof window !== 'undefined') window.open(authorizeUrl, '_blank', 'noopener,noreferrer')
              }}
            >
              Open the console link
            </Button>
          </div>
        ) : null}
        {pending.cliCommands.length ? (
          <details open={!authorizeUrl}>
            <summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
              {authorizeUrl ? 'Prefer the CLI? Run these instead' : 'Commands'}
            </summary>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
              {pending.cliCommands.map((command) => (
                <CopyableCommand key={command} command={command} />
              ))}
            </div>
          </details>
        ) : null}
        <StatusLine status={status} />
      </div>
    </Modal>
  )
}
