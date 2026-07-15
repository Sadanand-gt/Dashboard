/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  important: '#root',
  theme: {
    extend: {
      colors: {
        primary: {
          DEFAULT: '#1565C0',
          dark: '#0D47A1',
          light: '#1976D2',
        },
        surface: {
          DEFAULT: '#F4F6FA',
          card: '#FFFFFF',
          hover: '#EFF6FF',
          border: 'rgba(0,0,0,0.07)',
        },
        accent: {
          green:  '#16A34A',
          amber:  '#D97706',
          red:    '#DC2626',
          purple: '#7C3AED',
        },
        text: {
          primary:   '#1E293B',
          secondary: '#64748B',
          muted:     '#94A3B8',
        },
      },
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
    },
  },
  plugins: [],
}
