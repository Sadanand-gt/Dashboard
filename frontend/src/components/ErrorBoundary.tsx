import { Component, type ReactNode } from 'react'
import Box from '@mui/material/Box'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    // eslint-disable-next-line no-console
    console.error('App error:', error, info?.componentStack)
  }

  render() {
    if (this.state.error) {
      return (
        <Box
          className="min-h-screen flex flex-col items-center justify-center p-8"
          sx={{ background: '#081525', color: '#E8F0FB' }}
        >
          <Box className="text-lg font-bold mb-2" sx={{ color: '#E84545' }}>
            Something went wrong
          </Box>
          <Box
            className="text-sm font-mono max-w-2xl whitespace-pre-wrap"
            sx={{ color: '#7FA8D4', background: '#112845', p: 2, borderRadius: 2, border: '1px solid rgba(232,69,69,0.3)' }}
            id="error-boundary-message"
          >
            {this.state.error.message}
          </Box>
          <Box
            className="text-xs mt-4 cursor-pointer"
            sx={{ color: '#2E7DCC' }}
            onClick={() => { this.setState({ error: null }); window.location.reload() }}
          >
            Reload
          </Box>
        </Box>
      )
    }
    return this.props.children
  }
}
