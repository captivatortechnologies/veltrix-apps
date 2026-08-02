import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))

export default {
  id: 'datadog',
  pages: { OverviewPage, SetupGuidePage, ConnectionsPage },
  sidebarItems: [
    { path: '/apps/datadog/overview', label: 'Overview', icon: 'activity' },
    { path: '/apps/datadog/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/datadog/connections', label: 'Connections', icon: 'link' },
  ],
}
