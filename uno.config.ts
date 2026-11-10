import { defineConfig, presetWind3 } from 'unocss'
export default defineConfig({
  content: { filesystem: ['src/**/*.{html,ts,tsx}'] },
  presets: [presetWind3()],
  theme: { colors: { sage: { 50: '#f1f5ef', 100: '#e4ecdf', 500: '#748b64', 600: '#5f7652', 700: '#465c3b' } } },
})
