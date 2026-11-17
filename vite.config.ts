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
    options: {
      typeAware: true,
      typeCheck: true
    },
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
    ]
  },
  pack: {
    entry: ['src/index.ts', 'src/sql-worker.ts']
  },
  staged: { '*': 'vp check --fix' }
})
