import * as React from 'react'
import { act, render, screen, fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OnboardPending } from '../../client'

const completeOnboarding = vi.fn()
vi.mock('../../client', async () => {
  const actual = await vi.importActual<typeof import('../../client')>('../../client')
  return { ...actual, completeOnboarding: (...args: unknown[]) => completeOnboarding(...args) }
})

import { useOnboardingCompletion } from '../useOnboardingCompletion'
import { OnboardingPendingPanel } from '../OnboardingPendingPanel'

const PENDING: OnboardPending = {
  state: 's1',
  title: 'Create the IAM role in account 123456789012',
  instructions: ['Open the console link.', 'Veltrix checks every few seconds.'],
  cliCommands: ['aws iam create-role --role-name VeltrixGovernance'],
  openInNewTab: true,
  pollIntervalSeconds: 5,
  expiresInSeconds: 60,
}

function Harness({ pending, onDone, authorizeUrl = '' }: { pending: OnboardPending | null; onDone: (r: unknown) => void; authorizeUrl?: string }) {
  const { status, verifyNow } = useOnboardingCompletion('cloud-governance', pending, onDone)
  return pending ? (
    <OnboardingPendingPanel pending={pending} authorizeUrl={authorizeUrl} status={status} onVerifyNow={verifyNow} onClose={() => undefined} />
  ) : null
}

beforeEach(() => {
  vi.useFakeTimers()
  completeOnboarding.mockReset()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('useOnboardingCompletion + OnboardingPendingPanel', () => {
  it('polls on the declared interval, shows the server message while pending and finishes on done', async () => {
    completeOnboarding
      .mockResolvedValueOnce({ status: 'pending', message: 'Waiting for the role' })
      .mockResolvedValueOnce({ status: 'done', connectionId: 'c1', connectionName: 'Prod', manualStepsPending: false })
    const onDone = vi.fn()
    render(<Harness pending={PENDING} onDone={onDone} />)

    expect(screen.getByText('Create the IAM role in account 123456789012')).toBeTruthy()
    expect(screen.getByText('Open the console link.')).toBeTruthy()
    expect(completeOnboarding).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })
    expect(completeOnboarding).toHaveBeenCalledWith('cloud-governance', 's1')
    expect(screen.getByText('Waiting for the role')).toBeTruthy()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })
    expect(onDone).toHaveBeenCalledWith({ status: 'done', connectionId: 'c1', connectionName: 'Prod', manualStepsPending: false })
    expect(screen.getByText(/Connected: Prod/)).toBeTruthy()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20000)
    })
    expect(completeOnboarding).toHaveBeenCalledTimes(2)
  })

  it('"Verify now" checks immediately and stops on expiry', async () => {
    completeOnboarding.mockResolvedValueOnce({ status: 'expired', message: 'Session expired' })
    render(<Harness pending={PENDING} onDone={() => undefined} />)
    await act(async () => {
      fireEvent.click(screen.getByText('Verify now'))
      await Promise.resolve()
    })
    expect(completeOnboarding).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('alert').textContent).toContain('Session expired')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000)
    })
    expect(completeOnboarding).toHaveBeenCalledTimes(1)
  })

  it('surfaces a hard error without stopping the next poll, and times out locally', async () => {
    completeOnboarding.mockRejectedValueOnce(new Error('could not assume role')).mockResolvedValue({ status: 'pending', message: 'still waiting' })
    render(<Harness pending={PENDING} onDone={() => undefined} />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })
    expect(screen.getByRole('alert').textContent).toContain('could not assume role')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })
    expect(screen.getByText('still waiting')).toBeTruthy()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000)
    })
    expect(screen.getByRole('alert').textContent).toContain('timed out')
  })

  it('renders the console button only when a hosted link exists, and the commands with copy buttons', () => {
    completeOnboarding.mockResolvedValue({ status: 'pending', message: null })
    const { rerender } = render(<Harness pending={PENDING} onDone={() => undefined} />)
    expect(screen.queryByText('Open the console link')).toBeNull()
    expect(screen.getByText('aws iam create-role --role-name VeltrixGovernance')).toBeTruthy()
    expect(screen.getByLabelText('Copy command')).toBeTruthy()
    rerender(<Harness pending={PENDING} onDone={() => undefined} authorizeUrl="https://console.aws.amazon.com/x" />)
    expect(screen.getByText('Open the console link')).toBeTruthy()
  })
})
