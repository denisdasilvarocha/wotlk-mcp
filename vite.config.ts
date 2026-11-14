import { defineConfig } from 'vite-plus'

export default defineConfig({
  fmt: {
    ignorePatterns: [],
    jsdoc: true,
    objectWrap: 'preserve',
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
    ignorePatterns: [],
    categories: {
      correctness: 'error',
      perf: 'error',
      suspicious: 'error'
    },
    jsPlugins: ['vite-plus/oxlint-plugin'],
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
    ],
    rules: {
      curly: ['error', 'multi'],
      'func-style': ['error', 'declaration'],
      'no-param-reassign': 'error',
      'no-ternary': 'error',
      'prefer-destructuring': ['error', { array: true, object: true }],
      'prefer-object-spread': 'error',
      'prefer-template': 'error',
      'promise/prefer-await-to-then': 'error',
      'typescript/array-type': ['error', { default: 'array' }],
      'typescript/consistent-type-assertions': [
        'error',
        {
          arrayLiteralTypeAssertions: 'never',
          assertionStyle: 'never',
          objectLiteralTypeAssertions: 'never'
        }
      ],
      'typescript/consistent-type-definitions': ['error', 'interface'],
      'typescript/consistent-type-exports': 'error',
      'typescript/consistent-type-imports': 'error',
      'typescript/explicit-function-return-type': 'error',
      'typescript/no-non-null-assertion': 'error',
      'typescript/no-wrapper-object-types': 'error',
      'typescript/prefer-for-of': 'error',
      'typescript/prefer-nullish-coalescing': 'error',
      'typescript/prefer-optional-chain': 'error',
      'typescript/require-await': 'error',
      'unicorn/import-style': 'error',
      'unicorn/no-null': 'error',
      'unicorn/prefer-array-find': 'error',
      'unicorn/prefer-array-flat-map': 'error',
      'unicorn/prefer-array-some': 'error',
      'unicorn/prefer-spread': 'error',
      'vite-plus/prefer-vite-plus-imports': 'error'
    }
  },
  pack: {
    deps: {
      // tsdown <0.23 compatibility: resolve external dependency subpaths.
      // Remove to preserve subpath imports as written (the new default).
      // https://tsdown.dev/options/dependencies#deps-resolvedepsubpath
      resolveDepSubpath: true
    },
    entry: ['src/index.ts'],
    format: ['esm']
  },
  staged: { '*': 'vp check --fix' }
})
