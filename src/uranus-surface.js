'use strict';

/*
 * Uranus: the attack surface, and who is let through it.
 *
 * Missing authorization and records fetched by an id nobody checks are the
 * most common serious flaws in quickly built applications, and scanners that
 * read one line at a time almost never see them: nothing on the line is
 * wrong. What is wrong is what is absent -- a check that the handler never
 * makes. So Uranus maps the application's endpoints first (Express, Fastify,
 * Koa, Hono, NestJS, Next.js route handlers, pages and server actions,
 * SvelteKit, Remix, Supabase edge functions, serverless handlers, Flask,
 * FastAPI, Django views, net/http, Gin, Echo, Fiber, chi, gorilla/mux,
 * Spring, JAX-RS, Laravel and Symfony), then asks of each one:
 *
 *   is it guarded?  a middleware before it, a check inside it, a decorator
 *                   on it, a global guard that may cover it;
 *   does it change something?  its method, or the writes in its body;
 *   is it meant to be public?  sign-in, webhooks, health checks, contact
 *                   forms and the like are open by design;
 *   does it fetch a record by an id the caller chose, and never tie the
 *                   record to the caller?
 *
 * A finding here says exactly what was and was not seen. Where a guard could
 * live somewhere the code does not show -- a Next.js middleware, a router
 * mounted behind authentication in another file -- the finding is one to
 * confirm, with the check that settles it, never a verdict.
 *
 * Route patterns ("/api/posts/:id") are the only text this module keeps from
 * the repository, and only when they are made of the characters a route is
 * made of; they are what a reader needs to find the endpoint.
 */

/*
 * A middleware's name says what it does. Anything that speaks of auth, a
 * session, access, a guard, a role, a token or an owner, or that requires
 * or ensures something, is read as a guard; the common middleware that is
 * not one -- body parsers, uploads, CORS, rate limits, loggers -- is not.
 */
const AUTH_NAME = /(auth|session|access|guard|protect|permission|role|login|logged|jwt|token|signed|owner|admin|member|tenant|acl|rbac|passport|clerk|^require|^ensure|^verify|^check|^is[A-Z]|^can[A-Z]|^must|apiKey|bearer)/i;
const NOT_AUTH = /^(cors|helmet|compression|morgan|logger|json|urlencoded|raw|text|bodyParser|multer|upload|single|array|fields|none|any|static|rateLimit|rateLimiter|limiter|slowDown|timeout|cache|csrf|csrfProtection|validate\w*|express|router|next)$/i;
const AUTH_BODY = /\b(getServerSession|getSession|auth\s*\(\s*\)|currentUser\s*\(|getUser\s*\(|getAuth\s*\(|auth\s*\.\s*getUser|auth\s*\.\s*api\s*\.\s*getSession|getToken\s*\(|verifyToken|verifyJwt|verifyJWT|jwt\s*\.\s*verify|jwtVerify|validateRequest|validateSession|verifySession|requireAuth|requireUser|requireSession|requireAdmin|getKindeServerSession|clerkClient|withAuth|isAuthenticated|req\s*\.\s*user\b|req\s*\.\s*auth\b|request\s*\.\s*auth\b|ctx\s*\.\s*state\s*\.\s*user|locals\s*\.\s*(user|session)|session\s*\??\s*\.\s*user|unauthori[sz]ed|Unauthori[sz]ed|forbidden|Forbidden|status\s*\(\s*40[13]\s*\)|status\s*:\s*40[13]|40[13]\s*\)|x-api-key|authorization)\b/;
const PY_AUTH = /\b(login_required|jwt_required|current_user|get_current_user|get_current_active_user|requires_auth|token_required|verify_token|decode_token|jwt\s*\.\s*decode|is_authenticated|IsAuthenticated|permission_required|permission_classes|LoginRequiredMixin|abort\s*\(\s*40[13]|status_code\s*=\s*40[13]|HTTP_40[13]|Depends\s*\(\s*\w*(auth|user|current|verify|token|security|admin)\w*|Security\s*\()/i;
/*
 * Go, Java and PHP, read from a handler's tokens joined by spaces: `c . Get ( "user" )`.
 * A check of who is calling -- a status of 401 or 403 sent, a token parsed,
 * the signed-in user or principal read, an authorization asked for.
 */
const GO_AUTH = /\b(StatusUnauthorized|StatusForbidden|jwt\s*\.\s*Parse\w*|ParseWithClaims|jwtauth|VerifyIDToken|VerifyToken\w*|ValidateToken\w*|BasicAuth\s*\(|claims\b|Claims\b|(ctx|c|context)\s*\.\s*(Get|MustGet|Locals|Value)\s*\(\s*"(user|userID|userId|user_id|uid|claims|currentUser|session|auth|principal|account)"|Context\s*\(\s*\)\s*\.\s*Value\s*\(\s*\w*([Uu]ser|[Cc]laims|[Ss]ession|[Aa]uth)\w*|session\w*\s*\.\s*(Get|Values)\b|currentUser|CurrentUser|UserFromContext|userFromContext|requireUser|RequireUser|"Authorization")|\b40[13]\s*\)/;
const JAVA_AUTH = /(@\s*(PreAuthorize|PostAuthorize|Secured|RolesAllowed|AuthenticationPrincipal|CurrentUser)\b|\b(Principal|Authentication|OAuth2User|Jwt|UserDetails)\s+\w+\s*[,)]|\bSecurityContextHolder\b|\bgetUserPrincipal\b|\bisUserInRole\b|\bgetRemoteUser\b|\bHttpStatus\s*\.\s*(UNAUTHORIZED|FORBIDDEN)\b|\bSC_(UNAUTHORIZED|FORBIDDEN)\b|\bAccessDeniedException\b|\bAuthenticationException\b|\bSecurityUtils\b|\bcurrentUser\b)/;
const PHP_AUTH = /(\bAuth\s*::\s*(check|user|id|guard|authenticate|viaRequest|onceBasic)\b|\bauth\s*\(\s*[^)]*\)\s*->\s*(user|check|id|guest)\b|\$request\s*->\s*user\s*\(|\bGate\s*::\s*(authorize|allows|denies|check|inspect)\b|\$this\s*->\s*(authorize|authorizeResource|denyAccessUnlessGranted|getUser|isGranted)\b|\babort_(if|unless)\s*\(|\babort\s*\(\s*40[13]\b|#\s*\[\s*(IsGranted|Security)\b|\bis_user_logged_in\b|\bcurrent_user_can\b|\bwp_verify_nonce\b|\bcheck_admin_referer\b|\bcheck_ajax_referer\b|\$_SESSION\s*\[\s*"\w*(user|auth|logged|admin)|\bhttp_response_code\s*\(\s*40[13]\b|"HTTP\/1\.[01] 40[13])/i;
const LARAVEL_GUARD = /^(auth|can|role|roles|permission|permissions|ability|abilities|scope|scopes|client|signed|password\.confirm|admin)\b/i;
const MUTATION_GO = /\.\s*(Exec|ExecContext|Create|CreateInBatches|Save|Delete|Update|Updates|UpdateColumn|UpdateColumns|Insert\w*|Upsert|Put\w*|Remove\w*|Set|HSet|Del|InsertOne|InsertMany|UpdateOne|UpdateMany|DeleteOne|DeleteMany|ReplaceOne|BulkWrite)\s*\(|\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b|\bMethod(Post|Put|Patch|Delete)\b/;
const MUTATION_JAVA = /\.\s*(save|saveAll|saveAndFlush|delete|deleteById|deleteAll|deleteAllById|persist|merge|remove|update|insert|executeUpdate|batchUpdate|insertOne|updateOne|deleteOne|upsert)\s*\(|\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/i;
const MUTATION_PHP = /->\s*(save|delete|update|create|insert|forceDelete|destroy|increment|decrement|attach|detach|sync|syncWithoutDetaching|toggle|updateOrCreate|firstOrCreate|upsert|persist|remove|flush|executeStatement|push|restore)\s*\(|::\s*(create|destroy|insert|update|updateOrCreate|firstOrCreate|upsert|query\s*\(\s*\)\s*->\s*(update|delete|insert))\s*\(|\bDB\s*::\s*(insert|update|delete|statement|unprepared)\b|\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b|\b(file_put_contents|unlink|move_uploaded_file|wp_insert_post|wp_update_post|wp_delete_post|update_option|delete_option|update_user_meta)\s*\(/i;
/* Records fetched by an id, and the caller tied to them, in Go, Java and PHP. */
const CF_RECORD_LOOKUP = /\.\s*(First|Take|Find|FindByID|FindById|GetByID|GetById|FindOne|FindByPk|findById|getById|getReferenceById|getOne|findOne|find)\s*\(|\bem\s*\.\s*find\s*\(|::\s*(find|findOrFail|findOrNew|firstOrFail|findMany|where\s*\(\s*"id")\s*\(|->\s*(find|findOrFail|findOneBy|getRepository)\s*\(|WHERE\s+[\w."]*\bid\s*=/i;
const CF_OWNER_BINDING = /(\bAuth\s*::\s*(id|user)\b|\bauth\s*\(\s*\)\s*->\s*(id|user)\b|->\s*user\s*\(\s*\)|\bgetUser\s*\(|\bPrincipal\b|\bprincipal\b|\bgetPrincipal\b|@\s*AuthenticationPrincipal\b|->\s*(authorize|can|cannot)\s*\(|\bGate\s*::|\bdenyAccessUnlessGranted\b|\bisGranted\b|\bIsGranted\b|\bpolicy\b|\bPolicy\b|\b(user_id|userId|UserID|owner_id|ownerId|OwnerID|tenant_id|tenantId|TenantID|author_id|authorId|AuthorID|account_id|accountId|AccountID|team_id|teamId|TeamID|org_id|orgId|OrgID)\b|\bclaims\s*\.\s*\w*(Sub|User|ID|Id)\b)/;
const LANGUAGE_BODY_AUTH = Object.freeze({ go: GO_AUTH, java: JAVA_AUTH, php: PHP_AUTH });
const LANGUAGE_MUTATION = Object.freeze({ go: MUTATION_GO, java: MUTATION_JAVA, php: MUTATION_PHP });
const MUTATION_JS = /\.\s*(insert|insertOne|insertMany|update|updateOne|updateMany|upsert|deleteOne|deleteMany|destroy|create|createMany|save|findOneAndUpdate|findByIdAndUpdate|findByIdAndDelete|findOneAndDelete|findByIdAndRemove|bulkWrite|increment|decrement|setDoc|updateDoc|deleteDoc|addDoc|executeRaw|\$executeRaw|\$executeRawUnsafe|transaction)\s*\(|\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b|\.\s*from\s*\(\s*\S+\s*\)\s*\.\s*(insert|update|upsert|delete)\b|\.\s*(delete|remove|deleteMany)\s*\(\s*\{|\.\s*delete\s*\(\s*\)\s*\.\s*(eq|match|in|neq|filter)\b/i;
/*
 * A write in Python: a session told to add, delete or commit, an ORM call that
 * creates or changes, or a statement that inserts, updates or deletes. A bare
 * `.execute(` is not one -- it runs SELECTs as often as anything -- nor is a
 * set's `.add(` or a dict's `.update(`.
 */
const MUTATION_PY = /\b(?:session|db)\s*\.\s*(add|add_all|delete|merge|commit|flush)\s*\(|\.\s*(save|create|bulk_create|bulk_update|update_or_create|get_or_create|insert|insert_one|insert_many|update_one|update_many|delete_one|delete_many|replace_one|executemany)\s*\(|\.\s*update\s*\(\s*\w+\s*=|\.\s*delete\s*\(\s*\)|\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/i;
const PUBLIC_ROUTE = /(^|\/|-|_|\.)(login|log-in|signin|sign-in|signup|sign-up|register|logout|log-out|signout|sign-out|auth|oauth|oidc|sso|saml|callback|webhooks?|hooks?|health|healthz|healthcheck|ready|readyz|live|livez|ping|status|version|contact|subscribe|unsubscribe|newsletter|waitlist|forgot|reset|password|verify|verification|confirm|magic|magic-link|otp|invite|invitation|public|csp-report|report-uri|track|tracking|analytics|events?|beacon|feedback|stripe|paddle|lemonsqueezy|checkout|cron|og|sitemap|robots|manifest|favicon|revalidate|preview|share|feed|rss|search|graphql|trpc|session|csrf|captcha|recaptcha|turnstile|redeem|config|client-config|settings\.json)(\/|$|\.|-|_|\[|:)/i;
const ADMIN_ROUTE = /(^|\/)(admin|administrator|debug|_debug|__debug__|internal|metrics|env|\.env|seed|reset-db|resetdb|flush|test-only|phpinfo|actuator|console|graphql-playground|playground|migrate|migrations|backup|export-all|impersonate|sudo|superuser|maintenance|dev-tools|devtools)(\/|$|\[|:|\.)/i;
const ID_SOURCE = /\b(params|query|body|searchParams|args|path_params|kwargs)\s*\??\.\s*(get\s*\(\s*['"])?\w*(id|Id|ID|uuid|Uuid|UUID)['"]?\b|\[\s*['"]\w*(id|Id|ID|uuid)['"]\s*\]/;
const RECORD_LOOKUP = /\.\s*(findUnique|findUniqueOrThrow|findFirst|findFirstOrThrow|findById|findByPk|findOne|findOneBy|findOneByOrFail|getItem|findOneAndUpdate|findByIdAndUpdate|findByIdAndDelete|findOneAndDelete)\s*\(|\.\s*(doc|document)\s*\(\s*\w|\.\s*(update|delete|destroy)\s*\(\s*\{\s*where\b|\.\s*eq\s*\(\s*['"]id['"]|where\s*:\s*\{\s*id\b|WHERE\s+[\w."]*\bid\s*=|objects\s*\.\s*(get|filter)\s*\(|get_object_or_404\s*\(|query\s*\.\s*get\s*\(|session\s*\.\s*get\s*\(/;
const OWNER_BINDING = /\b(userId|user_id|ownerId|owner_id|authorId|author_id|createdBy|created_by|creatorId|creator_id|tenantId|tenant_id|orgId|org_id|organizationId|organization_id|accountId|account_id|teamId|team_id|workspaceId|workspace_id|memberId|member_id|profileId|profile_id|customerId|customer_id|uid|owner|user\s*\.\s*id|user\s*\.\s*sub|user\s*\?\.\s*id|session\s*\.\s*user|auth\s*\.\s*uid|auth\.uid|currentUser|current_user|request\s*\.\s*user|req\s*\.\s*user\s*\.\s*(id|_id|sub)|can\s*\(|cannot\s*\(|authorize|ability|policy|checkPermission|hasPermission|has_perm|isOwner|is_owner|assertOwner|ensureOwner|canAccess|canEdit|canView|canDelete|belongsTo|belongs_to|user\s*=\s*request\.user|filter\s*\(\s*user)\b/;
const PROJECT_AUTH = /(spring-boot-starter-security|org\.springframework\.security|@EnableWebSecurity|javax\.annotation\.security|jakarta\.annotation\.security|laravel\/(sanctum|passport|breeze|fortify|jetstream|ui)|Illuminate\\Support\\Facades\\Auth|symfony\/security-bundle|Symfony\\Component\\Security|golang-jwt|dgrijalva\/jwt-go|lestrrat-go\/jwx|go-chi\/jwtauth|gin-contrib\/sessions|gorilla\/sessions|casbin|coreos\/go-oidc|markbates\/goth|next-auth|@auth\/|@clerk\/|@supabase\/(auth-helpers|ssr)|supabase\s*\.\s*auth|passport|lucia|better-auth|@kinde-oss|iron-session|express-session|jsonwebtoken|\bjose\b|jwt\s*\.\s*verify|getServerSession|firebase\/auth|firebase-admin|@auth0|auth0|keycloak|flask_login|flask_jwt|django\.contrib\.auth|fastapi_users|authlib|login_required|Depends\s*\(\s*get_current_user|@nestjs\/passport|AuthGuard|clerkMiddleware|withAuth|requireAuth)/;

function text(route) {
  return String(route.bodyText || '');
}

function isGuarded(route) {
  if (LANGUAGE_BODY_AUTH[route.language]) {
    if (route.authDecorated) return true;
    const guard = route.language === 'php' ? (word => LARAVEL_GUARD.test(word) || (AUTH_NAME.test(word) && !NOT_AUTH.test(word)))
      : (word => AUTH_NAME.test(word) && !NOT_AUTH.test(word));
    if ((route.middleware || []).some(guard)) return true;
    /* r.Use(authMiddleware) on the same router, before this route */
    for (const use of route.uses || []) {
      if (use.line > route.line) continue;
      if (use.words.some(word => guard(word.replace(/^.*\./, '')) || guard(word))) return true;
    }
    return LANGUAGE_BODY_AUTH[route.language].test(text(route));
  }
  if (route.framework === 'flask' || route.framework === 'fastapi' || route.framework === 'django') {
    if (route.authDecorated) return true;
    if ((route.middleware || []).some(entry => PY_AUTH.test(entry))) return true;
    return PY_AUTH.test(text(route));
  }
  if ((route.middleware || []).some(word => AUTH_NAME.test(word) && !NOT_AUTH.test(word))) return true;
  /* app.use(requireAuth) or app.use('/api', auth) registered before this route in the same file. */
  for (const use of route.uses || []) {
    if (use.line > route.line) continue;
    if (!use.words.some(word => AUTH_NAME.test(word) && !NOT_AUTH.test(word) && !/^(app|router|use)$/.test(word))) continue;
    if (!use.prefix || (route.route && route.route.startsWith(use.prefix))) return true;
  }
  return AUTH_BODY.test(text(route));
}

/*
 * A call that may change something, by its verb. A POST handler the read can
 * see whole, that calls none of these and writes nothing, only reads: a
 * search, a calculation, a parse. PUT, PATCH and DELETE change by definition.
 * A setter is not on the list: it changes an object in hand, not the store.
 */
const WRITE_VERB = /\b(create|save|add|insert|update|upsert|delete|remove|destroy|put|store|persist|register|upload|send|post|submit|apply|import|enqueue|publish|write|charge|transfer|pay|refund|approve|reject|assign|invite|reset|change|edit|modify|patch|mark|toggle|commit|flush|exec|execute|run|process|handle|dispatch|emit|notify|mail|move|copy|rename|archive|restore|grant|revoke|ban|block|follow|like|vote|order|checkout|book|reserve|cancel)\w*\s*\(/i;
function readsOnly(route, body) {
  if (!body || route.method !== 'POST') return false;
  const writes = LANGUAGE_MUTATION[route.language] || (route.framework === 'flask' || route.framework === 'fastapi' || route.framework === 'django' ? MUTATION_PY : MUTATION_JS);
  /* the handler's own name and its annotations are not calls it makes */
  const calls = body.replace(/\b(?:async\s+)?(?:def|function|func)\s+[\w$]+/g, ' ').replace(/@\s*[\w.]+(?:\s*\([^)]*\))?/g, ' ').replace(/#\s*\[[^\]]*\]/g, ' ');
  return !writes.test(body) && !WRITE_VERB.test(calls);
}

function isMutation(route) {
  const body = text(route);
  /* A server action is always a POST; what makes it a change is what its body writes. */
  if (route.method === 'ACTION') return MUTATION_JS.test(body);
  if (readsOnly(route, body)) return false;
  if (/^(POST|PUT|PATCH|DELETE)$/.test(route.method) || /,(POST|PUT|PATCH|DELETE)|(POST|PUT|PATCH|DELETE),/.test(route.method)) return true;
  if (route.framework === 'flask' || route.framework === 'fastapi' || route.framework === 'django') return MUTATION_PY.test(body);
  if (LANGUAGE_MUTATION[route.language]) return LANGUAGE_MUTATION[route.language].test(body) || /\b[Mm]ethod\s*={2,3}\s*"(POST|PUT|PATCH|DELETE)"|\bcase\s+"(POST|PUT|PATCH|DELETE)"/.test(body);
  if (/\bmethod\s*={2,3}\s*['"](POST|PUT|PATCH|DELETE)['"]/.test(body)) return true;
  return MUTATION_JS.test(body);
}

/*
 * Places a guard might live that this read cannot tie to a route: a Next.js
 * middleware with a matcher, a router mounted behind authentication in
 * another file, Django's own middleware list, a FastAPI app or router
 * declared with dependencies. Their presence turns "no guard seen" into
 * "confirm the guard".
 */
function globalGuards(files) {
  const found = [];
  for (const file of files) {
    const content = String(file.text || '');
    if (/^(src\/)?middleware\.(ts|js|mjs)$/.test(file.path)) found.push({ kind: 'middleware', path: file.path });
    else if (/\b(app|router|server)\s*\.\s*use\s*\([^)]*\b(require\w*Auth\w*|auth\w*|authenticate\w*|passport\s*\.\s*authenticate|jwt\w*|protect\w*|isAuthenticated|clerkMiddleware|verify\w*Token)\b/i.test(content)) found.push({ kind: 'mounted', path: file.path });
    else if (/MIDDLEWARE\s*=\s*\[[^\]]*(LoginRequiredMiddleware|login_required)/.test(content)) found.push({ kind: 'django', path: file.path });
    else if (/(FastAPI|APIRouter)\s*\([^)]*dependencies\s*=\s*\[[^\]]*Depends/.test(content)) found.push({ kind: 'dependencies', path: file.path });
    else if (/\bAPP_GUARD\b|useGlobalGuards\s*\(/.test(content)) found.push({ kind: 'nest', path: file.path });
    /* Spring Security: a filter chain that asks for authentication of what it matches */
    else if (/\.java$|\.kt$/.test(file.path) && /(SecurityFilterChain|WebSecurityConfigurerAdapter|@EnableWebSecurity)/.test(content) && /\.\s*(authenticated|hasRole|hasAnyRole|hasAuthority|hasAnyAuthority|access)\s*\(/.test(content)) found.push({ kind: 'spring-security', path: file.path });
    /* JAX-RS or servlet filters that turn away unauthenticated requests */
    else if (/\.java$/.test(file.path) && /implements\s+[\w\s,]*(ContainerRequestFilter|Filter)\b/.test(content) && /(UNAUTHORIZED|FORBIDDEN|SC_UNAUTHORIZED|SC_FORBIDDEN|abortWith|sendError\s*\(\s*(401|403))/.test(content)) found.push({ kind: 'filter', path: file.path });
    /* Symfony: access_control rules in the security configuration */
    else if (/(^|\/)config\/packages\/security\.ya?ml$/.test(file.path) && /access_control\s*:[\s\S]*roles\s*:\s*\[?\s*(ROLE_|IS_AUTHENTICATED)/.test(content)) found.push({ kind: 'symfony', path: file.path });
    /* Go: router.Use(auth) in the file that builds the router, routes registered elsewhere */
    else if (/\.go$/.test(file.path) && /\b\w+\s*\.\s*Use\s*\([^)]*\b\w*(auth|Auth|jwt|JWT|session|Session|protect|Protect|require|Require)\w*/.test(content)) found.push({ kind: 'mounted', path: file.path });
    if (found.length >= 6) break;
  }
  return found;
}

/* Supabase edge functions whose platform JWT check is switched off in config.toml. */
function openEdgeFunctions(files) {
  const config = files.find(file => file.path === 'supabase/config.toml');
  const open = new Set();
  if (!config || typeof config.text !== 'string') return open;
  let current = null;
  for (const raw of config.text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    const section = /^\[functions\.([A-Za-z0-9_-]+)\]$/.exec(line);
    if (section) { current = section[1]; continue; }
    if (/^\[/.test(line)) { current = null; continue; }
    if (current && /^verify_jwt\s*=\s*false$/.test(line)) open.add(current);
  }
  return open;
}

/*
 * Every endpoint, what guards it, and the findings that follow from what is
 * missing. `routes` come from the flow analysis; `files` are the files read.
 */
function analyseSurface({ routes, files }) {
  const all = Array.isArray(files) ? files : [];
  const projectHasAuth = all.some(file => typeof file.text === 'string' && PROJECT_AUTH.test(file.text));
  const guards = globalGuards(all);
  const edgeOpen = openEdgeFunctions(all);
  const surfaces = [];
  const raw = [];
  for (const route of routes || []) {
    const guarded = isGuarded(route);
    const mutation = isMutation(route);
    const label = route.route || null;
    const publicByDesign = Boolean(label && PUBLIC_ROUTE.test(label)) || /(^|\/)(auth|webhooks?|health|cron)(\/|\.|$)/i.test(route.path);
    const admin = Boolean(label && ADMIN_ROUTE.test(label));
    const edgeName = route.framework === 'supabase-edge' ? (/^supabase\/functions\/([^/]+)\//.exec(route.path) || [])[1] : null;
    let auth = guarded ? 'guarded' : guards.length ? 'unknown' : 'open';
    /* Next.js server actions and Supabase edge functions are guarded by the platform only where configured. */
    if (!guarded && edgeName && !edgeOpen.has(edgeName)) auth = 'platform';
    const surface = {
      method: route.method, route: label, path: route.path, line: route.line, framework: route.framework,
      auth, mutation, publicByDesign, admin, action: Boolean(route.action),
      startLine: route.startLine || route.line, endLine: route.endLine || route.line,
      /* where the handler is written, when not beside the route: a controller, a handler in another file */
      handlerPath: route.handlerPath || route.path,
      /* a handler named at the route and written elsewhere: its lines are its own, not the route's */
      separate: Boolean(route.handlerPath && route.handlerPath !== route.path) || Boolean(route.handlerLine && route.handlerLine !== route.line)
    };
    surfaces.push(surface);

    const verdictFor = () => {
      if (guards.length) return { verdict: 'needs-validation', blocker: { reason: 'global-guard', path: guards[0].path, kind: guards[0].kind } };
      if (!projectHasAuth) return { verdict: 'needs-validation', blocker: { reason: 'no-auth-anywhere' } };
      return { verdict: 'confirmed', blocker: null };
    };
    const reach = { method: route.method, route: label, auth, framework: route.framework };
    if (edgeName && edgeOpen.has(edgeName) && !guarded) {
      raw.push({ rule: 'ACC-005', path: route.path, line: route.line, verdict: 'confirmed', blocker: null, reach });
      continue;
    }
    if (guarded || auth === 'platform') {
      /* A guarded endpoint that fetches a record by a caller's id and never ties it to the caller. */
      const body = text(route);
      const hasId = ID_SOURCE.test(body) || /[:[<{]\w*id\b/i.test(label || '');
      const cfamily = Boolean(LANGUAGE_BODY_AUTH[route.language]);
      const lookup = cfamily ? CF_RECORD_LOOKUP.test(body) : RECORD_LOOKUP.test(body);
      const owned = cfamily ? CF_OWNER_BINDING.test(body) || OWNER_BINDING.test(body) : OWNER_BINDING.test(body);
      if (hasId && lookup && !owned && !/supabase\s*\.\s*from\s*\(/.test(body)) {
        raw.push({ rule: 'ACC-002', path: route.path, line: route.line, verdict: 'needs-validation', blocker: { reason: 'owner' }, reach });
      }
      continue;
    }
    if (route.action) {
      if (mutation) raw.push({ rule: 'ACC-004', path: route.path, line: route.line, ...verdictFor(), reach });
      continue;
    }
    if (admin) {
      raw.push({ rule: 'ACC-003', path: route.path, line: route.line, ...verdictFor(), reach });
      continue;
    }
    if (mutation && !publicByDesign) raw.push({ rule: 'ACC-001', path: route.path, line: route.line, ...verdictFor(), reach });
  }
  surfaces.sort((a, b) => String(a.path).localeCompare(String(b.path)) || a.line - b.line);
  return {
    surfaces,
    raw,
    projectHasAuth,
    globalGuards: guards,
    counts: {
      endpoints: surfaces.filter(entry => !entry.action).length,
      actions: surfaces.filter(entry => entry.action).length,
      open: surfaces.filter(entry => entry.auth === 'open').length,
      guarded: surfaces.filter(entry => entry.auth === 'guarded').length,
      unknown: surfaces.filter(entry => entry.auth === 'unknown' || entry.auth === 'platform').length,
      mutating: surfaces.filter(entry => entry.mutation).length
    }
  };
}

/*
 * Where a flow can be reached from: the endpoint whose handler holds the
 * line the value entered on. A flow that enters outside any handler has no
 * reach to report.
 */
function reachOf(flow, surfaces) {
  const entry = flow.trace && flow.trace[0];
  if (!entry) return null;
  /* the handler's own lines first, the narrowest that holds the line; then a route whose handler follows it inline */
  const holding = surfaces.filter(item => (item.handlerPath || item.path) === entry.path && entry.line >= item.startLine && entry.line <= item.endLine)
    .sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine));
  const surface = holding[0] || surfaces.find(item => !item.separate && item.path === entry.path && entry.line >= item.line && entry.line <= Math.max(item.endLine, item.line));
  if (!surface) return null;
  return { method: surface.method, route: surface.route, auth: surface.auth, framework: surface.framework };
}

module.exports = Object.freeze({ analyseSurface, reachOf, AUTH_NAME, AUTH_BODY, PUBLIC_ROUTE, ADMIN_ROUTE });
