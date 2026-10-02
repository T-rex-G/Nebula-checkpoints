# Audit platform

Repository Audit, Exposure, and Website answer different questions. A finding is
evidence within the scope stated by its report. A complete automated run does
not establish that a repository or website is secure or accessible.

| Option | What it checks | Main limits |
| --- | --- | --- |
| Repository Audit | Source patterns, data flow, dependencies, licences, SQL rules and configuration | File, byte and analysis budgets; provider and intelligence availability |
| Exposure | Credential candidates in the selected tree, optionally reachable history, archives and Base64 values | Explicit scan budgets; verification and anonymous readability require separate user actions |
| Website security | Anonymous HTTPS responses, effective headers, exposed files, shipped scripts and recognised libraries | Bounded pages and same-origin resources; no authenticated application testing |
| Rendered experience | One page in Chromium at 1440×900 and 390×844, WCAG automation, layout, metadata, timing and screenshots | Same-origin resources only; single lab sample; manual interaction and design review still needed |

## Reading incomplete evidence

Website security reports include `coverage`, `observedScore` and per-category
completion information. Failed reads, unreadable bodies, truncated responses,
resource caps, unavailable intelligence and exhausted deadlines prevent a final
grade: `score` and `grade` are null. A legacy report without coverage is also
shown as unknown. Positive findings remain actionable in partial reports.

Repository audit now retains SQL migration state across the traced-file and
rules-only batches. `FORCE ROW LEVEL SECURITY` does not enable RLS. Oversized
eligible files remain in the coverage denominator. Finding identities describe
the operation, exclude literals, and survive ordinary line movement; the engine
version changes the comparison baseline for older findings.

The dependency watch reports advisory and exploitation-source availability
separately. An unavailable or truncated source cannot silently remove its
previous alerts or clear known exploitation facts.

Exposure checks merge resolutions and counts decoded history/archive bytes
against the scan budget. A decoding or time ceiling produces partial coverage.
Verification and readability answers show their observation time and expiry;
an old answer does not establish present validity.

## Finding lists and exports

Exposure filters run over all findings in the current generation. The display
shows loaded rows, matching rows, and the total. **Load more findings** continues
with a signed cursor bound to the account, repository and filters. A change to
the evidence invalidates the cursor with `EXPOSURE_CURSOR_STALE` (409); refresh
starts a consistent view. Malformed or mismatched cursors return 400. Cursors
expire after 20 minutes and share a purpose-derived key across server instances.

CSV and SARIF exports fetch every matching page before downloading. A failed or
stale page refuses the export instead of producing a partial file. Exports are
bounded to 10,000 rows; narrow the filters if the limit is reached. Exported
paths use the redacted display path and never include credential values.

The rendered report can be exported as self-contained HTML with embedded JPEGs
or JSON evidence. The HTML escapes target-controlled text and includes a
restrictive Content Security Policy. The application keeps screenshots in
memory, not local storage. Downloaded evidence remains with its recipient.

## Enable the rendered browser

The browser worker is disabled by default, including on small hosted instances.
Use a maintained Chromium build on Linux in an environment that supports its OS sandbox.
The shipping launcher never adds `--no-sandbox`. If the sandbox or executable
is unavailable, the request fails explicitly.

```bash
# Run as the application user, in an image with Chromium's OS libraries.
npx playwright-core install chromium
NV_RENDERED_AUDIT_ENABLED=true npm start
```

Alternatively set `NV_RENDERED_AUDIT_BROWSER_PATH` to an operator-controlled
absolute executable path, such as `/usr/bin/chromium`. The availability endpoint
checks the setting and executable; OS sandbox support is verified at launch.
Install libraries as part of the deployment image and restart the application
after changing its environment. Maintain Chromium security updates separately
when using a system executable.

Each audit has a separate Node process with a 256 MiB JavaScript heap, a minimal
environment without provider/database/session credentials, a temporary browser
profile, and disposable contexts. The parent kills the worker and its process
descendants, including Chromium's separate process group, on timeout or
cancellation. Normal completion, logout and server shutdown also dispose of
the run. Results expire from server memory after two minutes. They are not
written to the audit database.

Browser HTTP requests are intercepted and fulfilled by the existing public-DNS,
address-pinning and TLS guard. A dead proxy blocks unhandled browser traffic;
QUIC and non-proxied WebRTC are disabled. Service workers, WebSockets, downloads,
popups, cross-origin resources and methods other than GET/HEAD are blocked.
Provider headers, browser cookies and authorization are never forwarded;
response cookies are discarded. No forms or links are activated by the auditor.
Website scripts can still initiate allowed reads on their own origin.

The worker permits 80 requests, four concurrent reads, 2 MiB per resource and
20 MiB of charged response bodies across both viewports (the larger of encoded
and decoded size; a failed decompression consumes its reservation). Compressed
bodies are decoded with an output cap. The engine has 90 seconds, the parent process 95
seconds and the job 100 seconds. Screenshots cover each initial viewport and
are limited to 1.5 MiB each. One browser audit runs per server process, with a
30-second cooldown per account and origin. Multiple replicas have independent
concurrency limits; apply ingress quotas when deploying a cluster.

The JavaScript heap cap does not bound Chromium's native memory. Deploy the
application in a resource-limited container as an unprivileged user, with no
unnecessary filesystem mounts. Load-test the actual host before enabling this
feature for general traffic. The current free-tier deployment is not qualified
for a concurrent browser workload by these local tests.

## Interpreting the rendered report

Blocked resources are listed as coverage gaps. A CDN-dependent site can render
incompletely; screenshots must be read alongside those gaps. Target pages and
their scripts are untrusted input, including their rendered text and metadata.
Automated accessibility findings need human triage, and axe's incomplete checks
remain explicitly unresolved.

Timing is measured once through the intercepted network, without network or
device throttling. LCP and CLS describe that lab sample, not field Core Web
Vitals, a Lighthouse score, or a performance SLA. The report does not invent an
INP or visual-design score. Metadata observations cannot establish indexing or
search rankings. Keyboard navigation, screen-reader use, authenticated flows,
conversion clarity, typography and visual hierarchy remain manual review work.

## Verification

`npm test` includes the scanner accuracy and rendered-route regressions.
`npm run test:exposure-store`, `npm run test:code-audit-history` and
`npm run test:migrations` require `NV_TEST_DATABASE_URL` pointing at a disposable
PostgreSQL administrator database; they create and remove their own databases.

The Playwright suites `rendered-audit.spec.js` and `exposure-pagination.spec.js`
exercise real desktop/mobile browser behavior with synthetic target responses.
The renderer test injects a test-only launch override for restricted CI; it does
not establish production sandbox availability. Other audit, Exposure and
Website suites remain in the normal browser gate. The standing accessibility
audit also visits Audit, Exposure and Website in both themes and viewports.
