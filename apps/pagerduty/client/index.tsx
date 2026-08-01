import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))

export default {
  id: 'pagerduty',
  pages: { OverviewPage, SetupGuidePage, ConnectionsPage },
  sidebarItems: [
    { path: '/apps/pagerduty/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/pagerduty/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/pagerduty/connections', label: 'Connections', icon: 'link' },
  ],
}
