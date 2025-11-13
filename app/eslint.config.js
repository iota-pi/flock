import { defineConfig } from 'eslint/config';
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';
import stylistic from '@stylistic/eslint-plugin';


export default defineConfig([
  eslint.configs.recommended,
  tseslint.configs.eslintRecommended,
  tseslint.configs.recommended,
  importPlugin.flatConfigs.errors,
  importPlugin.flatConfigs.warnings,
  importPlugin.flatConfigs.typescript,
  {
    plugins: {
      '@stylistic': stylistic,
    },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: './tsconfig.json',
        ecmaVersion: 'latest',
      },
    },
    rules: {
      'lines-between-class-members': ['error', 'always', { exceptAfterSingleLine: true }],
      '@typescript-eslint/no-use-before-define': ['error', { 'functions': false }],
      '@typescript-eslint/no-unused-vars': ['error', { 'argsIgnorePattern': '^_$' }],
      '@typescript-eslint/dot-notation': 'error',
      'arrow-parens': ['error', 'as-needed'],
      'no-console': ['error', { allow: ['warn', 'error', 'info'] }],
      'no-multiple-empty-lines': ['error', { 'max': 2, 'maxEOF': 1 }],
      'no-plusplus': ['error', { 'allowForLoopAfterthoughts': true }],
      '@stylistic/semi': ['error', 'never'],
      '@stylistic/indent': ['error', 2],
    },
    ignores: [
      '/node_modules',
      '/build',
      '/dist',
      '/coverage',
    ]
  },
]);
