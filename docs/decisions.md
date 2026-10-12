# Decisions

A running log of choices made while building the Safe Lock platform. Newest last.

---

## 2026-10-12 — Package manager: npm workspaces, not pnpm

**Decision:** The monorepo uses **npm workspaces**. `pnpm` is not used.

**Why:** The development machine has Node 25 and npm 11 but neither `pnpm` nor
`corepack` installed, and the user chose not to install pnpm. npm workspaces
gives the same `apps/*` + `packages/*` layout with no extra tooling.

**Consequence:** The command table in `CLAUDE.md` uses npm equivalents
(`npm install`, `npm run dev`, `npm --workspace apps/api …`). If the team later
standardises on pnpm, replace the lockfile and update `CLAUDE.md` again.

---

## 2026-10-12 — Target Node 22 LTS

**Decision:** The project targets **Node 22 LTS**. Recorded in root
`package.json` `engines` (`">=22 <23"`) and in `.nvmrc` (`22`).

**Why:** The machine currently runs **Node 25, which is a non-LTS (Current)
release** — it gets no long-term support window and is not a safe baseline for
a physical-security product that will run unattended in production. Node 22 is
the active LTS line.

**Consequence:** `npm install` prints an `EBADENGINE` warning under Node 25.
That warning is expected until the local runtime is switched (`nvm use 22` /
`fnm use 22`). `engines-strict` is deliberately **not** set, so Node 25 can
still be used for local UI work without blocking installs.

---

## 2026-10-12 — Login identifier is a single email-or-phone field

**Decision:** `/login` takes one `identifier` field accepting either an email
address or a 10-digit Indian mobile number, rather than two separate fields or
a toggle. `classifyIdentifier()` in `@safelock/shared` tells the API which
column to look up.

**Why:** Fewer taps on mobile, and the user does not have to remember which
credential they signed up with.

**Consequence:** The API's login handler must branch on the identifier type and
must return the **same** generic error for an unknown identifier and a wrong
password (`GENERIC_LOGIN_ERROR`), so the endpoint cannot be used to enumerate
registered accounts.

---

## 2026-10-12 — Zod schemas live in `packages/shared`

**Decision:** All auth validation schemas (`loginSchema`, `signupSchema`,
`emailSchema`, `phoneSchema`, `passwordSchema`) live in
`packages/shared/src/schemas/auth.ts` and are imported by the web app today and
the Express API later. The package is consumed as raw TypeScript via
`transpilePackages`, so there is no build step.

**Why:** One definition of "valid", enforced on both sides. Client-side
validation is UX only; the API must re-run the same schema.

**Consequence:** `acceptedTerms` is modelled as `z.boolean().refine(v => v)`
rather than `z.literal(true)` so a form can start unchecked. `acceptedTerms`
and `confirmPassword` are client-only and are **not** sent to the API.

---

## 2026-10-12 — Mock API mode for frontend-first development

**Decision:** `NEXT_PUBLIC_USE_MOCK_API=true` routes auth calls to an
in-browser fake (`apps/web/src/lib/mockApi.ts`) with ~650ms of simulated
latency and one seeded demo account (`demo@example.com` / `Demo1234`).

**Why:** The login/signup UI is being built before the API exists.

**Guard rails:**
- `apps/web/src/lib/env.ts` **throws at startup** if `NODE_ENV === 'production'`
  and mock mode is on, so a production build cannot ship the fake backend.
- A sticky amber **"Mock mode"** badge is visible on every page while it is on.
- Mock accounts live in module memory only; nothing created by signup survives a
  full page reload. The mock "session" is a user id in `sessionStorage` — it is
  not a token and grants nothing.

**Consequence:** When the real API lands, set `NEXT_PUBLIC_USE_MOCK_API=false`
and point `NEXT_PUBLIC_API_URL` at it. No component changes required.

---

## 2026-10-12 — No tokens in web storage

**Decision:** The web app never reads or writes auth tokens. The session is an
httpOnly cookie set by the API; the client sends `credentials: 'include'` and
learns who the user is from `GET /auth/me`.

**Why:** A token readable from JavaScript is a token stealable by any XSS on the
page. For a product that physically opens a safe, that is unacceptable.

**Consequence:** Route guards in `RouteGuard.tsx` are **UX only** — they cannot
inspect the cookie. Real access control is the API rejecting unauthorised
requests. Passwords are held only in react-hook-form state for the duration of
a submit and are never logged, persisted, or copied.
