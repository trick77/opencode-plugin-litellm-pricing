// Entry point for loading a checkout as a local plugin directory
// (`"plugins": ["/abs/path/to/checkout"]`). opencode resolves a directory
// plugin by file path — `<dir>/server`, then `<dir>/index` — and never reads
// package.json `exports` for it. An npm install resolves through `exports`
// and does not need this file.
export { default } from './src/index.ts'
