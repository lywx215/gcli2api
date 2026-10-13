import type { ImportResult, EmailSnapshot } from './types'
export function previewResult(): ImportResult { return { outcome: 'partial', items: [{ label: 'example-alpha.json', status: 'success' }, { label: 'example-beta.json', status: 'failed' }], warnings: 1, jobId: 'example-job' } }
export function previewEmail(): EmailSnapshot { return { complete: true, items: [{ filename: 'example-alpha.json', status: 'success', email: 'alpha@example.invalid' }] } }
