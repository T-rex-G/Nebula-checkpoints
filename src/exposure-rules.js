'use strict';

const { KEY_KINDS, KEY_PATTERN, classifyKey } = require('./supabase-key-kinds');

/*
 * The rules a scan runs that the release gate does not.
 *
 * The gate asks one question -- is there a secret in this repository -- and
 * stops at the first match, because one is enough to fail a build. Every rule
 * it carries has to be a secret beyond argument, or builds fail for things
 * that are fine. A scan asks a wider question and a reader triages the answer,
 * so it can afford more rules; what it cannot afford is noise. A screen of
 * findings that are mostly documentation placeholders is a screen people stop
 * reading, and then the one real key on it is missed.
 *
 * So every rule here is chosen for precision over reach, and has three
 * defences against being wrong:
 *
 *   - A shape the issuer made distinctive. Almost every rule anchors on a
 *     prefix a provider chose precisely so tokens could be recognised --
 *     `sk_live_`, `glsa_`, `npm_`, OpenAI's embedded `T3BlbkFJ` -- and the
 *     boundaries on both sides stop a match inside a longer identifier.
 *   - Keywords. Each rule names substrings every match must contain, and a
 *     file containing none of them is never searched with that rule. This is
 *     what keeps sixty rules as cheap as six, and it is only an optimisation:
 *     `detectInText` can be asked to skip it, and a test proves the results
 *     are identical either way.
 *   - A plausibility check on the bytes. Documentation is full of a live-key
 *     prefix followed by a run of x's, and of `YOUR_API_KEY_HERE`; a real
 *     token is random. (The example is described rather than written out: a
 *     provider's push protection takes the literal for a key, which is the
 *     same false positive this check exists to refuse.) A match that looks like a placeholder, or whose characters
 *     are too uniform to be random, is not reported.
 *
 * What is deliberately absent: generic `password = ...` assignments, bare
 * 40-character hex strings, and anything that needs the surrounding code to
 * mean something. Those are where secret scanners earn their reputation for
 * noise, and a rule that fires on every lockfile teaches a reader that the
 * findings list is not worth reading.
 */

/*
 * A token is bounded on both sides by characters that cannot continue it, so
 * `xsk_live_...` inside some longer identifier is not a Stripe key and a key
 * followed by more key-shaped characters is not truncated into a match.
 */
const LEFT = '(?<![A-Za-z0-9_-])';
const RIGHT = '(?![A-Za-z0-9_-])';

function token(body, flags = '') {
  return new RegExp(`${LEFT}(?:${body})${RIGHT}`, flags);
}

/*
 * A credential with no prefix of its own, recognised only where it is
 * assigned to a name that says what it is: `OCTOPUS_API_KEY=API-...`,
 * `asanaToken: "2/..."`. The name is behind a lookbehind, so the finding is
 * the credential and not the formatting around it.
 */
function named(names, body) {
  return new RegExp(`(?<=(?:${names})[A-Za-z0-9_]*["']?\\s{0,4}[:=]\\s{0,4}["']?)(?:${body})${RIGHT}`, 'i');
}

/* ---- Is this plausibly a real secret? ---------------------------------- */

/*
 * The words and runs that mark a placeholder. Checked case-insensitively over
 * the whole match: a real token is random, and the chance of one of these
 * appearing by accident in thirty random characters is vanishingly small --
 * while the chance of one appearing in a README is close to certain.
 */
const PLACEHOLDER = /x{6,}|\*{4,}|0{8,}|1{8,}|1234567|abcdefgh|example|sample|dummy|placeholder|your[_-]?(?:api|secret|token|key|access)|changeme|redacted|insert[_-]?|replace[_-]?me|fake[_-]?|not[_-]?a[_-]?real|<[a-z_ -]+>|\$\{|\{\{/i;

function shannonEntropy(value) {
  const text = String(value || '');
  if (!text) return 0;
  const counts = new Map();
  for (const character of text) counts.set(character, (counts.get(character) || 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/*
 * Three bits per character is the floor. Random hexadecimal sits near four,
 * base-62 near six; a string of one repeated character is zero and one
 * alternating between two is one. The floor is low enough that no real token
 * format falls under it and high enough that the obvious fakes do.
 */
const MIN_ENTROPY_BITS = 3;

function plausibleSecret(secret) {
  const value = String(secret || '');
  if (PLACEHOLDER.test(value)) return false;
  return shannonEntropy(value) >= MIN_ENTROPY_BITS;
}

/*
 * A connection string's password is where the secret is, and the placeholders
 * people write there are a short, well-known list. Templating syntax is a
 * reference to a secret kept elsewhere, which is exactly what should have been
 * done, and is not reported.
 */
const PLACEHOLDER_PASSWORDS = new Set([
  'password', 'passw0rd', 'pass', 'passwd', 'pwd', 'secret', 'changeme', 'change_me', 'admin',
  'root', 'test', 'testing', 'example', 'sample', 'dummy', 'placeholder', 'guest', 'user',
  'username', 'mypassword', 'yourpassword', 'your_password', 'redacted'
]);

function plausibleConnectionString(secret) {
  const match = /:\/\/[^:@\s]*:([^@\s]*)@/.exec(String(secret || ''));
  const password = match ? match[1] : '';
  if (!password || PLACEHOLDER_PASSWORDS.has(password.toLowerCase())) return false;
  if (/^[*x.]+$/i.test(password) || /\$\{|\{\{|%\(|<|>|^\$[A-Z_]/.test(password)) return false;
  return !/example|placeholder|changeme|your[_-]?pass/i.test(password);
}

/* ---- The rules ---------------------------------------------------------- */

/*
 * Grouped by the kind of thing leaked, which is how the narration table and a
 * reader both think about them. The Supabase pair comes first and shares one
 * pattern: which of the two a match belongs to is decided by decoding the key,
 * because an anonymous key and a service-role key look almost identical and
 * are nothing alike.
 */
const EXPOSURE_RULES = Object.freeze([
  /* ---- Supabase ---- */
  Object.freeze({
    rule: 'supabase-anon-key',
    regex: KEY_PATTERN,
    keywords: Object.freeze(['sb_', 'eyj']),
    accept: secret => {
      const kind = classifyKey(secret).kind;
      return kind === KEY_KINDS.ANON || kind === KEY_KINDS.PUBLISHABLE;
    }
  }),
  Object.freeze({
    rule: 'supabase-service-role-key',
    regex: KEY_PATTERN,
    keywords: Object.freeze(['sb_', 'eyj']),
    /*
     * `sb_secret_` as well as the JWT, because a project that has migrated to
     * the newer key format has the same credential under a different name and
     * a rule that missed it would report the repository clean.
     */
    accept: secret => {
      const kind = classifyKey(secret).kind;
      return kind === KEY_KINDS.SERVICE_ROLE || kind === KEY_KINDS.SECRET;
    }
  }),

  /* The Management API token: it reaches every project the account can. */
  Object.freeze({ rule: 'supabase-access-token', regex: token('sbp_(?:oauth_)?[a-f0-9]{40}'), keywords: Object.freeze(['sbp_']), accept: plausibleSecret }),

  /* ---- Cloud and infrastructure ---- */
  Object.freeze({
    rule: 'aws-secret-access-key',
    /*
     * The one contextual rule. An AWS secret has no prefix -- it is forty
     * characters of base64 -- so it is recognised only beside the name it is
     * almost always assigned to, and the lookbehind keeps that name out of
     * the match: the identity of a finding is the secret, not the formatting
     * around it.
     */
    regex: /(?<=(?:aws_?secret_?access_?key|aws_?secret_?key|secret_?access_?key)["']?\s{0,4}[:=]\s{0,4}["']?)[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])/i,
    keywords: Object.freeze(['secret']),
    accept: plausibleSecret
  }),
  Object.freeze({ rule: 'google-api-key', regex: token('AIza[0-9A-Za-z_-]{35}'), keywords: Object.freeze(['aiza']), accept: plausibleSecret }),
  Object.freeze({ rule: 'google-oauth-client-secret', regex: token('GOCSPX-[A-Za-z0-9_-]{28}'), keywords: Object.freeze(['gocspx-']), accept: plausibleSecret }),
  Object.freeze({
    rule: 'azure-storage-account-key',
    regex: /DefaultEndpointsProtocol=https?;AccountName=[A-Za-z0-9]{3,24};AccountKey=[A-Za-z0-9+/]{86}==/,
    keywords: Object.freeze(['accountkey=']),
    accept: plausibleSecret
  }),
  Object.freeze({ rule: 'digitalocean-token', regex: token('do[opr]_v1_[a-f0-9]{64}'), keywords: Object.freeze(['_v1_']), accept: plausibleSecret }),
  Object.freeze({ rule: 'cloudflare-origin-ca-key', regex: token('v1\\.0-[a-f0-9]{24}-[a-f0-9]{146}'), keywords: Object.freeze(['v1.0-']), accept: plausibleSecret }),
  Object.freeze({ rule: 'hashicorp-vault-token', regex: token('(?:hvs|hvb)\\.[A-Za-z0-9_-]{24,}'), keywords: Object.freeze(['hvs', 'hvb']), accept: plausibleSecret }),
  Object.freeze({ rule: 'terraform-cloud-token', regex: token('[A-Za-z0-9]{14}\\.atlasv1\\.[A-Za-z0-9_-]{60,70}'), keywords: Object.freeze(['.atlasv1.']), accept: plausibleSecret }),
  Object.freeze({ rule: 'doppler-token', regex: token('dp\\.(?:pt|st|ct|sa|scim|audit)\\.[A-Za-z0-9]{40,44}'), keywords: Object.freeze(['dp.']), accept: plausibleSecret }),
  Object.freeze({ rule: 'pulumi-token', regex: token('pul-[a-f0-9]{40}'), keywords: Object.freeze(['pul-']), accept: plausibleSecret }),
  Object.freeze({ rule: 'render-api-key', regex: token('rnd_[A-Za-z0-9]{32}'), keywords: Object.freeze(['rnd_']), accept: plausibleSecret }),
  Object.freeze({ rule: 'neon-api-key', regex: token('napi_[a-z0-9]{64}'), keywords: Object.freeze(['napi_']), accept: plausibleSecret }),
  Object.freeze({ rule: 'flyio-token', regex: token('fo1_[A-Za-z0-9_-]{43}'), keywords: Object.freeze(['fo1_']), accept: plausibleSecret }),
  Object.freeze({ rule: 'netlify-token', regex: token('nfp_[A-Za-z0-9]{36}'), keywords: Object.freeze(['nfp_']), accept: plausibleSecret }),
  Object.freeze({ rule: 'planetscale-token', regex: token('pscale_(?:tkn|pw|oauth)_[A-Za-z0-9=._-]{32,64}'), keywords: Object.freeze(['pscale_']), accept: plausibleSecret }),
  Object.freeze({ rule: 'databricks-token', regex: token('dapi[a-f0-9]{32}(?:-[0-9])?'), keywords: Object.freeze(['dapi']), accept: plausibleSecret }),
  /* An Entra ID application secret carries `Q~` after its first four characters. */
  Object.freeze({ rule: 'azure-ad-client-secret', regex: token('[A-Za-z0-9_~.]{3}[0-9]Q~[A-Za-z0-9_~.-]{31,34}'), keywords: Object.freeze(['q~']), accept: plausibleSecret }),
  /* Half of a pair, like an AWS key id -- the secret is usually a line away. */
  Object.freeze({ rule: 'alibaba-access-key', regex: token('LTAI[A-Za-z0-9]{12,20}'), keywords: Object.freeze(['ltai']), accept: plausibleSecret }),
  Object.freeze({ rule: 'heroku-api-key', regex: token('HRKU-[A-Za-z0-9_-]{58,64}'), keywords: Object.freeze(['hrku-']), accept: plausibleSecret }),
  Object.freeze({ rule: 'tailscale-key', regex: token('tskey-(?:api|auth|client|webhook|scim)-[A-Za-z0-9]{6,32}-[A-Za-z0-9]{20,64}'), keywords: Object.freeze(['tskey-']), accept: plausibleSecret }),
  Object.freeze({ rule: 'onepassword-service-token', regex: token('ops_eyJ[A-Za-z0-9_-]{100,}'), keywords: Object.freeze(['ops_eyj']), accept: plausibleSecret }),
  /* Contextual: a Datadog key is thirty-two hex characters with no prefix, so
     it is recognised only beside the name it is assigned to. */
  Object.freeze({
    rule: 'datadog-api-key',
    regex: /(?<=(?:datadog|dd)_?(?:api|app(?:lication)?)_?key["']?\s{0,4}[:=]\s{0,4}["']?)[a-f0-9]{32}(?:[a-f0-9]{8})?(?![A-Za-z0-9])/i,
    keywords: Object.freeze(['datadog', 'dd']),
    accept: plausibleSecret
  }),

  /* ---- Source, packages and CI ---- */
  Object.freeze({ rule: 'npm-token', regex: token('npm_[A-Za-z0-9]{36}'), keywords: Object.freeze(['npm_']), accept: plausibleSecret }),
  Object.freeze({ rule: 'pypi-token', regex: token('pypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{50,}'), keywords: Object.freeze(['pypi-ageichlwas5vcmc']), accept: plausibleSecret }),
  Object.freeze({ rule: 'docker-hub-token', regex: token('dckr_pat_[A-Za-z0-9_-]{27}'), keywords: Object.freeze(['dckr_pat_']), accept: plausibleSecret }),
  Object.freeze({ rule: 'circleci-token', regex: token('CCIPAT_[A-Za-z0-9]{22}_[a-f0-9]{40}'), keywords: Object.freeze(['ccipat_']), accept: plausibleSecret }),
  Object.freeze({ rule: 'buildkite-token', regex: token('bkua_[a-f0-9]{40}'), keywords: Object.freeze(['bkua_']), accept: plausibleSecret }),
  Object.freeze({ rule: 'jfrog-token', regex: token('AKCp[A-Za-z0-9]{69}'), keywords: Object.freeze(['akcp']), accept: plausibleSecret }),
  Object.freeze({ rule: 'atlassian-api-token', regex: token('ATATT3[A-Za-z0-9_=-]{186}'), keywords: Object.freeze(['atatt3']), accept: plausibleSecret }),
  Object.freeze({ rule: 'linear-api-key', regex: token('lin_api_[A-Za-z0-9]{40}'), keywords: Object.freeze(['lin_api_']), accept: plausibleSecret }),
  Object.freeze({ rule: 'postman-api-key', regex: token('PMAK-[a-f0-9]{24}-[a-f0-9]{34}'), keywords: Object.freeze(['pmak-']), accept: plausibleSecret }),
  Object.freeze({ rule: 'figma-token', regex: token('figd_[A-Za-z0-9_-]{40,}'), keywords: Object.freeze(['figd_']), accept: plausibleSecret }),
  Object.freeze({ rule: 'sentry-token', regex: token('sntry[su]_[A-Za-z0-9+/=_-]{40,}'), keywords: Object.freeze(['sntry']), accept: plausibleSecret }),
  Object.freeze({ rule: 'grafana-token', regex: token('glsa_[A-Za-z0-9]{32}_[A-Fa-f0-9]{8}|glc_[A-Za-z0-9+/]{32,400}={0,2}'), keywords: Object.freeze(['glsa_', 'glc_']), accept: plausibleSecret }),
  Object.freeze({ rule: 'new-relic-key', regex: token('NRAK-[A-Z0-9]{27}'), keywords: Object.freeze(['nrak-']), accept: plausibleSecret }),
  Object.freeze({ rule: 'dynatrace-token', regex: token('dt0c01\\.[A-Z0-9]{24}\\.[A-Z0-9]{64}'), keywords: Object.freeze(['dt0c01.']), accept: plausibleSecret }),
  Object.freeze({ rule: 'bitbucket-app-password', regex: token('ATBB[A-Za-z0-9_=.-]{32}'), keywords: Object.freeze(['atbb']), accept: plausibleSecret }),
  Object.freeze({ rule: 'sonarqube-token', regex: token('sqp_[a-f0-9]{40}|squ_[a-f0-9]{40}|sqa_[a-f0-9]{40}'), keywords: Object.freeze(['sqp_', 'squ_', 'sqa_']), accept: plausibleSecret }),
  Object.freeze({ rule: 'sourcegraph-token', regex: token('sgp_(?:[a-f0-9]{16}_)?[a-f0-9]{40}'), keywords: Object.freeze(['sgp_']), accept: plausibleSecret }),
  Object.freeze({ rule: 'octopus-deploy-key', regex: named('octopus', 'API-[A-Z0-9]{26,32}'), keywords: Object.freeze(['octopus']), accept: plausibleSecret }),
  Object.freeze({ rule: 'prefect-api-key', regex: token('pnu_[A-Za-z0-9]{36}'), keywords: Object.freeze(['pnu_']), accept: plausibleSecret }),
  Object.freeze({ rule: 'launchdarkly-key', regex: named('launchdarkly|ld_(?:sdk|api)', '(?:api|sdk)-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'), keywords: Object.freeze(['launchdarkly', 'ld_']), accept: plausibleSecret }),
  Object.freeze({ rule: 'rubygems-token', regex: token('rubygems_[a-f0-9]{48}'), keywords: Object.freeze(['rubygems_']), accept: plausibleSecret }),
  Object.freeze({ rule: 'nuget-api-key', regex: token('oy2[a-z0-9]{43}'), keywords: Object.freeze(['oy2']), accept: plausibleSecret }),
  Object.freeze({ rule: 'cratesio-token', regex: token('cio[A-Za-z0-9]{32}'), keywords: Object.freeze(['cio']), accept: plausibleSecret }),
  Object.freeze({ rule: 'clojars-token', regex: token('CLOJARS_[a-z0-9]{60}'), keywords: Object.freeze(['clojars_']), accept: plausibleSecret }),
  /*
   * Registry credentials in a Docker config: base64 of `user:password`, which
   * decodes to nothing any other rule names -- so the field itself is the
   * finding, and only when it decodes to a user and a password.
   */
  Object.freeze({
    rule: 'docker-config-auth',
    regex: /(?<="auth"\s{0,4}:\s{0,4}")[A-Za-z0-9+/]{12,}={0,2}(?=")/,
    keywords: Object.freeze(['"auth"']),
    accept: secret => {
      let decoded = '';
      try { decoded = Buffer.from(secret, 'base64').toString('utf8'); } catch { return false; }
      return /^[^:\s]{1,256}:\S{6,}$/.test(decoded) && plausibleSecret(decoded.slice(decoded.indexOf(':') + 1));
    }
  }),
  /* A legacy npm token -- a UUID -- only means anything after `_authToken=`. */
  Object.freeze({
    rule: 'npmrc-auth-token',
    regex: /(?<=:_authToken=)[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?![A-Za-z0-9-])/,
    keywords: Object.freeze(['_authtoken']),
    accept: plausibleSecret
  }),

  /* ---- AI providers ---- */
  Object.freeze({
    rule: 'openai-api-key',
    /* `T3BlbkFJ` is base64 for "OpenAI" and sits inside every key format the
       provider has issued, which is what makes this precise. */
    regex: token('sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}T3BlbkFJ[A-Za-z0-9_-]{20,}'),
    keywords: Object.freeze(['t3blbkfj']),
    accept: plausibleSecret
  }),
  Object.freeze({ rule: 'anthropic-api-key', regex: token('sk-ant-(?:api03|admin01)-[A-Za-z0-9_-]{80,}'), keywords: Object.freeze(['sk-ant-']), accept: plausibleSecret }),
  Object.freeze({ rule: 'huggingface-token', regex: token('hf_[A-Za-z0-9]{34}'), keywords: Object.freeze(['hf_']), accept: plausibleSecret }),
  Object.freeze({ rule: 'replicate-token', regex: token('r8_[A-Za-z0-9]{37}'), keywords: Object.freeze(['r8_']), accept: plausibleSecret }),
  Object.freeze({ rule: 'groq-api-key', regex: token('gsk_[A-Za-z0-9]{52}'), keywords: Object.freeze(['gsk_']), accept: plausibleSecret }),
  Object.freeze({ rule: 'perplexity-api-key', regex: token('pplx-[A-Za-z0-9]{48}'), keywords: Object.freeze(['pplx-']), accept: plausibleSecret }),
  Object.freeze({ rule: 'xai-api-key', regex: token('xai-[A-Za-z0-9]{80}'), keywords: Object.freeze(['xai-']), accept: plausibleSecret }),
  Object.freeze({ rule: 'openrouter-api-key', regex: token('sk-or-v1-[a-f0-9]{64}'), keywords: Object.freeze(['sk-or-v1-']), accept: plausibleSecret }),
  Object.freeze({ rule: 'pinecone-api-key', regex: token('pcsk_[A-Za-z0-9]{5,6}_[A-Za-z0-9]{50,70}'), keywords: Object.freeze(['pcsk_']), accept: plausibleSecret }),
  Object.freeze({ rule: 'langsmith-api-key', regex: token('lsv2_(?:pt|sk)_[a-f0-9]{32}_[a-f0-9]{10}'), keywords: Object.freeze(['lsv2_']), accept: plausibleSecret }),

  /* ---- Payments and commerce ---- */
  Object.freeze({ rule: 'stripe-live-key', regex: token('(?:sk|rk)_live_[0-9a-zA-Z]{24,247}'), keywords: Object.freeze(['_live_']), accept: plausibleSecret }),
  Object.freeze({ rule: 'stripe-test-key', regex: token('(?:sk|rk)_test_[0-9a-zA-Z]{24,247}'), keywords: Object.freeze(['_test_']), accept: plausibleSecret }),
  Object.freeze({ rule: 'stripe-webhook-secret', regex: token('whsec_[A-Za-z0-9+/=]{32,}'), keywords: Object.freeze(['whsec_']), accept: plausibleSecret }),
  Object.freeze({ rule: 'square-token', regex: token('sq0(?:atp|csp)-[0-9A-Za-z_-]{22,43}'), keywords: Object.freeze(['sq0']), accept: plausibleSecret }),
  Object.freeze({ rule: 'shopify-token', regex: token('shp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}'), keywords: Object.freeze(['shp']), accept: plausibleSecret }),
  Object.freeze({ rule: 'braintree-token', regex: token('access_token\\$production\\$[0-9a-z]{16}\\$[0-9a-f]{32}'), keywords: Object.freeze(['access_token$production$']), accept: plausibleSecret }),
  Object.freeze({ rule: 'flutterwave-secret-key', regex: token('FLWSECK(?:_TEST)?-[a-f0-9]{32}-X'), keywords: Object.freeze(['flwseck']), accept: plausibleSecret }),
  Object.freeze({ rule: 'easypost-api-key', regex: token('EZAK[a-f0-9]{54}'), keywords: Object.freeze(['ezak']), accept: plausibleSecret }),
  Object.freeze({ rule: 'shippo-token', regex: token('shippo_(?:live|test)_[a-f0-9]{40}'), keywords: Object.freeze(['shippo_']), accept: plausibleSecret }),
  Object.freeze({ rule: 'plaid-access-token', regex: token(['access-sandbox', 'access-development', 'access-production']
    .map(prefix => `${prefix}-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}`).join('|')), keywords: Object.freeze(['access-production', 'access-sandbox', 'access-development']), accept: plausibleSecret }),
  Object.freeze({ rule: 'woocommerce-secret', regex: token('cs_[a-f0-9]{40}'), keywords: Object.freeze(['cs_']), accept: plausibleSecret }),

  /* ---- Messaging, email and webhooks ---- */
  Object.freeze({ rule: 'sendgrid-api-key', regex: token('SG\\.[A-Za-z0-9_-]{22}\\.[A-Za-z0-9_-]{43}'), keywords: Object.freeze(['sg.']), accept: plausibleSecret }),
  Object.freeze({ rule: 'mailgun-api-key', regex: token('key-[0-9a-f]{32}'), keywords: Object.freeze(['key-']), accept: plausibleSecret }),
  Object.freeze({ rule: 'mailchimp-api-key', regex: token('[0-9a-f]{32}-us[0-9]{1,2}'), keywords: Object.freeze(['-us']), accept: plausibleSecret }),
  Object.freeze({ rule: 'resend-api-key', regex: token('re_[A-Za-z0-9]{8}_[A-Za-z0-9]{24}'), keywords: Object.freeze(['re_']), accept: plausibleSecret }),
  Object.freeze({ rule: 'twilio-api-key', regex: token('SK[0-9a-f]{32}'), keywords: Object.freeze(['sk']), accept: plausibleSecret }),
  Object.freeze({ rule: 'slack-webhook-url', regex: token('https://hooks\\.slack\\.com/(?:services|workflows|triggers)/[A-Za-z0-9_/+-]{20,}'), keywords: Object.freeze(['hooks.slack.com']), accept: plausibleSecret }),
  Object.freeze({ rule: 'discord-webhook-url', regex: token('https://(?:ptb\\.|canary\\.)?discord(?:app)?\\.com/api/webhooks/[0-9]{17,20}/[A-Za-z0-9_-]{60,68}'), keywords: Object.freeze(['discord']), accept: plausibleSecret }),
  Object.freeze({ rule: 'teams-webhook-url', regex: token('https://[a-z0-9-]+\\.webhook\\.office\\.com/webhookb2/[A-Za-z0-9@/-]{60,}'), keywords: Object.freeze(['webhook.office.com']), accept: plausibleSecret }),
  Object.freeze({ rule: 'telegram-bot-token', regex: token('[0-9]{8,10}:AA[A-Za-z0-9_-]{33}'), keywords: Object.freeze([':aa']), accept: plausibleSecret }),
  Object.freeze({ rule: 'firebase-cloud-messaging-key', regex: token('AAAA[A-Za-z0-9_-]{7}:[A-Za-z0-9_-]{140}'), keywords: Object.freeze(['aaaa']), accept: plausibleSecret }),
  Object.freeze({ rule: 'twitter-bearer-token', regex: token('AAAAAAAAAAAAAAAAAAAAA[A-Za-z0-9%]{30,}'), keywords: Object.freeze(['aaaaaaaaaaaaaaaaaaaaa']), accept: plausibleSecret }),
  Object.freeze({ rule: 'mapbox-secret-token', regex: token('sk\\.eyJ[A-Za-z0-9_-]{50,}\\.[A-Za-z0-9_-]{20,}'), keywords: Object.freeze(['sk.eyj']), accept: plausibleSecret }),
  Object.freeze({ rule: 'slack-app-token', regex: token('xapp-[0-9]-[A-Z0-9]{9,12}-[0-9]{10,16}-[a-f0-9]{64}'), keywords: Object.freeze(['xapp-']), accept: plausibleSecret }),
  /* A Discord bot token has no prefix of its own, so it is recognised beside
     a name that says it is one. */
  Object.freeze({ rule: 'discord-bot-token', regex: named('discord', '[MN][A-Za-z0-9]{23,25}\\.[A-Za-z0-9_-]{6}\\.[A-Za-z0-9_-]{27,38}'), keywords: Object.freeze(['discord']), accept: plausibleSecret }),

  /* ---- Productivity and content platforms ---- */
  Object.freeze({ rule: 'notion-token', regex: token('secret_[A-Za-z0-9]{43}|ntn_[A-Za-z0-9]{46}'), keywords: Object.freeze(['secret_', 'ntn_']), accept: plausibleSecret }),
  Object.freeze({ rule: 'airtable-token', regex: token('pat[A-Za-z0-9]{14}\\.[a-f0-9]{64}'), keywords: Object.freeze(['pat']), accept: plausibleSecret }),
  Object.freeze({ rule: 'hubspot-token', regex: token('pat-(?:na|eu)1-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'), keywords: Object.freeze(['pat-']), accept: plausibleSecret }),
  Object.freeze({ rule: 'contentful-token', regex: token('CFPAT-[A-Za-z0-9_-]{43}'), keywords: Object.freeze(['cfpat-']), accept: plausibleSecret }),
  Object.freeze({ rule: 'dropbox-token', regex: token('sl\\.[A-Za-z0-9_-]{130,}'), keywords: Object.freeze(['sl.']), accept: plausibleSecret }),
  Object.freeze({ rule: 'asana-token', regex: named('asana', '[12]/[0-9]{10,20}(?:/[0-9]{10,20})?:[a-f0-9]{32}'), keywords: Object.freeze(['asana']), accept: plausibleSecret }),
  /* Contextual, like Datadog: thirty-two hex characters beside the name. */
  Object.freeze({
    rule: 'algolia-admin-key',
    regex: /(?<=algolia_?(?:admin_?|write_?)?(?:api_?)?key["']?\s{0,4}[:=]\s{0,4}["']?)[a-f0-9]{32}(?![A-Za-z0-9])/i,
    keywords: Object.freeze(['algolia']),
    accept: plausibleSecret
  }),

  /* ---- Keys and key files ---- */
  Object.freeze({ rule: 'age-secret-key', regex: token('AGE-SECRET-KEY-1[QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L]{58}'), keywords: Object.freeze(['age-secret-key-1']), accept: plausibleSecret }),
  /*
   * Headers rather than tokens, so no plausibility check: the header is the
   * same for every key and its entropy says nothing. The gate's own rule
   * covers RSA, EC, OpenSSH and PKCS#8; these are the formats it does not.
   */
  Object.freeze({ rule: 'pgp-private-key', regex: /-{5}BEGIN PGP PRIVATE KEY BLOCK-{5}/, keywords: Object.freeze(['begin pgp private key block']) }),
  Object.freeze({ rule: 'dsa-private-key', regex: /-{5}BEGIN DSA PRIVATE KEY-{5}/, keywords: Object.freeze(['begin dsa private key']) }),
  Object.freeze({ rule: 'encrypted-private-key', regex: /-{5}BEGIN ENCRYPTED PRIVATE KEY-{5}/, keywords: Object.freeze(['begin encrypted private key']) }),
  Object.freeze({ rule: 'putty-private-key', regex: /PuTTY-User-Key-File-[23]: [a-z0-9-]+/, keywords: Object.freeze(['putty-user-key-file-']) }),

  /* ---- Databases ---- */
  Object.freeze({
    rule: 'database-url-password',
    /*
     * The gate already reports a URL carrying a password of sixteen characters
     * or more, for HTTP and PostgreSQL. This covers the schemes it does not,
     * and PostgreSQL passwords shorter than its floor -- and stops exactly
     * there, so no connection string is ever reported under two rules.
     */
    regex: /(?<![A-Za-z0-9+.-])(?:(?:mongodb(?:\+srv)?|mysql|mariadb|rediss?|amqps?|mssql|sqlserver|clickhouse):\/\/[^\s:/@"'<>]{1,64}:[^\s@/"'<>]{6,128}|postgres(?:ql)?:\/\/[^\s:/@"'<>]{1,64}:[^\s@/"'<>]{6,15})@[^\s/"'<>:]+/,
    keywords: Object.freeze(['://']),
    accept: plausibleConnectionString
  })
]);

/*
 * Rules that match a file by its name, for files that are an exposure whatever
 * is in them and that a scan never reads because they are binary: a committed
 * keystore or password database. The identity of such a finding is the blob,
 * so the same file committed again is the same finding and a changed one is a
 * new one.
 */
const PATH_RULES = Object.freeze([
  Object.freeze({ rule: 'keystore-file', extensions: Object.freeze(['p12', 'pfx', 'jks', 'keystore', 'bks']) }),
  Object.freeze({ rule: 'password-database-file', extensions: Object.freeze(['kdbx', 'kdb']) })
]);

module.exports = Object.freeze({
  EXPOSURE_RULES,
  MIN_ENTROPY_BITS,
  PATH_RULES,
  plausibleConnectionString,
  plausibleSecret,
  shannonEntropy
});
