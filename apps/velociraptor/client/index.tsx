import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))

export default {
  id: 'velociraptor',
  pages: { OverviewPage, SetupGuidePage, ConnectionsPage },
  sidebarItems: [
    { path: '/apps/velociraptor/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/velociraptor/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/velociraptor/connections', label: 'Connections', icon: 'link' },
  ],
}
