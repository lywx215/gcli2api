import { fireEvent, render, screen, within } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { PanelChannelProvider } from '@/app/channels'
import OverviewPage from './index'
import { useOverview } from './useOverview'
import { overviewFixture } from './fixtures'

vi.mock('./useOverview', () => ({ useOverview: vi.fn() }))

it('renders only endpoint metrics and shows unavailable explicitly', () => {
  const refresh = vi.fn()
  vi.mocked(useOverview).mockReturnValue({
    data: { ...overviewFixture, today: { value: null, issue: '后端报告此统计不可用' } },
    loading: false,
    refresh,
  })
  render(
    <PanelChannelProvider>
      <OverviewPage />
    </PanelChannelProvider>
  )

  expect(useOverview).toHaveBeenCalledWith('antigravity')
  expect(screen.getByText('后端报告此统计不可用')).toBeTruthy()

  const todayTotalTitle = screen.getByText('今日逻辑请求')
  const metricsContainer =
    todayTotalTitle.closest('.grid') ?? todayTotalTitle.parentElement?.parentElement?.parentElement!
  const findMetricCard = (label: string) => {
    const card = Array.from(metricsContainer.children).find(child =>
      within(child as HTMLElement).queryByText(label) !== null
    ) as HTMLElement
    expect(card).toBeTruthy()
    return card
  }

  expect(within(findMetricCard('今日逻辑请求')).getByText('不可用')).toBeTruthy()
  expect(within(findMetricCard('成功')).getByText('不可用')).toBeTruthy()
  expect(within(findMetricCard('失败')).getByText('不可用')).toBeTruthy()
  expect(within(findMetricCard('成功率')).getByText('不可用')).toBeTruthy()
  expect(within(findMetricCard('当前 RPM')).getByText('3')).toBeTruthy()

  expect(screen.getByText(/每日按北京时间结算/)).toBeTruthy()
  expect(screen.queryByText(/CPU|RAM|账单|成本/)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '刷新统计' }))
  expect(refresh).toHaveBeenCalledTimes(1)
})

