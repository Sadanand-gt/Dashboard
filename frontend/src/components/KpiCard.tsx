import Box from '@mui/material/Box'
import Skeleton from '@mui/material/Skeleton'

type Variant = 'default' | 'green' | 'amber' | 'red' | 'purple'

interface Props {
  label: string
  value: string
  sub?: string
  variant?: Variant
  loading?: boolean
  delta?: string
  deltaUp?: boolean
}

const VARIANT_STYLES: Record<Variant, { border: string; accent: string; bg: string; label: string }> = {
  default: { border: '#BFDBFE', accent: '#1565C0', bg: '#EFF6FF', label: '#1E40AF' },
  green:   { border: '#BBF7D0', accent: '#16A34A', bg: '#F0FDF4', label: '#15803D' },
  amber:   { border: '#FDE68A', accent: '#D97706', bg: '#FFFBEB', label: '#B45309' },
  red:     { border: '#FECACA', accent: '#DC2626', bg: '#FEF2F2', label: '#B91C1C' },
  purple:  { border: '#DDD6FE', accent: '#7C3AED', bg: '#F5F3FF', label: '#6D28D9' },
}

export function KpiCard({ label, value, sub, variant = 'default', loading = false, delta, deltaUp }: Props) {
  const s = VARIANT_STYLES[variant]

  return (
    <Box
      className="rounded-xl"
      sx={{
        background: s.bg,
        border: `1.5px solid ${s.border}`,
        p: 1.75,
        width: '100%',
        height: '100%',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {/* Coloured left accent bar */}
      <Box
        sx={{
          position: 'absolute', left: 0, top: 0, bottom: 0, width: 4,
          background: s.accent, borderRadius: '8px 0 0 8px',
        }}
      />
      <Box sx={{ ml: 0.5 }}>
        <Box
          className="text-xs font-semibold uppercase tracking-wider mb-1.5"
          sx={{ color: s.label }}
        >
          {label}
        </Box>
        {loading ? (
          <>
            <Skeleton variant="text" width={100} height={32} sx={{ bgcolor: `${s.border}88` }} />
            <Skeleton variant="text" width={70}  height={18} sx={{ bgcolor: `${s.border}55` }} />
          </>
        ) : (
          <>
            <Box
              className="font-bold font-mono"
              sx={{ color: s.accent, lineHeight: 1.2, fontSize: '1.4rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
            >
              {value}
            </Box>
            {sub && (
              <Box className="text-xs mt-1" sx={{ color: '#64748B', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{sub}</Box>
            )}
            {delta && (
              <Box
                className="text-xs font-semibold mt-1"
                sx={{ color: deltaUp ? '#16A34A' : '#DC2626' }}
              >
                {deltaUp ? '▲' : '▼'} {delta}
              </Box>
            )}
          </>
        )}
      </Box>
    </Box>
  )
}
