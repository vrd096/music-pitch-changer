/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/popup/**/*.{html,tsx,ts}', './src/popup/index.html'],
  theme: {
    extend: {
      colors: {
        primary: {
          400: '#818cf8',
          500: '#6366f1',
          600: '#4f46e5',
          700: '#4338ca',
        },
        surface: {
          800: '#1e1b4b',
          900: '#0f0d2e',
          950: '#0a0820',
        },
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'loading-bar': 'loading-bar 1.5s ease-in-out infinite',
      },
      keyframes: {
        'loading-bar': {
          '0%': { transform: 'translateX(-100%)' },
          '50%': { transform: 'translateX(200%)' },
          '100%': { transform: 'translateX(400%)' },
        },
      },
    },
  },
  plugins: [],
};
