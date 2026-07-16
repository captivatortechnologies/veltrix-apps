import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))

export default {
  id: 'snyk',
  pages: { OverviewPage, SetupGuidePage },
  sidebarItems: [
    { path: '/apps/snyk/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/snyk/setup', label: 'Setup Guide', icon: 'book' },
  ],
}
