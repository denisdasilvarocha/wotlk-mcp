import { defineConfig } from 'vite-plus'

export default defineConfig({
  staged: { '*': 'vp check --fix' },
  fmt: {
    ignorePatterns: ['dist/**'],
    printWidth: 100,
    proseWrap: 'never',
    semi: false,
    singleAttributePerLine: true,
    singleQuote: true,
    sortImports: {
      groups: ['value-import', 'type-import'],
      newlinesBetween: true
    },
    sortPackageJson: { sortScripts: true },
    tabWidth: 2,
    trailingComma: 'none',
    useTabs: false
  },
  lint: {
    ignorePatterns: ['dist/**'],
    categories: {
      correctness: 'error',
      perf: 'error',
      suspicious: 'error'
    },
    options: {
      typeAware: true,
      typeCheck: true
    },
    plugins: [
      'eslint',
      'import',
      'jsdoc',
      'node',
      'oxc',
      'promise',
      'typescript',
      'unicorn',
      'vitest'
    ]
  },
  pack: {
    entry: ['src/index.ts', 'src/sql-worker.ts']
  }
})
