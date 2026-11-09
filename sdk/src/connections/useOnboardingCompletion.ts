import { useCallback, useEffect, useRef, useState } from 'react'
import { completeOnboarding, type OnboardPending } from '../client'

/**
 * Drives a pending (polled) onboarding flow: while the admin performs the
 * out-of-band step, the hook asks the platform every `pollIntervalSeconds`
 * whether it can verify the step, stops on success, expiry or a hard error,
 * and offers an immediate "verify now".
 */
export type OnboardingCompletionStatus =
  | { phase: 'waiting'; message: string | null }
  | { phase: 'checking'; message: string | null }
  | { phase: 'done'; connectionId: string; connectionName: string }
  | { phase: 'expired'; message: string }
  | { phase: 'error'; message: string }

export interface OnboardingCompletionDone {
  connectionId: string
  connectionName: string
  manualStepsPending: boolean
}

export function useOnboardingCompletion(
  appId: string,
  pending: OnboardPending | null,
  onDone: (result: OnboardingCompletionDone) => void,
): { status: OnboardingCompletionStatus; verifyNow: () => void } {
  const [status, setStatus] = useState<OnboardingCompletionStatus>({ phase: 'waiting', message: null })
  const inFlight = useRef(false)
  const stopped = useRef(false)
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone

  const attempt = useCallback(async () => {
    if (!pending || inFlight.current || stopped.current) return
    inFlight.current = true
    setStatus((prev) => (prev.phase === 'waiting' || prev.phase === 'error' ? { phase: 'checking', message: prev.message } : prev))
    try {
      const result = await completeOnboarding(appId, pending.state)
      if (stopped.current) return
      if (result.status === 'done') {
        stopped.current = true
        setStatus({ phase: 'done', connectionId: result.connectionId, connectionName: result.connectionName })
        onDoneRef.current(result)
      } else if (result.status === 'expired') {
        stopped.current = true
        setStatus({ phase: 'expired', message: result.message })
      } else {
        setStatus({ phase: 'waiting', message: result.message })
      }
    } catch (e) {
      if (!stopped.current) setStatus({ phase: 'error', message: (e as Error).message })
    } finally {
      inFlight.current = false
    }
  }, [appId, pending])

  useEffect(() => {
    stopped.current = false
    setStatus({ phase: 'waiting', message: null })
    if (!pending) return
    const intervalMs = Math.max(2, pending.pollIntervalSeconds) * 1000
    const timer = setInterval(() => void attempt(), intervalMs)
    const expiry = setTimeout(() => {
      stopped.current = true
      setStatus({ phase: 'expired', message: 'This session timed out before the step was verified. Start again.' })
    }, Math.max(intervalMs, pending.expiresInSeconds * 1000))
    return () => {
      stopped.current = true
      clearInterval(timer)
      clearTimeout(expiry)
    }
  }, [pending, attempt])

  return { status, verifyNow: () => void attempt() }
}
