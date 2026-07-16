import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))

export default {
  id: 'snyk',
  pages: { OverviewPage, SetupGuidePage, ConnectionsPage },
  sidebarItems: [
    { path: '/apps/snyk/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/snyk/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/snyk/connections', label: 'Connections', icon: 'link' },
  ],
}
