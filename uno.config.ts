import { defineConfig, presetWind3 } from 'unocss'

const colors = {
  sage: { 50: '#f1f5ef', 100: '#e4ecdf', 500: '#748b64', 600: '#5f7652', 700: '#465c3b' },
  ui: {
    ink: '#303b2c', focus: '#8aa078', dialog: '#fffffbd9', icon: '#f2f7e8', 'icon-image': '#f2f4ee', 'icon-fallback': '#9ba98c',
    canvas: '#f7f8ef', text: '#353d32', sage: '#6c805c', 'sage-deep': '#4e6440', muted: '#7e8976', line: '#dfe6d6a8', surface: '#fffffaba',
  },
  action: { ghost: '#7b8571', 'ghost-hover': '#4b6040', 'ghost-surface': '#edf0e7', danger: '#ad6658', 'danger-surface': '#fff0ea', 'danger-hover': '#f6e3dc' },
  form: { label: '#768368', surface: '#f7f8f2', line: '#e5e9dc', ink: '#414d38', placeholder: '#b2baa6', focus: '#b4c2a0' },
}

export default defineConfig({
  content: { filesystem: ['src/**/*.{html,ts,tsx}'] },
  presets: [presetWind3()],
  theme: { colors },
  // Browser defaults and existing UI utilities share the theme palette.
  preflights: [{ getCSS: () => `:root{--sage:${colors.ui.sage};--sage-deep:${colors.ui['sage-deep']};--ink:${colors.ui.ink};--muted:${colors.ui.muted};--line:${colors.ui.line};--surface:${colors.ui.surface};--canvas:${colors.ui.canvas};--page-text:${colors.ui.text};--focus:${colors.ui.focus}}` }],
})
