// =============================================================================
// Example App Dashboard Page
//
// Use platform shared components for consistent UI.
// Access pipeline data through the platform's hooks and APIs.
// =============================================================================

import React from 'react'

// These would be imported from @veltrix/app-sdk in production:
// import { useAppContext, useAppSettings, usePipelineStatus } from '@veltrix/app-sdk'

export default function Dashboard() {
  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-6">
        My App Dashboard
      </h1>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
        {/* Stats cards */}
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
          <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400">Configurations</h3>
          <p className="text-3xl font-bold text-gray-900 dark:text-white mt-2">0</p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
          <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400">Deployed</h3>
          <p className="text-3xl font-bold text-green-600 mt-2">0</p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
          <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400">Drift Alerts</h3>
          <p className="text-3xl font-bold text-red-600 mt-2">0</p>
        </div>
      </div>

      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
          Getting Started
        </h2>
        <p className="text-gray-600 dark:text-gray-300">
          This is your app dashboard. Customize it to show relevant data
          from your tool integration.
        </p>
        <ul className="mt-4 space-y-2 text-gray-600 dark:text-gray-300">
          <li>1. Add components (hosts/servers) for your tool</li>
          <li>2. Add credentials for authentication</li>
          <li>3. Create a configuration canvas</li>
          <li>4. Submit for approval and deploy through the pipeline</li>
        </ul>
      </div>
    </div>
  )
}
