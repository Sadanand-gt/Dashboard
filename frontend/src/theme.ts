import { createTheme } from '@mui/material/styles'

export const theme = createTheme({
  palette: {
    mode: 'light',
    primary: {
      main: '#1565C0',
      light: '#1976D2',
      dark: '#0D47A1',
    },
    secondary: {
      main: '#16A34A',
    },
    error: {
      main: '#DC2626',
    },
    warning: {
      main: '#D97706',
    },
    success: {
      main: '#16A34A',
    },
    background: {
      default: '#F4F6FA',
      paper: '#FFFFFF',
    },
    text: {
      primary: '#1E293B',
      secondary: '#64748B',
      disabled: '#94A3B8',
    },
    divider: 'rgba(0,0,0,0.08)',
  },
  typography: {
    fontFamily: "'Inter', sans-serif",
    h1: { fontWeight: 700 },
    h2: { fontWeight: 700 },
    h3: { fontWeight: 600 },
    h4: { fontWeight: 600 },
    h5: { fontWeight: 600 },
    h6: { fontWeight: 600 },
  },
  shape: {
    borderRadius: 8,
  },
  components: {
    MuiPaper: {
      styleOverrides: {
        root: {
          backgroundImage: 'none',
          backgroundColor: '#FFFFFF',
          border: '1px solid rgba(0,0,0,0.07)',
          boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
        },
      },
    },
    MuiCard: {
      styleOverrides: {
        root: {
          backgroundImage: 'none',
          backgroundColor: '#FFFFFF',
          border: '1px solid rgba(0,0,0,0.07)',
          boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
        },
      },
    },
    MuiButton: {
      styleOverrides: {
        root: {
          textTransform: 'none',
          fontWeight: 600,
        },
      },
    },
    MuiToggleButton: {
      styleOverrides: {
        root: {
          textTransform: 'none',
          fontWeight: 500,
          fontSize: '0.78rem',
        },
      },
    },
    MuiTextField: {
      defaultProps: {
        size: 'small',
        variant: 'outlined',
      },
    },
    MuiSelect: {
      defaultProps: {
        size: 'small',
      },
    },
    MuiOutlinedInput: {
      styleOverrides: {
        root: {
          backgroundColor: '#FFFFFF',
          '& .MuiOutlinedInput-notchedOutline': {
            borderColor: 'rgba(0,0,0,0.18)',
          },
          '&:hover .MuiOutlinedInput-notchedOutline': {
            borderColor: '#1565C0',
          },
        },
      },
    },
    MuiTableHead: {
      styleOverrides: {
        root: {
          '& .MuiTableCell-head': {
            backgroundColor: '#EFF6FF',
            color: '#1E40AF',
            fontWeight: 700,
            fontSize: '0.72rem',
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            borderBottom: '2px solid #BFDBFE',
          },
        },
      },
    },
    MuiTableCell: {
      styleOverrides: {
        root: {
          borderBottom: '1px solid rgba(0,0,0,0.05)',
          fontSize: '0.8125rem',
          padding: '9px 14px',
          color: '#1E293B',
        },
      },
    },
    MuiTableRow: {
      styleOverrides: {
        root: {
          '&:hover': {
            backgroundColor: '#F8FAFF',
          },
        },
      },
    },
    MuiChip: {
      styleOverrides: {
        root: {
          fontWeight: 600,
          fontSize: '0.75rem',
        },
      },
    },
    MuiTooltip: {
      styleOverrides: {
        tooltip: {
          backgroundColor: '#1E293B',
          fontSize: '0.72rem',
        },
      },
    },
    MuiAccordion: {
      styleOverrides: {
        root: {
          boxShadow: 'none',
          '&:before': { display: 'none' },
        },
      },
    },
  },
})
