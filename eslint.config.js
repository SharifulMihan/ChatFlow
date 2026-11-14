const BROWSER_WEBEXT_GLOBALS = {
  // WebExtensions
  chrome: 'readonly',

  // Browser / DOM
  window: 'readonly',
  document: 'readonly',
  self: 'readonly',
  globalThis: 'readonly',
  navigator: 'readonly',
  location: 'readonly',
  history: 'readonly',
  localStorage: 'readonly',
  sessionStorage: 'readonly',
  indexedDB: 'readonly',
  HTMLElement: 'readonly',
  Element: 'readonly',
  Node: 'readonly',
  NodeFilter: 'readonly',
  Document: 'readonly',
  DocumentFragment: 'readonly',
  Text: 'readonly',
  Range: 'readonly',
  Selection: 'readonly',
  DOMParser: 'readonly',
  MutationObserver: 'readonly',
  IntersectionObserver: 'readonly',
  ResizeObserver: 'readonly',
  AbortController: 'readonly',
  AbortSignal: 'readonly',
  Event: 'readonly',
  CustomEvent: 'readonly',
  MouseEvent: 'readonly',
  KeyboardEvent: 'readonly',
  InputEvent: 'readonly',
  ClipboardEvent: 'readonly',
  ErrorEvent: 'readonly',
  PromiseRejectionEvent: 'readonly',
  DataTransfer: 'readonly',
  File: 'readonly',
  FileReader: 'readonly',
  Blob: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
  CSS: 'readonly',
  getComputedStyle: 'readonly',
  requestAnimationFrame: 'readonly',
  cancelAnimationFrame: 'readonly',
  fetch: 'readonly',
  Headers: 'readonly',
  Request: 'readonly',
  Response: 'readonly',
  FormData: 'readonly',
  crypto: 'readonly',
  performance: 'readonly',
  console: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  queueMicrotask: 'readonly',
  structuredClone: 'readonly',
  atob: 'readonly',
  btoa: 'readonly',
  alert: 'readonly',
  confirm: 'readonly',
  PointerEvent: 'readonly',

  // Bundled vendor globals exposed via <script> tags in sidepanel/index.html
  Chart: 'readonly',
  docx: 'readonly'
};

const NODE_GLOBALS = {
  global: 'readonly',
  process: 'readonly',
  Buffer: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
  setImmediate: 'readonly',
  clearImmediate: 'readonly'
};

export default [
  {
    ignores: [
      'node_modules/**',
      'lib/vendor/**',
      '.git/**'
    ]
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: BROWSER_WEBEXT_GLOBALS
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_'
        }
      ]
    }
  },
  {
    files: ['scratch/**/*.js', 'fixtures/**/*.js', 'scripts/**/*.js', 'eslint.config.js'],
    languageOptions: {
      globals: {
        ...BROWSER_WEBEXT_GLOBALS,
        ...NODE_GLOBALS
      }
    }
  },
  {
    files: ['scratch/gen_locales.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        ...NODE_GLOBALS,
        require: 'readonly',
        module: 'readonly',
        exports: 'readonly'
      }
    }
  }
];
