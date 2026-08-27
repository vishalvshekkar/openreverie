import { describe, expect, it } from 'vitest'
import { readAppConfig } from './config.js'

describe('readAppConfig', () => {
  it('defaults to no base URL and not pre-authenticated when nothing is set, matching self-hosted today', () => {
    expect(readAppConfig({})).toEqual({ apiBaseUrl: '', preAuthenticated: false })
  })

  it('carries a configured base URL through as is', () => {
    expect(readAppConfig({ VITE_API_BASE_URL: 'https://api.reverie.example' }).apiBaseUrl).toBe(
      'https://api.reverie.example',
    )
  })

  it('strips a trailing slash from a configured base URL', () => {
    expect(readAppConfig({ VITE_API_BASE_URL: 'https://api.reverie.example/' }).apiBaseUrl).toBe(
      'https://api.reverie.example',
    )
  })

  it('is pre-authenticated only when the flag is exactly the string true', () => {
    expect(readAppConfig({ VITE_PRE_AUTHENTICATED: 'true' }).preAuthenticated).toBe(true)
    expect(readAppConfig({ VITE_PRE_AUTHENTICATED: 'yes' }).preAuthenticated).toBe(false)
    expect(readAppConfig({}).preAuthenticated).toBe(false)
  })
})
