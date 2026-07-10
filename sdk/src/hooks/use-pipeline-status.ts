import { useState, useEffect, useCallback } from 'react'

export interface PipelineStatusData {
  pendingApprovals: number
  activeDeployments: number
  failedDeployments: number
  unresolvedDrifts: number
  recentDeployments: Array<{
    id: string
    canvasName: string
    environment: string
    status: string
    startedAt: string
    completedAt?: string
  }>
}

/**
 * Hook to access pipeline status for the current app/customer.
 *
 * @example
 * ```tsx
 * import { usePipelineStatus } from '@veltrixsecops/app-sdk/hooks'
 *
 * function Dashboard() {
 *   const { data, isLoading } = usePipelineStatus('my-app')
 *   if (isLoading) return <Spinner />
 *   return <div>{data.activeDeployments} active deployments</div>
 * }
 * ```
 */
export function usePipelineStatus(appId: string) {
  const [data, setData] = useState<PipelineStatusData | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  const refresh = useCallback(async () => {
    try {
      setIsLoading(true)
      const response = await fetch(`/api/pipeline/summary?appId=${appId}`)
      if (!response.ok) throw new Error(`Failed to fetch pipeline status`)
      const result = await response.json()
      setData(result)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Unknown error'))
    } finally {
      setIsLoading(false)
    }
  }, [appId])

  useEffect(() => {
    refresh()
  }, [refresh])

  return { data, isLoading, error, refresh }
}
