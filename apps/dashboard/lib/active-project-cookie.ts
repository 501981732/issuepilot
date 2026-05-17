/**
 * V4.2 team-mode: shared key for the cookie that mirrors
 * ProjectSwitcher's `localStorage` selection so Server Components can
 * read it during SSR.
 *
 * Why a cookie (in addition to localStorage):
 *  - Server Components have no access to localStorage; without a
 *    cookie the SSR call to `/api/work-items/*` is missing the
 *    `x-issuepilot-project` header and the orchestrator returns
 *    HTTP 400 `project_header_required` in team-mode (review §C3).
 *  - Cookies survive refresh and new tabs in the same way localStorage
 *    does, so the two stay aligned operator-side.
 *  - We keep the legacy localStorage key around because the API
 *    client's module-level `activeWorkItemsProject` is consumed by
 *    every CSR fetch (and ProjectSwitcher hydration tests are written
 *    against localStorage).
 *
 * Cookie attributes:
 *   - Path: `/` so every dashboard route gets it.
 *   - SameSite=lax + no Secure flag → works on the local
 *     `http://127.0.0.1:3000` dev server. Production deployments
 *     should layer a reverse proxy that upgrades this to Secure when
 *     served over HTTPS; we keep the default permissive setting here
 *     for V4.2 P0.
 *   - Max-Age of 30 days so operators don't have to re-pick a project
 *     every session.
 */
export const PROJECT_COOKIE_KEY = "issuepilot.workItems.activeProject";
export const PROJECT_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
