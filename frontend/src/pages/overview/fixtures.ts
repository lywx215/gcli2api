import type { OverviewData } from './types'
export const overviewFixture: OverviewData = {
  today: { value: { date: '2026-10-13', success: 128, failure: 4, total: 132 }, issue: null },
  recent: { value: [
    { date: '2026-10-13', success: 128, failure: 4, total: 132 },
    { date: '2026-10-12', success: 260, failure: 12, total: 272 },
  ], issue: null },
  models: { value: { items: [{ name: 'synthetic-family', success: 128, failure: 4, total: 132, rpm: 3 }], rpm: 3 }, issue: null },
  credentials: { value: { total: 24, normal: 20, disabled: 4 }, issue: null },
}
