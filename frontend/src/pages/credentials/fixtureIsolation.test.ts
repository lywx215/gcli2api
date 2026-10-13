import { describe, expect, it, vi } from 'vitest'
import { initialFilters } from './model'

describe('credential fixture isolation', () => {
  it.each([
    [true, 'true', true],
    [true, 'false', false],
    [false, 'true', false],
    [false, 'false', false],
  ] as const)('DEV=%s and fixture flag=%s enables preview only when both permit it', async (dev, flag, enabled) => {
    vi.resetModules()
    vi.stubEnv('DEV', dev)
    vi.stubEnv('VITE_UI_FIXTURES', flag)
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ items: [], total: 0 }))
    const { api, fixtureMode } = await import('./api')
    expect(fixtureMode).toBe(enabled)
    const page = await api.list(initialFilters, new Set(), 0, 25)
    if (enabled) {
      expect(page.items[0].filename).toBe('synthetic-1.json')
      expect(page.total).toBe(62)
      expect(fetch).not.toHaveBeenCalled()
    } else {
      expect(page.items).toEqual([])
      expect(page.total).toBe(0)
      expect(fetch).toHaveBeenCalledTimes(1)
    }
  })

  it('production never falls back to fixtures after a failed real read even when the flag is true', async () => {
    vi.resetModules()
    vi.stubEnv('DEV', false)
    vi.stubEnv('VITE_UI_FIXTURES', 'true')
    vi.mocked(fetch).mockRejectedValueOnce(new Error('Synthetic transport failure'))
    const { api } = await import('./api')
    await expect(api.list(initialFilters, new Set(), 0, 25)).rejects.toThrow('Synthetic transport failure')
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
