import { Outlet, Navigate, useLocation } from 'react-router-dom'
import Box from '@mui/material/Box'
import { Sidebar } from './Sidebar'
import { SlicerPanel } from '../SlicerPanel'
import { useAuthStore } from '../../store/authStore'
import { canSeePath, firstAllowedPath } from '../../lib/reportAccess'

export function AppShell() {
  const location = useLocation()
  const { user } = useAuthStore()

  // Report-visibility guard: block direct URL access to reports the user
  // cannot see and land them on their first allowed page instead.
  if (user && !canSeePath(user, location.pathname)) {
    return <Navigate to={firstAllowedPath(user)} replace />
  }

  return (
    <Box className="flex h-screen overflow-hidden" sx={{ background: '#F4F6FA' }}>
      {/* Left: collapsible nav sidebar */}
      <Sidebar />

      {/* Centre: main content (global top bar removed — each report has its own
          compact title bar, so the space is reclaimed for content) */}
      <Box className="flex flex-col flex-1 min-w-0 overflow-hidden">
        <Box
          component="main"
          className="flex-1 overflow-y-auto"
          sx={{ padding: '14px 20px', background: '#F4F6FA' }}
        >
          <Outlet />
        </Box>
      </Box>

      {/* Right: collapsible filter/slicer panel */}
      <SlicerPanel />
    </Box>
  )
}
