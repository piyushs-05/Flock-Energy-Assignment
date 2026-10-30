export default [{ ignores: ['node_modules/**'] }, {
  files: ['**/*.js'],
  languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: { console: 'readonly', fetch: 'readonly', AbortSignal: 'readonly', process: 'readonly', URL: 'readonly', URLSearchParams: 'readonly', AbortController: 'readonly', performance: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', Buffer: 'readonly' } },
  rules: { 'no-unused-vars': ['error', { argsIgnorePattern: '^_|^next$|^req$|^res$' }], 'no-undef': 'error' },
}];
