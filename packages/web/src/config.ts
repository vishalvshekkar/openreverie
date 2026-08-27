// Reverie Cloud serves this same app from the same origin as its API, with
// the person's session already established by its gateway before the app
// loads. That is the only thing this file exists to make configurable: the
// API base URL and whether the app should skip the self-hosted bootstrap
// token exchange. Both are read once from Vite's build-time env, so a
// self-hosted build, which sets neither variable, keeps exactly today's
// behavior.

export interface AppConfig {
  apiBaseUrl: string
  preAuthenticated: boolean
}

function stripTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value
}

// Takes a plain object rather than reading import.meta.env directly so the
// mapping from env to config is a pure function a test can call with
// whatever inputs it wants, without stubbing the build-time environment.
export function readAppConfig(env: Record<string, string | undefined>): AppConfig {
  return {
    apiBaseUrl: stripTrailingSlash(env.VITE_API_BASE_URL ?? ''),
    // Exactly the string 'true', not any truthy string, so a build that
    // forgets to set the variable (or sets it to something else by mistake)
    // fails closed into the self-hosted bootstrap flow rather than skipping
    // it silently.
    preAuthenticated: env.VITE_PRE_AUTHENTICATED === 'true',
  }
}

export const appConfig: AppConfig = readAppConfig(import.meta.env)
