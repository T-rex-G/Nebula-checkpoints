# Nebulaverse-X Phase 0 coverage

| Phase 0 requirement | Implementation | Verification |
|---|---|---|
| Official name | `Nebulaverse-X` in package, UI, manifest, API and Blueprint | release and package contracts |
| Single release identity | `src/version.js` derives from `package.json` | release contract + server smoke |
| Predictable Node runtime | Node major 22 pinned in `engines` and `.nvmrc` | package contract + CI |
| PWA shell offline | versioned `nv-static-v522` service-worker cache | Playwright PWA test |
| Private cache isolation | `nv-api-v1-<opaque-scope>` | unit policy tests + Playwright identity tests |
| Explicit offline opt-in | Settings per repository | Playwright settings test |
| Cache bounds | 24h, 100 entries, 1 MiB/object, 25 MiB total | offline policy contract |
| Sensitive endpoint exclusion | network-only route classification | offline policy tests |
| Legacy cache removal | activation deletes `nv-api-perm` and `nv-api` | unit + Playwright upgrade test |
| Identity-boundary cleanup | login/switch/remove/logout/revocation/Emergency Shield | account contract + Playwright |
| Neon schema evolution | numbered transactional checksum migrations | migration tests |
| Clean release package | deterministic ZIP and SHA-256 | package contract + clean-room extraction |
| Continuous integration | syntax, tests, audit, secrets, browser tests, package | `.github/workflows/ci.yml` |
| Browser regression coverage | PWA install, cache opt-in/isolation, failed remote logout | Playwright suite |
| Existing architecture | one Render Free service + existing optional Neon | package contract |
