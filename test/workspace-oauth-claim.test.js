'use strict';

/*
 * The owner card accepted one thing: a Personal Access Token, pasted by hand.
 *
 * That is a poor way to prove who you are on a phone, and it is not the only
 * way this deployment already knows how. The cohort login has used GitHub
 * OAuth all along. The owner surface could not, because it was built as an
 * independently authenticated surface and nothing wired OAuth into it.
 *
 * Adding it has three constraints that are easy to get wrong, so they are held
 * here rather than trusted:
 *
 *   1. Ownership still comes from the setup credential, never from being
 *      signed in. The contract is explicit that a legacy cohort session does
 *      not grant workspace ownership, and OAuth must not become a way around
 *      that -- the credential is still required, and the cohort session is
 *      still not consulted.
 *
 *   2. The setup credential never travels in a URL. The runbook forbids it.
 *      So OAuth proves identity FIRST and the credential is submitted after,
 *      on an ordinary same-site POST -- never as a query parameter carried
 *      through GitHub's redirect.
 *
 *   3. The OAuth app has one registered callback. Reusing it means the
 *      callback must be able to tell a workspace verification from a cohort
 *      login, and must not create a cohort session when it is the former.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const api = fs.readFileSync(path.join(root, 'src', 'workspace-api.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const ui = fs.readFileSync(path.join(root, 'public', 'workspace-ui.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

const { verifiedHumanIdentity } = require('../src/workspace-identity');

/* ---- 1. an OAuth identity is a human identity ---- */

/* The identity model already refuses app installations and bots. It must not
 * also refuse OAuth, or the whole feature is impossible. */
const oauthAccount = {
  provider: 'github', providerAccountId: 4242, login: 'owner',
  type: 'User', authMethod: 'oauth'
};
const identity = verifiedHumanIdentity(oauthAccount);
assert.strictEqual(identity.provider, 'github');
assert.strictEqual(identity.providerUserId, '4242');
assert.strictEqual(identity.instance, 'https://github.com');

/* And it still refuses what it always refused, however the token was obtained. */
assert.throws(() => verifiedHumanIdentity({ ...oauthAccount, authMethod: 'github-app' }),
  error => error.code === 'WORKSPACE_HUMAN_IDENTITY_REQUIRED');
assert.throws(() => verifiedHumanIdentity({ ...oauthAccount, bot: true }),
  error => error.code === 'WORKSPACE_HUMAN_IDENTITY_REQUIRED');
assert.throws(() => verifiedHumanIdentity({ ...oauthAccount, type: 'Organization' }),
  error => error.code === 'WORKSPACE_HUMAN_IDENTITY_REQUIRED');

/* ---- 2. the routes exist and are shaped correctly ---- */

assert(/router\.get\('\/oauth\/start'/.test(api),
  'starting OAuth must be a GET: the router refuses a non-GET without the x-nv header, and a redirect cannot carry one');
assert(/router\.post\('\/oauth\/claim'/.test(api),
  'claiming must be a POST, so it passes the origin and CSRF checks');
assert(/router\.post\('\/oauth\/sign-in'/.test(api),
  'signing in with a verified OAuth identity must be a POST');

/* Both new POSTs are pre-session, so they must be treated as entry routes --
 * otherwise the session check rejects them before the credential is read, and
 * the per-IP attempt limit never sees them. */
const entryLine = api.match(/const entry = [^;]+;/);
assert(entryLine, 'the entry-route test must be locatable');
for (const route of ['/oauth/claim', '/oauth/sign-in']) {
  assert(entryLine[0].includes(route), `${route} must count as an entry route: ${entryLine[0]}`);
}

/* ---- 3. the setup credential is still what grants ownership ---- */

const claimRoute = api.slice(api.indexOf("router.post('/oauth/claim'"), api.indexOf("router.post('/oauth/sign-in'"));
assert(claimRoute.length > 0);
assert(claimRoute.includes('store.claim({ secret: req.body.setupSecret,'),
  'the OAuth claim must pass the reader\'s setup credential to the single-claim path -- naming the field in the allowlist is not the same as using it');
assert(claimRoute.includes("fields(req, ['setupSecret'])"),
  'the OAuth claim must accept the setup credential and nothing else');

/* And it is never a query parameter anywhere in the flow. */
assert(!/setupSecret/.test(api.slice(api.indexOf("router.get('/oauth/start'"), api.indexOf("router.post('/oauth/claim'"))),
  'the setup credential must not appear anywhere in the redirect leg');
assert(!/req\.query\.setupSecret|setupSecret=/.test(api + server),
  'the setup credential must never be read from or written to a URL');

/* ---- 4. the shared callback tells the two flows apart ---- */

const callback = server.slice(server.indexOf("app.get('/api/oauth/callback'"), server.indexOf("app.get('/api/alpha/privacy'"));
assert(callback.length > 0, 'the OAuth callback must be locatable');
/*
 * Reachability, which the first version of this guard never checked.
 *
 * The callback opens with a state check. Both flows pass through it, and they
 * carry different state cookies -- so a check written against the cohort
 * cookie alone refuses every workspace return before the branch below is ever
 * consulted. The feature shipped unreachable and the guard was satisfied,
 * because it only asked what came before addAccount, not what came before the
 * refusal.
 */
const stateRefusal = callback.indexOf('OAuth state mismatch');
assert(stateRefusal > 0, 'the state refusal must be locatable');
const beforeRefusal = callback.slice(0, stateRefusal);
assert(beforeRefusal.includes("unseal(getCookie(req, 'nv_workspace_oauth_intent'))"),
  'the workspace flow must be recognised BEFORE the state refusal, or every workspace return is refused and the branch below is dead code');
assert(/workspaceFlow \|\| cohortFlow|cohortFlow \|\| workspaceFlow/.test(beforeRefusal),
  'the state check must accept either flow, not only the cohort one');

assert(callback.includes("unseal(getCookie(req, 'nv_workspace_oauth_intent'))"),
  'the intent must be unsealed from a cookie; reading it from the query would let anyone turn a cohort login into a workspace verification by editing a URL');
assert(!/req\.query\.(flow|intent|workspace)\b/.test(callback),
  'the callback must not take its flow from a query parameter');

/*
 * The decisive one. On the workspace leg the callback must NOT call addAccount:
 * that is what creates a cohort session, and a cohort session must never be a
 * step on the path to owning the workspace.
 */
/* The CALL, not the word: prose above the branch mentions addAccount by name,
 * and matching that would test the comment rather than the control flow. */
const addAccountCall = callback.indexOf('await addAccount(');
assert(addAccountCall > 0, 'the cohort-session call must be locatable');
const workspaceLeg = callback.slice(0, addAccountCall);
assert(workspaceLeg.includes('workspace-oauth-intent'),
  'the workspace leg must be decided before any cohort session is created');
assert(workspaceLeg.includes("return res.redirect('/?workspace=verified');"),
  'the workspace leg must RETURN its redirect; dropping the return falls straight through into a cohort login');

/*
 * A verification that never goes stale is a standing key. The handover cookie
 * is sealed, so it cannot be forged -- but sealed is not the same as fresh, and
 * a stolen one would work forever without this.
 */
/* Bounded to this function's own body. A slice that ran to the next route
 * would also contain challengeContext, whose expiry check is written
 * identically -- and the assertion would then pass on the neighbour's work. */
const verifiedStart = api.indexOf('const verifiedOauth = req =>');
const verifiedReader = api.slice(verifiedStart, api.indexOf('\n  };', verifiedStart));
assert(verifiedReader.length > 0, 'the verified-OAuth reader must be locatable');
assert(/value\.expiresAt <= Date\.now\(\)/.test(verifiedReader),
  'the verified OAuth handover must expire; without the check a captured cookie never goes stale');
assert(/kind !== 'workspace-oauth-verified\/v1'/.test(verifiedReader),
  'the handover must be accepted only under its own sealed kind, never another sealed value');

/* ---- 5. the verified identity is sealed, not trusted from the client ---- */

assert(/workspace-oauth-verified/.test(server) && /workspace-oauth-verified/.test(api),
  'the verified OAuth identity must be handed over under one sealed kind that both sides name');
assert(/seal\(/.test(callback), 'the callback must seal what it hands to the workspace surface');
assert(!/localStorage|sessionStorage/.test(ui.slice(ui.indexOf('oauth'))),
  'the verified identity must never be parked in browser storage');

/* ---- 6. cookies that survive the redirect ---- */

/*
 * The workspace cookies are Path=/api/workspace; SameSite=Strict. Neither
 * survives a cross-site redirect back from GitHub, so the two OAuth cookies
 * must be declared deliberately rather than inheriting that helper.
 */
for (const flag of ['SameSite=Lax', 'HttpOnly']) {
  assert(new RegExp(flag).test(callback), `the handover cookie must set ${flag}`);
}
assert(!/SameSite=Strict/.test(callback),
  'a Strict cookie is not sent on the navigation back from GitHub, so it cannot carry this handover');

/* ---- 7. the reader is offered the choice ---- */

/* Exact ids, closing quote included. `workspaceSetupSecret` also matches
 * `workspaceSetupSecretGone`, so a renamed-away field would pass a substring
 * test while the control it names no longer exists. */
assert(html.includes('id="workspaceOauthBtn"'), 'the owner card must offer an OAuth control');
assert(html.includes('id="workspaceSetupSecret"'),
  'the setup credential field must remain: OAuth proves identity, it does not grant ownership');
assert(html.includes('id="workspaceSignInBtn"') && html.includes('id="workspaceClaimBtn"'),
  'the token path must remain alongside OAuth, not be replaced by it');

/* ---- 8. the token OAuth issued is used, not discarded ---- */

/*
 * Verifying with OAuth and then asking for a pasted token is the friction the
 * feature exists to remove. The first version did exactly that: it read the
 * identity out of the verification and dropped the access token beside it, so
 * a reader who signed in with GitHub still met an empty "Git connection token"
 * field and a workbench that refused to open.
 */
const adopt = api.slice(api.indexOf('const adoptOauthConnection'), api.indexOf("router.post('/oauth/claim'"));
assert(adopt.length > 0, 'the connection adoption must be locatable');
assert(/connectAccount\(\{ token: verified\.token/.test(adopt),
  'the OAuth access token must be used to bind the connection, not discarded');
assert(/store\.bindConnection\(/.test(adopt) && /store\.selectConnection\(/.test(adopt),
  'the connection must be bound AND selected, or the workbench still refuses to open');
assert(/catch \{ return result; \}/.test(adopt),
  'adoption is best effort: a failure here must not undo a claim that already succeeded');

/* Per request, never module state: two claims in flight must not read each
 * other's verification. */
assert(/adoptOauthConnection = async \(result, verified\)/.test(adopt),
  'the verification must travel as an argument, not as shared state across requests');
assert(!/let verifiedOauthValue/.test(api),
  'no cross-request shared verification');

for (const route of ["router.post('/oauth/claim'", "router.post('/oauth/sign-in'"]) {
  const body = api.slice(api.indexOf(route), api.indexOf(route) + 900);
  assert(/adoptOauthConnection\(result, verified\)/.test(body),
    `${route} must adopt the verified connection so the workbench is usable`);
}

console.log('workspace oauth claim: ok');
