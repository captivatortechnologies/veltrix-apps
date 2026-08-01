import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))

export default {
  id: 'servicenow',
  pages: { OverviewPage, SetupGuidePage, ConnectionsPage },
  sidebarItems: [
    { path: '/apps/servicenow/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/servicenow/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/servicenow/connections', label: 'Connections', icon: 'link' },
  ],
}
