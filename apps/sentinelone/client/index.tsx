import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))

export default {
  id: 'sentinelone',
  pages: { OverviewPage, SetupGuidePage },
  sidebarItems: [
    { path: '/apps/sentinelone/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/sentinelone/setup', label: 'Setup Guide', icon: 'book' },
  ],
}
