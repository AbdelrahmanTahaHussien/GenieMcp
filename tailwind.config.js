/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  darkMode: 'media',
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#faf5ff',
          100: '#f3e8ff',
          200: '#e9d5ff',
          300: '#d8b4fe',
          400: '#c084fc',
          500: '#aa3bff',
          600: '#9333ea',
          700: '#7e22ce',
          800: '#6b21a8',
          900: '#581c87',
        },
      },
      fontFamily: {
        sans: ['system-ui', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
      boxShadow: {
        soft: '0 10px 25px -10px rgba(0,0,0,0.15)',
        glow: '0 0 0 4px rgba(170,59,255,0.15)',
      },
      backgroundImage: {
        'hero-gradient':
          'radial-gradient(ellipse at top, rgba(170,59,255,0.18), transparent 60%), radial-gradient(ellipse at bottom right, rgba(192,132,252,0.15), transparent 60%)',
      },
    },
  },
  plugins: [],
}
