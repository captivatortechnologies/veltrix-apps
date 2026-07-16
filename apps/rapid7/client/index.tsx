import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))

export default {
  id: 'rapid7',
  pages: { OverviewPage, SetupGuidePage },
  sidebarItems: [
    { path: '/apps/rapid7/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/rapid7/setup', label: 'Setup Guide', icon: 'book' },
  ],
}
