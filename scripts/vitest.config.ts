// // scripts/vitest.config.ts
// import { defineConfig } from 'vitest/config';
// import { resolve } from 'path';

// export default defineConfig({
//   // Set execution root back to the project root directory
//   root: resolve(__dirname, '..'),
//   test: {
//     globals: true,
//     environment: 'node',
//     // Allow test files without test suites or allow skipping empty fixture files
//     passWithNoTests: true,
//     // Restrict test execution strictly to package test files, ignoring fixture outputs
//     include: [
//       'packages/*/src/**/*.test.ts',
//       'packages/*/src/**/*.spec.ts',
//       'src/**/*.test.ts',
//     ],
//     exclude: [
//       '**/.purix-tmp/**',
//       '**/node_modules/**',
//       '**/dist/**',
//       '**/fixtures/**',
//     ],
//     coverage: {
//       provider: 'v8',
//       reporter: ['text', 'json', 'html'],
//       // Update coverage include pattern to target package source directories
//       include: [
//         'packages/*/src/**/*.ts',
//         'src/**/*.ts',
//       ],
//       exclude: [
//         'packages/*/src/**/*.test.ts',
//         'packages/*/src/**/*.spec.ts',
//         'src/**/*.test.ts',
//         '**/types/**',
//       ],
//       thresholds: {
//         lines: 90,
//         functions: 90,
//         branches: 90,
//         statements: 90,
//       },
//     },
//   },
// });