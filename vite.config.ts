import { defineConfig } from 'vite-plus'

export default defineConfig({
  fmt: {
    ignorePatterns: ['dist/**'],
    printWidth: 100,
    proseWrap: 'never',
    semi: false,
    singleAttributePerLine: true,
    singleQuote: true,
    sortImports: true,
    sortPackageJson: { sortScripts: true },
    tabWidth: 2,
    trailingComma: 'none',
    useTabs: false
  },
  lint: {
    categories: {
      correctness: 'error',
      pedantic: 'error',
      perf: 'error',
      suspicious: 'error'
    },
    ignorePatterns: ['dist/**'],
    jsPlugins: [{ name: 'vite-plus', specifier: 'vite-plus/oxlint-plugin' }],
    options: {
      typeAware: true,
      typeCheck: true
    },
    overrides: [
      {
        files: ['**/*.test.ts'],
        rules: {
          'import/max-dependencies': 'off',
          'max-classes-per-file': 'off',
          'max-depth': 'off',
          'max-lines': 'off',
          'max-lines-per-function': 'off'
        }
      }
    ],
    plugins: [
      'eslint',
      'typescript',
      'unicorn',
      'oxc',
      'import',
      'promise',
      'node',
      'jsdoc',
      'vitest'
    ],
    rules: {
      curly: ['error', 'all'],
      'func-style': ['error', 'declaration'],
      'sort-keys': 'error',
      'typescript/array-type': ['error', { default: 'array' }],
      'typescript/consistent-type-exports': 'error',
      'typescript/consistent-type-imports': 'error',
      'typescript/explicit-function-return-type': 'error',
      'typescript/no-non-null-assertion': 'error',
      'unicorn/import-style': 'error',
      'vite-plus/prefer-vite-plus-imports': 'error',
      yoda: 'error'
    }
  },
  pack: {
    entry: ['src/index.ts', 'src/sql-worker.ts']
  },
  staged: { '*': 'vp check --fix' }
})
