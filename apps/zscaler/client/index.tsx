import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))

export default {
  id: 'zscaler',
  pages: { OverviewPage, SetupGuidePage },
  sidebarItems: [
    { path: '/apps/zscaler/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/zscaler/setup', label: 'Setup Guide', icon: 'book' },
  ],
}
