import type { Config } from 'tailwindcss';
import animate from 'tailwindcss-animate';

/**
 * KAREN Tailwind configuration.
 *
 * This is a VERBATIM port of the inline `tailwind.config` object declared in
 * `reference/IRIS-PAYROLL-main/index.html`. Every colour value, token name and
 * font family is copied character-for-character from the IRIS source, which is
 * the UI source of truth (docs/12_UI_UX_SPEC.md, docs/18_IRIS_REUSE_AND_EXTRACTION_RULES.md).
 *
 * IRIS loaded Tailwind from `https://cdn.tailwindcss.com`, which is explicitly
 * not for production use. Moving to a real Tailwind build is a build-system
 * change only — it produces the same utility classes from the same token values.
 *
 * Three deviations, each correcting a defect in the IRIS source rather than
 * changing its design. See docs/22_ARCHITECTURE_DECISIONS.md (ADR-001).
 *
 *   1. `colors.border.default`
 *      IRIS declares `border: { DEFAULT, hover }`, which Tailwind emits as
 *      `border-border` and `border-border-hover`. But every IRIS component
 *      writes `border-border-default` (~300 occurrences), which matches no
 *      generated class, so IRIS renders with no visible borders at all.
 *      Adding an explicit `default` key makes the existing class strings
 *      resolve. `border-border` (DEFAULT) is kept so nothing regresses.
 *      This also fixes `divide-border-default`, since divideColor inherits
 *      from borderColor.
 *
 *   2. `tailwindcss-animate` plugin
 *      IRIS components use `animate-in`, `fade-in`, `zoom-in-95`,
 *      `slide-in-from-left`, `slide-in-from-right-full`, `slide-in-from-bottom-10`
 *      and `slide-in-from-bottom-2`. None of these exist in stock Tailwind, so
 *      every IRIS entrance animation is currently a no-op. This plugin supplies
 *      exactly those utilities, making the animations behave as the source intends.
 *
 *   3. `safelist` for status colours
 *      Several IRIS components build class names by interpolation. Tailwind's
 *      JIT scanner cannot see those, so the classes are safelisted.
 */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        main: 'var(--color-main)',
        panel: 'var(--color-panel)',
        accent: {
          primary: '#2F5BFF', // Electric Royal Blue
          secondary: '#4C7DFF', // Soft Neon Blue
          analytics: '#2ED3B7', // Mint Green
        },
        text: {
          primary: 'var(--color-text-primary)',
          secondary: 'var(--color-text-secondary)',
          muted: 'var(--color-text-muted)',
        },
        status: {
          success: '#2ED3B7',
          warning: '#F5C451',
          error: '#FF5C5C',
          info: '#4C7DFF',
        },
        border: {
          DEFAULT: 'var(--color-border)',
          default: 'var(--color-border)', // deviation 1 — see header
          hover: 'var(--color-border-hover)',
        },
      },
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
      },
    },
  },
  safelist: [
    { pattern: /^(bg|text|border)-status-(success|warning|error|info)$/ },
    { pattern: /^(bg|text|border)-status-(success|warning|error|info)\/\d+$/ },
    { pattern: /^(bg|text|border)-accent-(primary|secondary|analytics)$/ },
    { pattern: /^(bg|text|border)-accent-(primary|secondary|analytics)\/\d+$/ },
  ],
  plugins: [animate], // deviation 2 — see header
} satisfies Config;
