import { useEffect, useState } from 'react'
import { Navigate, Outlet } from 'react-router-dom'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import CircularProgress from '@mui/material/CircularProgress'

import { api } from '../api/client'
import { useAuthStore } from '../store/authStore'
import type { Role, User } from '../api/types'

interface Props {
  allowedRoles?: Role[]
}

export function PrivateRoute({ allowedRoles }: Props) {
  const {
    isAuthenticated, user, token, sessionExpiresAt, sessionValidated,
    setAuth, clearAuth,
  } = useAuthStore()
  const [validationError, setValidationError] = useState(false)
  const [retry, setRetry] = useState(0)
  const hasUnexpiredClientSession = Boolean(
    isAuthenticated && token && sessionExpiresAt && sessionExpiresAt > Date.now(),
  )

  useEffect(() => {
    if (!hasUnexpiredClientSession || sessionValidated || !token) return
    let cancelled = false
    setValidationError(false)
    api.get<User>('/auth/me')
      .then((response) => {
        if (!cancelled) setAuth(response.data, token)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        const status = (error as { response?: { status?: number } })?.response?.status
        if (status === 401) clearAuth()
        else setValidationError(true)
      })
    return () => { cancelled = true }
  }, [hasUnexpiredClientSession, sessionValidated, token, setAuth, clearAuth, retry])

  if (!hasUnexpiredClientSession) {
    return <Navigate to="/login" replace />
  }

  // Do not mount reports from browser storage until the server confirms the
  // restored session. This prevents expired sessions firing every dashboard
  // query at once and producing the dashboard/login redirect loop.
  if (!sessionValidated) {
    return (
      <Box className="min-h-screen flex items-center justify-center" sx={{ background: '#F4F6FA' }}>
        {validationError ? (
          <Alert
            severity="warning"
            action={<Button color="inherit" size="small" onClick={() => setRetry((value) => value + 1)}>Retry</Button>}
          >
            Unable to validate your session. Check the connection and retry.
          </Alert>
        ) : <CircularProgress size={28} />}
      </Box>
    )
  }

  if (allowedRoles && user && !allowedRoles.includes(user.role)) {
    return <Navigate to="/dashboard" replace />
  }

  return <Outlet />
}
