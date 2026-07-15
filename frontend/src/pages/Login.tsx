import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Box from '@mui/material/Box'
import TextField from '@mui/material/TextField'
import Button from '@mui/material/Button'
import Alert from '@mui/material/Alert'
import CircularProgress from '@mui/material/CircularProgress'
import InputAdornment from '@mui/material/InputAdornment'
import IconButton from '@mui/material/IconButton'
import VisibilityIcon from '@mui/icons-material/Visibility'
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff'
import LockOutlinedIcon from '@mui/icons-material/LockOutlined'
import { api } from '../api/client'
import { useAuthStore } from '../store/authStore'
import type { AuthResponse } from '../api/types'

export function Login() {
  const navigate = useNavigate()
  const setAuth = useAuthStore((s) => s.setAuth)

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPass, setShowPass] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!username.trim() || !password) return
    setLoading(true)
    setError('')
    try {
      const { data } = await api.post<AuthResponse>('/auth/login', { username: username.trim(), password })
      setAuth(data.user, data.access_token)
      navigate('/dashboard')
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      setError(msg ?? 'Login failed. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Box
      className="min-h-screen flex items-center justify-center"
      sx={{
        background: 'radial-gradient(ellipse at 60% 30%, #0f2a4a 0%, #081525 60%, #040c18 100%)',
      }}
    >
      {/* Background grid pattern */}
      <Box
        className="absolute inset-0 pointer-events-none"
        sx={{
          backgroundImage: 'linear-gradient(rgba(46,125,204,0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(46,125,204,0.04) 1px, transparent 1px)',
          backgroundSize: '40px 40px',
        }}
      />

      <Box
        component="form"
        onSubmit={handleSubmit}
        className="relative w-full max-w-sm mx-4"
        sx={{
          background: '#112845',
          border: '1px solid rgba(46,125,204,0.25)',
          borderRadius: 3,
          boxShadow: '0 24px 64px rgba(0,0,0,0.5)',
          overflow: 'hidden',
        }}
      >
        {/* Top accent line */}
        <Box sx={{ height: 3, background: 'linear-gradient(90deg, #2E7DCC, #1DB87A)' }} />

        <Box className="p-8">
          {/* Logo */}
          <Box className="text-center mb-8">
            <Box
              className="inline-flex items-center justify-center w-12 h-12 rounded-full mb-4"
              sx={{ background: 'rgba(46,125,204,0.15)', border: '1px solid rgba(46,125,204,0.3)' }}
            >
              <LockOutlinedIcon sx={{ color: '#2E7DCC', fontSize: 22 }} />
            </Box>
            <Box className="text-lg font-bold tracking-wider text-text-primary uppercase">
              Ananya Finance
            </Box>
            <Box className="text-xs text-text-muted mt-0.5">MIS Dashboard — Sign In</Box>
          </Box>

          {error && (
            <Alert severity="error" sx={{ mb: 3, fontSize: '0.8rem' }}>
              {error}
            </Alert>
          )}

          <Box className="flex flex-col gap-4">
            <TextField
              label="Username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              fullWidth
              autoFocus
              autoComplete="username"
              InputLabelProps={{ sx: { fontSize: '0.875rem' } }}
              InputProps={{ sx: { fontSize: '0.875rem' } }}
            />

            <TextField
              label="Password"
              type={showPass ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              fullWidth
              autoComplete="current-password"
              InputLabelProps={{ sx: { fontSize: '0.875rem' } }}
              InputProps={{
                sx: { fontSize: '0.875rem' },
                endAdornment: (
                  <InputAdornment position="end">
                    <IconButton
                      onClick={() => setShowPass((v) => !v)}
                      edge="end"
                      size="small"
                      sx={{ color: '#7FA8D4' }}
                    >
                      {showPass ? <VisibilityOffIcon fontSize="small" /> : <VisibilityIcon fontSize="small" />}
                    </IconButton>
                  </InputAdornment>
                ),
              }}
            />

            <Button
              type="submit"
              variant="contained"
              fullWidth
              disabled={loading || !username.trim() || !password}
              sx={{
                mt: 1,
                py: 1.2,
                background: 'linear-gradient(135deg, #2E7DCC 0%, #1A5FA0 100%)',
                fontWeight: 700,
                fontSize: '0.875rem',
                letterSpacing: '0.05em',
                '&:hover': { background: 'linear-gradient(135deg, #3d8de0 0%, #2270bb 100%)' },
                '&:disabled': { opacity: 0.6 },
              }}
            >
              {loading ? <CircularProgress size={18} sx={{ color: '#fff' }} /> : 'Sign In'}
            </Button>
          </Box>
        </Box>
      </Box>
    </Box>
  )
}
