import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import OverviewPage from './index'
import { useOverview } from './useOverview'
import { overviewFixture } from './fixtures'
vi.mock('./useOverview', () => ({ useOverview: vi.fn() }))
it('renders only endpoint metrics and shows unavailable explicitly', () => {
  const refresh = vi.fn()
  vi.mocked(useOverview).mockReturnValue({ data: { ...overviewFixture, today: { value: null, issue: '后端报告此统计不可用' } }, loading: false, refresh })
  render(<OverviewPage />)
  expect(screen.getByText('后端报告此统计不可用')).toBeTruthy()
  expect(screen.getAllByText('不可用')).toHaveLength(3)
  expect(screen.getByText(/每日按北京时间结算/)).toBeTruthy()
  expect(screen.queryByText(/CPU|RAM|账单|成本/)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '刷新统计' }))
  expect(refresh).toHaveBeenCalledTimes(1)
})
