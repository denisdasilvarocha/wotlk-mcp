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
    ignorePatterns: ['dist/**'],
    options: {
      typeAware: true,
      typeCheck: true
    },
    categories: {
      correctness: 'error',
      suspicious: 'error',
      perf: 'error',
      pedantic: 'error'
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
    ],
    jsPlugins: [{ name: 'vite-plus', specifier: 'vite-plus/oxlint-plugin' }],
    rules: {
      'func-style': ['error', 'declaration'],
      'vite-plus/prefer-vite-plus-imports': 'error',
      curly: ['error', 'multi']
    }
  },
  pack: {
    entry: ['src/index.ts', 'src/sql-worker.ts']
  },
  staged: { '*': 'vp check --fix' }
})
