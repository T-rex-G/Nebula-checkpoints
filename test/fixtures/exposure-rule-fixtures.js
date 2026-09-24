'use strict';

/*
 * A positive fixture for every scan rule, shared by the rules test and the
 * verification test -- so a verifier is checked against the exact token
 * shape its rule reports.
 *
 * No fixture is written out as a literal. Each is assembled from pieces and a
 * deterministic generator, so this file never contains a string a secret
 * scanner -- this repository's own gate, or a provider's push protection --
 * would take for a real key.
 */

const crypto = require('crypto');

/* ---- A deterministic generator ----------------------------------------- */

const ALPHABETS = Object.freeze({
  hex: '0123456789abcdef',
  upperHex: '0123456789ABCDEF',
  b62: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
  lowerAlnum: 'abcdefghijklmnopqrstuvwxyz0123456789',
  upperAlnum: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  url: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-',
  b64: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',
  bech32: 'QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L',
  digits: '0123456789'
});

function random(seed, alphabet, length) {
  const characters = ALPHABETS[alphabet] || alphabet;
  let out = '';
  let counter = 0;
  while (out.length < length) {
    const bytes = crypto.createHash('sha256').update(`${seed}:${counter}`).digest();
    counter += 1;
    for (const byte of bytes) {
      if (out.length >= length) break;
      out += characters[byte % characters.length];
    }
  }
  return out;
}

/*
 * One fixture per rule: `secret` is what the rule must report and `line` is
 * the source text it sits in. Prefixes are split so no line of this file is a
 * token in its own right.
 */
const FIXTURES = Object.freeze({
  'aws-secret-access-key': () => {
    const secret = random('aws', 'b64', 40);
    return { secret, line: `aws_secret_access_key = "${secret}"` };
  },
  'google-api-key': () => ({ secret: `AI${'za'}${random('google', 'url', 35)}` }),
  'google-oauth-client-secret': () => ({ secret: `GOC${'SPX-'}${random('goauth', 'url', 28)}` }),
  'azure-storage-account-key': () => ({
    secret: `DefaultEndpointsProtocol=https;AccountName=acmestore01;Account${'Key='}${random('azure', 'b64', 86)}==`
  }),
  'digitalocean-token': () => ({ secret: `do${'p_v1_'}${random('do', 'hex', 64)}` }),
  'cloudflare-origin-ca-key': () => ({ secret: `v1${'.0-'}${random('cf1', 'hex', 24)}-${random('cf2', 'hex', 146)}` }),
  'hashicorp-vault-token': () => ({ secret: `hv${'s.'}${random('vault', 'url', 90)}` }),
  'terraform-cloud-token': () => ({ secret: `${random('tf1', 'b62', 14)}.atlas${'v1.'}${random('tf2', 'url', 67)}` }),
  'doppler-token': () => ({ secret: `dp${'.pt.'}${random('doppler', 'b62', 43)}` }),
  'pulumi-token': () => ({ secret: `pu${'l-'}${random('pulumi', 'hex', 40)}` }),
  'render-api-key': () => ({ secret: `rn${'d_'}${random('render', 'b62', 32)}` }),
  'neon-api-key': () => ({ secret: `na${'pi_'}${random('neon', 'lowerAlnum', 64)}` }),
  'flyio-token': () => ({ secret: `fo${'1_'}${random('fly', 'url', 43)}` }),
  'netlify-token': () => ({ secret: `nf${'p_'}${random('netlify', 'b62', 36)}` }),
  'planetscale-token': () => ({ secret: `pscale${'_tkn_'}${random('pscale', 'url', 43)}` }),
  'databricks-token': () => ({ secret: `da${'pi'}${random('databricks', 'hex', 32)}` }),
  'npm-token': () => ({ secret: `np${'m_'}${random('npm', 'b62', 36)}` }),
  'pypi-token': () => ({ secret: `py${'pi-AgEIcHlwaS5vcmc'}${random('pypi', 'url', 70)}` }),
  'docker-hub-token': () => ({ secret: `dckr${'_pat_'}${random('docker', 'url', 27)}` }),
  'circleci-token': () => ({ secret: `CCI${'PAT_'}${random('circle1', 'b62', 22)}_${random('circle2', 'hex', 40)}` }),
  'buildkite-token': () => ({ secret: `bk${'ua_'}${random('buildkite', 'hex', 40)}` }),
  'jfrog-token': () => ({ secret: `AK${'Cp'}${random('jfrog', 'b62', 69)}` }),
  'atlassian-api-token': () => ({ secret: `ATA${'TT3'}${random('atlassian', 'url', 186)}` }),
  'linear-api-key': () => ({ secret: `lin${'_api_'}${random('linear', 'b62', 40)}` }),
  'postman-api-key': () => ({ secret: `PM${'AK-'}${random('postman1', 'hex', 24)}-${random('postman2', 'hex', 34)}` }),
  'figma-token': () => ({ secret: `fi${'gd_'}${random('figma', 'url', 40)}` }),
  'sentry-token': () => ({ secret: `sntry${'u_'}${random('sentry', 'hex', 64)}` }),
  'grafana-token': () => ({ secret: `gl${'sa_'}${random('grafana1', 'b62', 32)}_${random('grafana2', 'hex', 8)}` }),
  'new-relic-key': () => ({ secret: `NR${'AK-'}${random('newrelic', 'upperAlnum', 27)}` }),
  'dynatrace-token': () => ({ secret: `dt0${'c01.'}${random('dyna1', 'upperAlnum', 24)}.${random('dyna2', 'upperAlnum', 64)}` }),
  'openai-api-key': () => ({ secret: `sk${'-proj-'}${random('openai1', 'url', 40)}T3Blbk${'FJ'}${random('openai2', 'url', 40)}` }),
  'anthropic-api-key': () => ({ secret: `sk${'-ant-api03-'}${random('anthropic', 'url', 93)}` }),
  'huggingface-token': () => ({ secret: `h${'f_'}${random('hf', 'b62', 34)}` }),
  'replicate-token': () => ({ secret: `r${'8_'}${random('replicate', 'b62', 37)}` }),
  'groq-api-key': () => ({ secret: `gs${'k_'}${random('groq', 'b62', 52)}` }),
  'perplexity-api-key': () => ({ secret: `ppl${'x-'}${random('pplx', 'b62', 48)}` }),
  'stripe-live-key': () => ({ secret: `sk${'_live_'}${random('stripe-live', 'b62', 99)}` }),
  'stripe-test-key': () => ({ secret: `sk${'_test_'}${random('stripe-test', 'b62', 99)}` }),
  'stripe-webhook-secret': () => ({ secret: `wh${'sec_'}${random('whsec', 'b62', 32)}` }),
  'square-token': () => ({ secret: `sq0${'atp-'}${random('square', 'url', 22)}` }),
  'shopify-token': () => ({ secret: `shp${'at_'}${random('shopify', 'hex', 32)}` }),
  'braintree-token': () => ({ secret: `access_token$${'production$'}${random('bt1', 'lowerAlnum', 16)}$${random('bt2', 'hex', 32)}` }),
  'flutterwave-secret-key': () => ({ secret: `FLWSE${'CK-'}${random('flw', 'hex', 32)}-X` }),
  'easypost-api-key': () => ({ secret: `EZ${'AK'}${random('easypost', 'hex', 54)}` }),
  'sendgrid-api-key': () => ({ secret: `S${'G.'}${random('sg1', 'url', 22)}.${random('sg2', 'url', 43)}` }),
  'mailgun-api-key': () => ({ secret: `ke${'y-'}${random('mailgun', 'hex', 32)}` }),
  'mailchimp-api-key': () => ({ secret: `${random('mailchimp', 'hex', 32)}-us${'14'}` }),
  'resend-api-key': () => ({ secret: `r${'e_'}${random('resend1', 'b62', 8)}_${random('resend2', 'b62', 24)}` }),
  'twilio-api-key': () => ({ secret: `S${'K'}${random('twilio', 'hex', 32)}` }),
  'slack-webhook-url': () => ({
    secret: `https://hooks.${'slack.com'}/services/T${random('slack1', 'upperAlnum', 10)}/B${random('slack2', 'upperAlnum', 10)}/${random('slack3', 'b62', 24)}`
  }),
  'discord-webhook-url': () => ({
    secret: `https://discord.com/api/web${'hooks'}/${random('discord1', 'digits', 18)}/${random('discord2', 'url', 68)}`
  }),
  'teams-webhook-url': () => ({
    secret: `https://acme.webhook.office.com/web${'hookb2'}/${random('teams1', 'hex', 32)}@${random('teams2', 'hex', 32)}/IncomingWebhook/${random('teams3', 'hex', 32)}`
  }),
  'telegram-bot-token': () => ({ secret: `${random('tg1', 'digits', 10)}:A${'A'}${random('tg2', 'url', 33)}` }),
  'firebase-cloud-messaging-key': () => ({ secret: `AA${'AA'}${random('fcm1', 'url', 7)}:${random('fcm2', 'url', 140)}` }),
  'twitter-bearer-token': () => ({ secret: `${'A'.repeat(21)}${random('twitter', 'b62', 80)}` }),
  'mapbox-secret-token': () => ({ secret: `s${'k.eyJ'}${random('mapbox1', 'url', 60)}.${random('mapbox2', 'url', 22)}` }),
  'notion-token': () => ({ secret: `nt${'n_'}${random('notion', 'b62', 46)}` }),
  'airtable-token': () => ({ secret: `pa${'t'}${random('airtable1', 'b62', 14)}.${random('airtable2', 'hex', 64)}` }),
  'hubspot-token': () => ({
    secret: `pat${'-na1-'}${random('hs1', 'hex', 8)}-${random('hs2', 'hex', 4)}-${random('hs3', 'hex', 4)}-${random('hs4', 'hex', 4)}-${random('hs5', 'hex', 12)}`
  }),
  'contentful-token': () => ({ secret: `CFP${'AT-'}${random('contentful', 'url', 43)}` }),
  'age-secret-key': () => ({ secret: `AGE-SECRET${'-KEY-1'}${random('age', 'bech32', 58)}` }),
  'pgp-private-key': () => ({ secret: `-----BEGIN PGP ${'PRIVATE KEY BLOCK'}-----` }),
  'dsa-private-key': () => ({ secret: `-----BEGIN DSA ${'PRIVATE KEY'}-----` }),
  'encrypted-private-key': () => ({ secret: `-----BEGIN ENCRYPTED ${'PRIVATE KEY'}-----` }),
  'putty-private-key': () => ({ secret: `PuTTY-User-Key${'-File-3'}: ssh-ed25519` }),
  'database-url-password': () => {
    /* The host ends the match: the database name is not part of the
       credential, so the same password to two databases is one finding. */
    const secret = `mongodb+srv://${'app'}:${random('db', 'b62', 20)}@cluster0.abcde.mongodb.net`;
    return { secret, line: `MONGO_URI="${secret}/prod?retryWrites=true"` };
  },
  'supabase-access-token': () => ({ secret: `sb${'p_'}${random('sbp', 'hex', 40)}` }),
  'azure-ad-client-secret': () => ({ secret: `${random('az1', 'b62', 3)}8Q${'~'}${random('az2', 'url', 34)}` }),
  'alibaba-access-key': () => ({ secret: `LT${'AI'}${random('ali', 'b62', 20)}` }),
  'heroku-api-key': () => ({ secret: `HR${'KU-'}${random('heroku', 'url', 60)}` }),
  'tailscale-key': () => ({ secret: `tskey${'-api-'}${random('ts1', 'b62', 16)}-${random('ts2', 'b62', 32)}` }),
  'onepassword-service-token': () => ({ secret: `op${'s_eyJ'}${random('op', 'url', 140)}` }),
  'datadog-api-key': () => {
    const secret = random('datadog', 'hex', 32);
    return { secret, line: `DD_API_KEY = "${secret}"` };
  },
  'bitbucket-app-password': () => ({ secret: `AT${'BB'}${random('bb', 'b62', 32)}` }),
  'sonarqube-token': () => ({ secret: `sq${'p_'}${random('sonar', 'hex', 40)}` }),
  'sourcegraph-token': () => ({ secret: `sg${'p_'}${random('sg', 'hex', 40)}` }),
  'octopus-deploy-key': () => {
    const secret = `AP${'I-'}${random('octopus', 'upperAlnum', 30)}`;
    return { secret, line: `OCTOPUS_API_KEY=${secret}` };
  },
  'prefect-api-key': () => ({ secret: `pn${'u_'}${random('prefect', 'b62', 36)}` }),
  'launchdarkly-key': () => {
    const secret = `ap${'i-'}${random('ld1', 'hex', 8)}-${random('ld2', 'hex', 4)}-${random('ld3', 'hex', 4)}-${random('ld4', 'hex', 4)}-${random('ld5', 'hex', 12)}`;
    return { secret, line: `LAUNCHDARKLY_ACCESS_TOKEN="${secret}"` };
  },
  'rubygems-token': () => ({ secret: `ruby${'gems_'}${random('rubygems', 'hex', 48)}` }),
  'nuget-api-key': () => ({ secret: `oy${'2'}${random('nuget', 'lowerAlnum', 43)}` }),
  'cratesio-token': () => ({ secret: `ci${'o'}${random('crates', 'b62', 32)}` }),
  'clojars-token': () => ({ secret: `CLOJARS${'_'}${random('clojars', 'lowerAlnum', 60)}` }),
  'docker-config-auth': () => {
    const secret = Buffer.from(`deploy:${random('docker-auth', 'b62', 20)}`).toString('base64');
    return { secret, line: `{"auths":{"registry.internal":{"auth":"${secret}"}}}` };
  },
  'npmrc-auth-token': () => {
    const secret = `${random('npmrc1', 'hex', 8)}-${random('npmrc2', 'hex', 4)}-${random('npmrc3', 'hex', 4)}-${random('npmrc4', 'hex', 4)}-${random('npmrc5', 'hex', 12)}`;
    return { secret, line: `//registry.npmjs.org/:_auth${'Token'}=${secret}` };
  },
  'xai-api-key': () => ({ secret: `xa${'i-'}${random('xai', 'b62', 80)}` }),
  'openrouter-api-key': () => ({ secret: `sk-${'or-v1-'}${random('openrouter', 'hex', 64)}` }),
  'pinecone-api-key': () => ({ secret: `pc${'sk_'}${random('pc1', 'b62', 5)}_${random('pc2', 'b62', 60)}` }),
  'langsmith-api-key': () => ({ secret: `ls${'v2_pt_'}${random('ls1', 'hex', 32)}_${random('ls2', 'hex', 10)}` }),
  'shippo-token': () => ({ secret: `ship${'po_live_'}${random('shippo', 'hex', 40)}` }),
  'plaid-access-token': () => ({
    secret: `access${'-production-'}${random('pl1', 'hex', 8)}-${random('pl2', 'hex', 4)}-${random('pl3', 'hex', 4)}-${random('pl4', 'hex', 4)}-${random('pl5', 'hex', 12)}`
  }),
  'woocommerce-secret': () => ({ secret: `c${'s_'}${random('woo', 'hex', 40)}` }),
  'slack-app-token': () => ({ secret: `xa${'pp-1-'}A${random('sa1', 'upperAlnum', 10)}-${random('sa2', 'digits', 13)}-${random('sa3', 'hex', 64)}` }),
  'discord-bot-token': () => {
    const secret = `M${random('dc1', 'b62', 23)}.${random('dc2', 'url', 6)}.${random('dc3', 'url', 30)}`;
    return { secret, line: `DISCORD_BOT_TOKEN="${secret}"` };
  },
  'dropbox-token': () => ({ secret: `s${'l.'}${random('dropbox', 'url', 140)}` }),
  'asana-token': () => {
    const secret = `2/${random('as1', 'digits', 16)}/${random('as2', 'digits', 16)}:${random('as3', 'hex', 32)}`;
    return { secret, line: `ASANA_TOKEN="${secret}"` };
  },
  'algolia-admin-key': () => {
    const secret = random('algolia', 'hex', 32);
    return { secret, line: `ALGOLIA_ADMIN_KEY="${secret}"` };
  }
});

/* A Supabase key is a JWT, built rather than written. */
function jwt(claims) {
  const part = value => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  return `${part({ alg: 'HS256', typ: 'JWT' })}.${part(claims)}.${random(JSON.stringify(claims), 'url', 43)}`;
}
const SUPABASE_FIXTURES = Object.freeze({
  'supabase-anon-key': () => ({ secret: jwt({ iss: 'supabase', ref: 'a'.repeat(20), role: 'anon', iat: 1, exp: 2 }) }),
  'supabase-service-role-key': () => ({ secret: jwt({ iss: 'supabase', ref: 'a'.repeat(20), role: 'service_role', iat: 1, exp: 2 }) })
});

const ALL_FIXTURES = Object.freeze({ ...SUPABASE_FIXTURES, ...FIXTURES });


module.exports = Object.freeze({ ALPHABETS, ALL_FIXTURES, FIXTURES, SUPABASE_FIXTURES, jwt, random });
