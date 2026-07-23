// =============================================================================
// ActivatePage — the one-time credential handoff (customer sets the admin pw).
//
// Reached from the emailed single-use link (?token=…). Validates the token via
// the app server, then lets the admin set their own password — relayed straight
// to Splunk. Veltrix never shows or stores a password here.
// =============================================================================

import React, { useCallback, useEffect, useState } from 'react'
import { authFetch } from '@veltrixsecops/app-sdk/client'
import { Card, CardHeader, CardBody, Input, FormField, Button, Alert, Spinner } from '@veltrixsecops/app-sdk/ui'

const MIN_PASSWORD_LENGTH = 15
const API_BASE = '/api/apps/splunk-enterprise/activation'

interface LinkInfo {
  environmentName: string | null
  adminUser: string
  expiresAt: string
}

type Phase = 'loading' | 'invalid' | 'form' | 'submitting' | 'done'

function tokenFromUrl(): string {
  if (typeof window === 'undefined') return ''
  return new URLSearchParams(window.location.search).get('token') ?? ''
}

export default function ActivatePage() {
  const [token] = useState(tokenFromUrl)
  const [phase, setPhase] = useState<Phase>('loading')
  const [info, setInfo] = useState<LinkInfo | null>(null)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)

  // Validate the link on mount.
  useEffect(() => {
    let cancelled = false
    if (!token) {
      setPhase('invalid')
      return
    }
    ;(async () => {
      try {
        const res = await authFetch(`${API_BASE}/${encodeURIComponent(token)}`)
        if (cancelled) return
        if (!res.ok) {
          setPhase('invalid')
          return
        }
        setInfo((await res.json()) as LinkInfo)
        setPhase('form')
      } catch {
        if (!cancelled) setPhase('invalid')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [token])

  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault()
      setError(null)
      if (password.length < MIN_PASSWORD_LENGTH) {
        setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`)
        return
      }
      if (password !== confirm) {
        setError('Passwords do not match.')
        return
      }
      setPhase('submitting')
      try {
        const res = await authFetch(`${API_BASE}/${encodeURIComponent(token)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password }),
        })
        if (res.ok) {
          setPhase('done')
          return
        }
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        setError(body.error ?? 'Could not set the password. Please try again.')
        setPhase('form')
      } catch {
        setError('Network error. Please try again.')
        setPhase('form')
      }
    },
    [password, confirm, token],
  )

  return (
    <div style={{ maxWidth: 460, margin: '48px auto', padding: '0 16px' }}>
      <Card variant="bordered">
        <CardHeader title="Activate your Splunk environment" />
        <CardBody>
          {phase === 'loading' && <Spinner />}

          {phase === 'invalid' && (
            <Alert variant="danger" title="This activation link is invalid or has expired.">
              Activation links can be used once and expire after 24 hours. Ask an administrator to
              re-issue the link if you still need access.
            </Alert>
          )}

          {phase === 'done' && (
            <Alert variant="success" title="Password set">
              Your administrator password for{' '}
              <strong>{info?.environmentName ?? 'the environment'}</strong> is set. Sign in to Splunk
              Web as <code>{info?.adminUser ?? 'admin'}</code> with your new password.
            </Alert>
          )}

          {(phase === 'form' || phase === 'submitting') && info && (
            <form onSubmit={submit}>
              <p style={{ marginTop: 0, fontSize: 14, color: 'rgb(var(--color-content-secondary))' }}>
                Set the administrator (<code>{info.adminUser}</code>) password for{' '}
                <strong>{info.environmentName ?? 'your environment'}</strong>. This is the only time it
                is set here — it is sent directly to Splunk and never stored by Veltrix.
              </p>

              {error && (
                <div style={{ margin: '12px 0' }}>
                  <Alert variant="danger">{error}</Alert>
                </div>
              )}

              <FormField label="New password" htmlFor="pw">
                <Input
                  id="pw"
                  type="password"
                  value={password}
                  autoComplete="new-password"
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
                />
              </FormField>

              <FormField label="Confirm password" htmlFor="pw2">
                <Input
                  id="pw2"
                  type="password"
                  value={confirm}
                  autoComplete="new-password"
                  onChange={(e) => setConfirm(e.target.value)}
                />
              </FormField>

              <div style={{ marginTop: 16 }}>
                <Button type="submit" variant="primary" isLoading={phase === 'submitting'}>
                  Set password
                </Button>
              </div>
            </form>
          )}
        </CardBody>
      </Card>
    </div>
  )
}
