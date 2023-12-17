module.exports = {
  root: true,
  settings: {
    react: {
      version: 'detect',
    },
  },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: './tsconfig.json',
    ecmaVersion: 'latest',
  },
  plugins: [
    '@typescript-eslint',
    'import',
    'jest',
    'react',
  ],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:import/errors',
    'plugin:import/warnings',
    'plugin:import/typescript',
    'plugin:jest/recommended',
    'plugin:react/recommended',
    'plugin:react/jsx-runtime',
  ],
  rules: {
    '@typescript-eslint/lines-between-class-members': ['error', 'always', { exceptAfterSingleLine: true }],
    '@typescript-eslint/no-use-before-define': ['error', { 'functions': false }],
    '@typescript-eslint/no-unused-vars': ['error', { 'argsIgnorePattern': '^_$' }],
    '@typescript-eslint/dot-notation': 'error',
    'arrow-parens': ['error', 'as-needed'],
    'no-console': ['error', { allow: ['warn', 'error'] }],
    'no-multiple-empty-lines': ['error', { 'max': 2, 'maxEOF': 1 }],
    'no-plusplus': ['error', { 'allowForLoopAfterthoughts': true }],
    'react/jsx-indent': ['error', 2, {checkAttributes: true, indentLogicalExpressions: true}],
  },
  overrides: [
    {
      files: ['*.spec.[tj]s', '*.test.[tj]s'],
      rules: {
        '@typescript-eslint/dot-notation': 'off',
      },
    },
  ],
};
