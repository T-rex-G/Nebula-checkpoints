import type { Severity } from '../../../../../../packages/contracts/src/findings.ts';

/*
 * What each detection rule's credential means to the reader who finds it,
 * and what to do about it: one entry per rule, in the reader's words.
 *
 * The entries are part of the narration that exposure-narration.ts versions
 * (NARRATION_VERSION): a sentence changed here is a narration changed, and the
 * version says so.
 */

/* Severity is about the credential class, not about liveness. Whether a
   particular one still works is the verifier's answer and is reported
   separately; a private key in a repository is serious whether or not anybody
   has tried it. */
/* What a rule's credential means and what to do about it. */
export interface RuleNarration {
  readonly severity: Severity;
  readonly consequence: string;
  readonly action: string;
}

function narration(entry: RuleNarration): RuleNarration {
  return Object.freeze(entry);
}

export const RULE_NARRATION: Readonly<Record<string, RuleNarration>> = Object.freeze({
  'private-key': narration({
    severity: 'critical',
    consequence: 'A private key is in the repository. Anyone who can read this file can impersonate whatever the key identifies -- a server, a deploy user, a signing identity -- and no password protects it once it is out.',
    action: 'Treat the key as compromised: issue a new one, replace it everywhere it is trusted, and revoke the old one. Removing the file is not enough, because the key is still in the repository history.'
  }),
  'github-token': narration({
    severity: 'critical',
    consequence: 'A GitHub access token is in the repository. Anyone who has it can act as the account that issued it -- read private repositories, push commits, and in some cases change who else has access.',
    action: 'Revoke the token in GitHub developer settings now; a new one can be issued afterwards. Revoking is what ends the exposure, because the token remains in the repository history.'
  }),
  'gitlab-token': narration({
    severity: 'critical',
    consequence: 'A GitLab access token is in the repository. Depending on its scopes, anyone who has it can read private projects, push code, or run pipelines as the account that issued it.',
    action: 'Revoke the token in GitLab access-token settings now. Revoking is what ends the exposure; deleting the file does not, because the token remains in the repository history.'
  }),
  'aws-access-key': narration({
    severity: 'serious',
    consequence: 'An AWS access key identifier is in the repository. On its own it is a name rather than a working credential -- signing also needs the secret access key -- but it tells anyone who finds it which account to attack, and the secret is often committed nearby or later.',
    action: 'Deactivate and delete the key pair in IAM rather than looking for the secret half, and check CloudTrail for use of that key identifier. Rotating is cheap; establishing that the secret was never committed is not.'
  }),
  'slack-token': narration({
    severity: 'critical',
    consequence: 'A Slack token is in the repository. Anyone who has it can read and post in whatever the workspace granted it, which usually includes channels containing more credentials.',
    action: 'Revoke the token in the Slack app configuration now, then review the channels it could read. Revoking ends the exposure; the token stays in the repository history.'
  }),
  'authenticated-url': narration({
    severity: 'critical',
    consequence: 'A connection string with an embedded password is in the repository. Anyone who can read it can connect to that service directly as that user, and a database reached this way is usually reachable from anywhere.',
    action: 'Change the password on that account now and check whether the host accepts connections from the internet. A password in a URL also ends up in logs and shell history, so assume it is more widely known than this one file.'
  }),
  'contextual-provider-secret': narration({
    severity: 'serious',
    consequence: 'A configuration value that names a provider secret has a literal value committed beside it. What it unlocks depends on which secret it is, and the name usually says: a session secret forges sessions, a webhook secret forges webhook deliveries, an OAuth secret impersonates the application.',
    action: 'Rotate that specific secret and move the value into the deployment environment rather than the repository. Check what the name implies before deciding this is minor.'
  }),
  /*
   * The one entry here that does not say "this is a leak", because it is not
   * one. An anonymous key is published in client bundles by design, and a
   * narration that called it critical would make every project in every
   * repository a critical finding -- which is how a reader learns to scroll
   * past a screen of them.
   *
   * What it is instead is a question this server cannot answer by looking:
   * what the anonymous role can read is decided by policies that live in
   * somebody's project, not in their repository. So the consequence says the
   * key is not the problem, and the action is to ask.
   */
  'supabase-anon-key': narration({
    severity: 'warning',
    consequence: 'A Supabase anonymous key is in the repository. That is normal -- it is meant to be public and it is in the browser bundle of every app that uses one. What it can actually read is decided by the row-level security policies on the project, and those are not visible from here.',
    action: 'Do not rotate it; that fixes nothing and breaks the app. Check what the anonymous role can read instead, which is what the readability check below asks the project directly.'
  }),
  /*
   * The same shape, the opposite finding. This one needs no probe to be
   * serious: a service-role key bypasses row-level security entirely, so
   * asking whether it can read a table would establish nothing except that
   * this server had used an administrator credential to find out.
   */
  'supabase-service-role-key': narration({
    severity: 'critical',
    consequence: 'A Supabase service-role key is in the repository. It bypasses row-level security completely, so anyone who has it can read and write every table in the project regardless of what the policies say. It looks almost exactly like the anonymous key and is nothing like it.',
    action: 'Rotate the service-role key in the project API settings now, and move it into the deployment environment rather than the repository. Rotating is what ends the exposure; the key stays in the repository history.'
  }),
  /* ---- The scan's own catalogue ---------------------------------------- */
  'aws-secret-access-key': narration({
    severity: 'critical',
    consequence: 'An AWS secret access key is in the repository, beside the name it is assigned to. With its access key id -- usually committed nearby -- anyone can act as that IAM identity: read buckets, start machines, and run up a bill in minutes.',
    action: 'Deactivate the key pair in IAM now, create a new one, and check CloudTrail for activity from the old key. Deleting the file does not help; the key stays in the repository history.'
  }),
  'google-api-key': narration({
    severity: 'serious',
    consequence: 'A Google API key is in the repository. Keys for browser use (Maps, Firebase) are often meant to be public, but an unrestricted key lets anyone call every Google API it is enabled for on your billing account.',
    action: 'In Google Cloud credentials, restrict the key to the APIs and the referrers or apps that need it; if it is unrestricted or server-side, regenerate it.'
  }),
  'google-oauth-client-secret': narration({
    severity: 'critical',
    consequence: 'A Google OAuth client secret is in the repository. With it, anyone can impersonate your application in the Google sign-in flow and exchange codes for users\' tokens.',
    action: 'Reset the client secret in the Google Cloud console credentials page and update every deployment that uses it.'
  }),
  'azure-storage-account-key': narration({
    severity: 'critical',
    consequence: 'An Azure storage connection string with its account key is in the repository. The account key is full control of the storage account: every blob, table and queue can be read, changed or deleted.',
    action: 'Rotate the account key in the Azure portal (Access keys), then switch applications to the rotated key or, better, to managed identity or SAS tokens.'
  }),
  'digitalocean-token': narration({
    severity: 'critical',
    consequence: 'A DigitalOcean token is in the repository. Depending on its scope, anyone who has it can create, read or destroy droplets, databases and DNS for the account.',
    action: 'Revoke the token under API in the DigitalOcean control panel now, and review recent account activity.'
  }),
  'cloudflare-origin-ca-key': narration({
    severity: 'critical',
    consequence: 'A Cloudflare Origin CA key is in the repository. It can issue and revoke origin certificates for the account\'s zones, which is enough to impersonate your origin servers to Cloudflare.',
    action: 'Regenerate the Origin CA key in your Cloudflare profile under API Tokens, and review recently issued origin certificates.'
  }),
  'hashicorp-vault-token': narration({
    severity: 'critical',
    consequence: 'A HashiCorp Vault token is in the repository. A Vault token is a key to other secrets: whatever its policies allow, anyone holding it can read -- often every credential the application uses.',
    action: 'Revoke the token with `vault token revoke` (or its accessor) now, and rotate the secrets its policies could read.'
  }),
  'terraform-cloud-token': narration({
    severity: 'critical',
    consequence: 'A Terraform Cloud token is in the repository. It can read state -- which routinely contains plaintext secrets -- and queue runs that change real infrastructure.',
    action: 'Delete the token in Terraform Cloud user or team settings, and treat secrets stored in the workspaces\' state as exposed.'
  }),
  'doppler-token': narration({
    severity: 'critical',
    consequence: 'A Doppler token is in the repository. Doppler exists to hold secrets, so this token is access to every secret its project and config can see.',
    action: 'Revoke the token in the Doppler dashboard now and rotate the secrets it could read.'
  }),
  'pulumi-token': narration({
    severity: 'critical',
    consequence: 'A Pulumi access token is in the repository. It can read stack state, including encrypted and plaintext secrets, and run updates against real infrastructure.',
    action: 'Delete the token under Access Tokens in the Pulumi Cloud console, and review recent stack updates.'
  }),
  'render-api-key': narration({
    severity: 'critical',
    consequence: 'A Render API key is in the repository. It can manage every service on the account: read environment variables, trigger deploys, change settings and delete services.',
    action: 'Revoke the key under Account Settings, API Keys in the Render dashboard, then review the environment variables it could read.'
  }),
  'neon-api-key': narration({
    severity: 'critical',
    consequence: 'A Neon API key is in the repository. It can manage projects, branches and roles -- including creating credentials that read every database on the account.',
    action: 'Revoke the key under Account settings, API keys in the Neon console, and reset the passwords of roles it could have changed.'
  }),
  'flyio-token': narration({
    severity: 'critical',
    consequence: 'A Fly.io token is in the repository. It can deploy to, read secrets from and destroy the apps its organization owns.',
    action: 'Revoke it with `fly tokens revoke` or in the dashboard, and rotate the app secrets it could read.'
  }),
  'netlify-token': narration({
    severity: 'critical',
    consequence: 'A Netlify personal access token is in the repository. It acts as your user: it can change sites, read build environment variables and deploy arbitrary code to your domains.',
    action: 'Revoke the token under User settings, Applications in Netlify, and review recent deploys.'
  }),
  'planetscale-token': narration({
    severity: 'critical',
    consequence: 'A PlanetScale token or password is in the repository. Depending on its kind, it connects to a database branch directly or manages the organization\'s databases.',
    action: 'Delete the password or service token in the PlanetScale dashboard and create a new one kept in the deployment environment.'
  }),
  'databricks-token': narration({
    severity: 'critical',
    consequence: 'A Databricks personal access token is in the repository. It acts as that user in the workspace: notebooks, jobs, clusters and the data they can reach.',
    action: 'Revoke the token under User Settings, Developer, Access tokens, and review recent job and cluster activity.'
  }),
  'npm-token': narration({
    severity: 'critical',
    consequence: 'An npm access token is in the repository. With publish rights, anyone who has it can release a new version of your packages -- and everyone who installs them runs what they published.',
    action: 'Revoke the token on npmjs.com under Access Tokens now, and check the recent versions of every package it could publish.'
  }),
  'pypi-token': narration({
    severity: 'critical',
    consequence: 'A PyPI API token is in the repository. Anyone who has it can upload new releases of the projects it is scoped to, which every downstream install then runs.',
    action: 'Remove the token under Account settings, API tokens on PyPI, and review the release history of the affected projects.'
  }),
  'docker-hub-token': narration({
    severity: 'critical',
    consequence: 'A Docker Hub personal access token is in the repository. It can push images to your repositories, so anyone who has it can replace an image your deployments pull.',
    action: 'Delete the token under Account settings, Security on Docker Hub, and verify the digests of recently pushed images.'
  }),
  'circleci-token': narration({
    severity: 'critical',
    consequence: 'A CircleCI personal API token is in the repository. It can read project environment variables and trigger pipelines, which is usually access to every deployment secret.',
    action: 'Delete the token under User Settings, Personal API Tokens, and rotate the project environment variables it could read.'
  }),
  'buildkite-token': narration({
    severity: 'critical',
    consequence: 'A Buildkite API token is in the repository. Depending on its scopes it can read pipelines and builds or trigger new ones with your agents\' access.',
    action: 'Revoke the token under Personal Settings, API Access Tokens in Buildkite.'
  }),
  'jfrog-token': narration({
    severity: 'critical',
    consequence: 'A JFrog Artifactory API key is in the repository. It can read and publish artifacts, so anyone who has it can replace a package your builds download.',
    action: 'Revoke the key in the JFrog Platform user profile and review recent uploads.'
  }),
  'atlassian-api-token': narration({
    severity: 'critical',
    consequence: 'An Atlassian API token is in the repository. Together with the account email, it acts as that user in Jira and Confluence: every issue and page they can see.',
    action: 'Revoke the token at id.atlassian.com under Security, API tokens.'
  }),
  'linear-api-key': narration({
    severity: 'serious',
    consequence: 'A Linear API key is in the repository. It acts as your user: it can read and change every issue, project and comment you can.',
    action: 'Revoke the key in Linear under Settings, Security & access, Personal API keys.'
  }),
  'postman-api-key': narration({
    severity: 'serious',
    consequence: 'A Postman API key is in the repository. It reads your collections and environments -- which frequently store other API keys in plain text.',
    action: 'Revoke the key in Postman under Settings, API keys, and check environments for secrets that should be rotated too.'
  }),
  'figma-token': narration({
    severity: 'serious',
    consequence: 'A Figma personal access token is in the repository. It reads every file the user can open, including unreleased designs.',
    action: 'Revoke the token in Figma under Settings, Security, Personal access tokens.'
  }),
  'sentry-token': narration({
    severity: 'serious',
    consequence: 'A Sentry auth token is in the repository. Depending on scope, it reads error events -- which often contain request data and user details -- and can change project settings.',
    action: 'Revoke the token in Sentry under User or Organization settings, Auth Tokens.'
  }),
  'grafana-token': narration({
    severity: 'serious',
    consequence: 'A Grafana service account or Cloud token is in the repository. It can read dashboards and data sources, and with editor rights change alerting.',
    action: 'Delete the token in Grafana under Administration, Service accounts, or in the Grafana Cloud portal.'
  }),
  'new-relic-key': narration({
    severity: 'serious',
    consequence: 'A New Relic user API key is in the repository. It queries all telemetry the user can see through NerdGraph and can change account configuration.',
    action: 'Delete the key in New Relic under API keys, and create a new one kept out of the repository.'
  }),
  'dynatrace-token': narration({
    severity: 'serious',
    consequence: 'A Dynatrace API token is in the repository. Its scopes can include reading monitoring data, logs and configuration for the whole environment.',
    action: 'Revoke the token in Dynatrace under Access tokens.'
  }),
  'openai-api-key': narration({
    severity: 'critical',
    consequence: 'An OpenAI API key is in the repository. Anyone who has it can make requests billed to your organization, and leaked keys are found and abused by automated scanners within minutes.',
    action: 'Revoke the key on the OpenAI platform under API keys now, and check usage for requests you did not make.'
  }),
  'anthropic-api-key': narration({
    severity: 'critical',
    consequence: 'An Anthropic API key is in the repository. Anyone who has it can send requests billed to your workspace; an admin key can also manage the organization\'s other keys.',
    action: 'Delete the key in the Anthropic Console under API keys now, and review usage for the period it was exposed.'
  }),
  'huggingface-token': narration({
    severity: 'serious',
    consequence: 'A Hugging Face access token is in the repository. It reads your private models and datasets, and a write token can replace them.',
    action: 'Invalidate the token under Settings, Access Tokens on Hugging Face.'
  }),
  'replicate-token': narration({
    severity: 'serious',
    consequence: 'A Replicate API token is in the repository. Anyone who has it can run models billed to your account.',
    action: 'Revoke the token in Replicate account settings under API tokens.'
  }),
  'groq-api-key': narration({
    severity: 'serious',
    consequence: 'A Groq API key is in the repository. Anyone who has it can send requests billed to your account.',
    action: 'Delete the key in the Groq console under API Keys.'
  }),
  'perplexity-api-key': narration({
    severity: 'serious',
    consequence: 'A Perplexity API key is in the repository. Anyone who has it can make requests billed to your account.',
    action: 'Revoke the key in Perplexity API settings.'
  }),
  'stripe-live-key': narration({
    severity: 'critical',
    consequence: 'A live secret key in Stripe\'s format is in the repository (a few services, such as Clerk, copy the same prefix). A Stripe live key moves real money: refunds, payouts and customer data are all within reach.',
    action: 'Roll the key in the Stripe dashboard under Developers, API keys now -- or in the issuing service if it is not Stripe -- and review recent payouts and refunds.'
  }),
  'stripe-test-key': narration({
    severity: 'warning',
    consequence: 'A test-mode secret key in Stripe\'s format is in the repository. Test mode moves no real money, but it exposes test data and webhooks, and a repository with a test key often has the live one nearby.',
    action: 'Roll the test key in the Stripe dashboard and move both keys into the deployment environment.'
  }),
  'stripe-webhook-secret': narration({
    severity: 'serious',
    consequence: 'A Stripe webhook signing secret is in the repository. With it, anyone can forge webhook events your server will accept as genuine -- a payment that never happened, a subscription that was never paid.',
    action: 'Roll the endpoint\'s signing secret in the Stripe dashboard under Developers, Webhooks.'
  }),
  'square-token': narration({
    severity: 'critical',
    consequence: 'A Square access token or application secret is in the repository. It can take payments, issue refunds and read customer data for the seller account.',
    action: 'Revoke the token or replace the secret in the Square Developer dashboard.'
  }),
  'shopify-token': narration({
    severity: 'critical',
    consequence: 'A Shopify access token or shared secret is in the repository. An admin token reads and changes orders, customers and products for the store.',
    action: 'Uninstall and reinstall the custom app, or rotate the secret in the Shopify admin under Apps, Develop apps.'
  }),
  'braintree-token': narration({
    severity: 'critical',
    consequence: 'A Braintree production access token is in the repository. It can process transactions and refunds for the merchant account.',
    action: 'Revoke the token in the Braintree control panel and review recent transactions.'
  }),
  'flutterwave-secret-key': narration({
    severity: 'critical',
    consequence: 'A Flutterwave secret key is in the repository. It can initiate transfers and read transaction data for the account.',
    action: 'Regenerate the API keys in the Flutterwave dashboard under Settings, API.'
  }),
  'easypost-api-key': narration({
    severity: 'serious',
    consequence: 'An EasyPost API key is in the repository. It buys shipping labels billed to your account and reads shipment addresses.',
    action: 'Delete the key in the EasyPost dashboard under API Keys.'
  }),
  'sendgrid-api-key': narration({
    severity: 'critical',
    consequence: 'A SendGrid API key is in the repository. Anyone who has it can send email as your verified domains -- the phishing that passes every check because it really is from you.',
    action: 'Delete the key in SendGrid under Settings, API Keys, and review the activity feed for mail you did not send.'
  }),
  'mailgun-api-key': narration({
    severity: 'serious',
    consequence: 'A Mailgun API key is in the repository. It sends mail from your domains and reads the message logs.',
    action: 'Rotate the key in the Mailgun control panel under API Security.'
  }),
  'mailchimp-api-key': narration({
    severity: 'serious',
    consequence: 'A Mailchimp API key is in the repository. It reads and exports your audience -- every subscriber\'s email address -- and can send campaigns.',
    action: 'Delete the key in Mailchimp under Account, Extras, API keys.'
  }),
  'resend-api-key': narration({
    severity: 'serious',
    consequence: 'A Resend API key is in the repository. With sending access, anyone who has it can send email from your verified domains.',
    action: 'Delete the key in the Resend dashboard under API Keys.'
  }),
  'twilio-api-key': narration({
    severity: 'serious',
    consequence: 'A Twilio API key identifier is in the repository. Its secret is usually committed alongside it, and together they send messages and place calls billed to the account.',
    action: 'Delete the API key in the Twilio console under API keys & tokens.'
  }),
  'slack-webhook-url': narration({
    severity: 'serious',
    consequence: 'A Slack incoming-webhook URL is in the repository. The URL is the credential: anyone who has it can post messages into that channel, looking like your integration.',
    action: 'Regenerate the webhook in the Slack app configuration, which invalidates this URL.'
  }),
  'discord-webhook-url': narration({
    severity: 'serious',
    consequence: 'A Discord webhook URL is in the repository. The URL is the credential: anyone who has it can post into that channel, or delete the webhook.',
    action: 'Delete the webhook in the channel\'s Integrations settings and create a new one.'
  }),
  'teams-webhook-url': narration({
    severity: 'serious',
    consequence: 'A Microsoft Teams incoming-webhook URL is in the repository. The URL is the credential: anyone who has it can post messages into that channel.',
    action: 'Remove the connector or workflow from the channel and create a new one.'
  }),
  'telegram-bot-token': narration({
    severity: 'critical',
    consequence: 'A Telegram bot token is in the repository. It is complete control of the bot: reading every message sent to it and sending as it to every chat it is in.',
    action: 'Revoke the token with /revoke in a chat with @BotFather, which issues a new one.'
  }),
  'firebase-cloud-messaging-key': narration({
    severity: 'critical',
    consequence: 'A Firebase Cloud Messaging server key is in the repository. Anyone who has it can push notifications to every installation of your app.',
    action: 'Delete the legacy server key in the Firebase console under Cloud Messaging and move to the HTTP v1 API with service-account credentials.'
  }),
  'twitter-bearer-token': narration({
    severity: 'serious',
    consequence: 'An X (Twitter) API bearer token is in the repository. It makes API calls against your app\'s quota and whatever access the app has been granted.',
    action: 'Regenerate the bearer token in the X developer portal under the app\'s Keys and tokens.'
  }),
  'mapbox-secret-token': narration({
    severity: 'serious',
    consequence: 'A Mapbox secret token is in the repository. Unlike the public `pk.` tokens, a secret token can have scopes that change styles, datasets and uploads on the account.',
    action: 'Delete the token on the Mapbox account Tokens page.'
  }),
  'notion-token': narration({
    severity: 'serious',
    consequence: 'A Notion integration token is in the repository. It reads and edits every page and database shared with the integration.',
    action: 'Refresh the secret in Notion under Settings, Connections, the integration\'s page.'
  }),
  'airtable-token': narration({
    severity: 'serious',
    consequence: 'An Airtable personal access token is in the repository. It reads and writes the bases its scopes allow.',
    action: 'Delete the token on the Airtable developer hub.'
  }),
  'hubspot-token': narration({
    severity: 'serious',
    consequence: 'A HubSpot private-app token is in the repository. Its scopes typically include contacts and deals -- your customer records.',
    action: 'Rotate the token in HubSpot under Settings, Integrations, Private Apps.'
  }),
  'contentful-token': narration({
    severity: 'serious',
    consequence: 'A Contentful personal access token is in the repository. It uses the Content Management API as you: create, change and publish content in every space you can.',
    action: 'Revoke the token in Contentful under Settings, CMA tokens.'
  }),
  'age-secret-key': narration({
    severity: 'critical',
    consequence: 'An age private key is in the repository. Every file encrypted to its public key -- often the repository\'s own encrypted secrets -- can now be decrypted by anyone who has it.',
    action: 'Generate a new key pair, re-encrypt what the old key protected, and treat everything it could decrypt as exposed.'
  }),
  'pgp-private-key': narration({
    severity: 'critical',
    consequence: 'A PGP private key block is in the repository. Unless it is protected by a strong passphrase, anyone who has it can sign as you and decrypt what was encrypted to you.',
    action: 'Revoke the key with a revocation certificate, publish the revocation, and issue a new key.'
  }),
  'dsa-private-key': narration({
    severity: 'critical',
    consequence: 'A DSA private key is in the repository. Anyone who can read this file can authenticate as whatever trusts the key, with no password protecting it.',
    action: 'Remove the key from every authorized_keys and trust store, and replace it with a modern key type such as Ed25519.'
  }),
  'encrypted-private-key': narration({
    severity: 'serious',
    consequence: 'A passphrase-protected private key is in the repository. It is not immediately usable, but it can be attacked offline for as long as anyone likes, and passphrases are often weak or committed nearby.',
    action: 'Treat the key as compromised on a slower clock: replace it and remove the old one from wherever it is trusted.'
  }),
  'putty-private-key': narration({
    severity: 'critical',
    consequence: 'A PuTTY private key file is in the repository. Unless it is encrypted, anyone who has it can log in to every server that trusts the key.',
    action: 'Remove the public key from every server\'s authorized_keys and generate a new key pair.'
  }),
  'database-url-password': narration({
    severity: 'serious',
    consequence: 'A database connection string with its password is in the repository. Anyone who can reach the host can connect as that user -- and managed databases are commonly reachable from the internet.',
    action: 'Change that user\'s password, check whether the host accepts connections from anywhere, and move the connection string into the deployment environment.'
  }),
  'supabase-access-token': narration({
    severity: 'critical',
    consequence: 'A Supabase personal access token is in the repository. It uses the Management API as you: anyone who has it can list every project your account can reach, read their service-role keys, change their settings and delete them.',
    action: 'Revoke it in the Supabase dashboard under Account, Access Tokens now, then rotate the service-role keys of every project it could reach.'
  }),
  'azure-ad-client-secret': narration({
    severity: 'critical',
    consequence: 'A Microsoft Entra ID application secret is in the repository. With the application\'s id and tenant -- usually in the same file -- anyone can sign in as that application and use every permission it was granted.',
    action: 'Delete the secret under the app registration\'s Certificates & secrets now, create a new one, and review the application\'s sign-in logs.'
  }),
  'alibaba-access-key': narration({
    severity: 'serious',
    consequence: 'An Alibaba Cloud AccessKey ID is in the repository. It is half of a pair: the secret that goes with it is usually a line or two away, and together they act as the account or RAM user that owns them.',
    action: 'Disable the AccessKey pair in the RAM console, check for its secret nearby, and create a new pair kept in the deployment environment.'
  }),
  'heroku-api-key': narration({
    severity: 'critical',
    consequence: 'A Heroku API key is in the repository. Anyone who has it can manage your apps as you: read their config vars -- which hold their own secrets -- deploy code and delete them.',
    action: 'Regenerate the API key in Heroku account settings now, and rotate the config vars of any app the account can reach.'
  }),
  'tailscale-key': narration({
    severity: 'critical',
    consequence: 'A Tailscale key is in the repository. An auth key adds new devices to your tailnet and an API key manages it, so anyone who has one can join your private network or change who else can.',
    action: 'Revoke the key in the Tailscale admin console under Settings, Keys now, and remove any device you do not recognise.'
  }),
  'onepassword-service-token': narration({
    severity: 'critical',
    consequence: 'A 1Password service account token is in the repository. Anyone who has it can read every item in every vault the service account was granted -- which is to say, other secrets.',
    action: 'Delete or rotate the service account token in 1Password now, and rotate the items in the vaults it could read.'
  }),
  'datadog-api-key': narration({
    severity: 'serious',
    consequence: 'A Datadog key is in the repository. An API key submits data to your account and an application key reads it -- dashboards, logs and monitors included.',
    action: 'Revoke the key under Organization Settings in Datadog, create a new one, and keep it in the deployment environment.'
  }),
  'bitbucket-app-password': narration({
    severity: 'serious',
    consequence: 'A Bitbucket app password is in the repository. With the username it belongs to, anyone can use Bitbucket as that user with the permissions the password was given, which usually include reading and writing repositories.',
    action: 'Revoke the app password in Bitbucket personal settings now, and review recent activity on the repositories it could reach.'
  }),
  'sonarqube-token': narration({
    severity: 'serious',
    consequence: 'A SonarQube or SonarCloud token is in the repository. Anyone who has it can read your projects\' analysis -- which includes source excerpts and the vulnerabilities found in them -- and, for a global token, administer the server.',
    action: 'Revoke the token under My Account, Security, and create a new one kept in your CI\'s secrets.'
  }),
  'sourcegraph-token': narration({
    severity: 'serious',
    consequence: 'A Sourcegraph access token is in the repository. Anyone who has it can search every repository its user can see, which on a company instance is often all of them.',
    action: 'Delete the token in Sourcegraph user settings, Access tokens, now.'
  }),
  'octopus-deploy-key': narration({
    severity: 'serious',
    consequence: 'An Octopus Deploy API key is in the repository. Anyone who has it can act as its user: read project variables, which hold deployment secrets, and start deployments.',
    action: 'Revoke the key in the Octopus user\'s profile under API keys, and review recent deployments and variable changes.'
  }),
  'prefect-api-key': narration({
    severity: 'serious',
    consequence: 'A Prefect Cloud API key is in the repository. Anyone who has it can read and run your workflows, and read the blocks that hold their credentials.',
    action: 'Delete the key in Prefect Cloud under API keys and create a new one.'
  }),
  'launchdarkly-key': narration({
    severity: 'serious',
    consequence: 'A LaunchDarkly key is in the repository. An access token manages feature flags -- anyone can switch features on or off in production -- and a server-side SDK key reads every flag and segment.',
    action: 'Reset the SDK key or delete the access token in LaunchDarkly account settings now.'
  }),
  'rubygems-token': narration({
    severity: 'critical',
    consequence: 'A RubyGems API key is in the repository. Anyone who has it can publish new versions of every gem you own, and everyone who installs them runs that code.',
    action: 'Revoke the key on rubygems.org under Settings, API keys now, and check your gems for versions you did not publish.'
  }),
  'nuget-api-key': narration({
    severity: 'critical',
    consequence: 'A NuGet API key is in the repository. Anyone who has it can push packages under your account, and everyone who installs them runs that code.',
    action: 'Delete the key on nuget.org under API keys now, and check your packages for versions you did not push.'
  }),
  'cratesio-token': narration({
    severity: 'critical',
    consequence: 'A crates.io API token is in the repository. Anyone who has it can publish new versions of your crates, and everyone who depends on them builds that code.',
    action: 'Revoke the token on crates.io under Account Settings, API Tokens now, and check your crates for versions you did not publish.'
  }),
  'clojars-token': narration({
    severity: 'critical',
    consequence: 'A Clojars deploy token is in the repository. Anyone who has it can deploy new versions of your libraries, and everyone who depends on them runs that code.',
    action: 'Disable the token on clojars.org under Deploy Tokens now, and check your groups for versions you did not deploy.'
  }),
  'docker-config-auth': narration({
    severity: 'critical',
    consequence: 'A container registry credential is in the repository, as the base64 `auth` field of a Docker config -- which is a username and password, only encoded. Anyone who has it can pull your private images and push over them.',
    action: 'Change the password or revoke the token for that registry account now, and check the registry for images you did not push.'
  }),
  'npmrc-auth-token': narration({
    severity: 'critical',
    consequence: 'An npm authentication token is in an .npmrc in the repository. Anyone who has it can publish as you to that registry, and everyone who installs your packages runs what they publish.',
    action: 'Revoke the token with `npm token revoke` or on the registry\'s website now, and use an environment variable in .npmrc instead.'
  }),
  'xai-api-key': narration({
    severity: 'critical',
    consequence: 'An xAI API key is in the repository. Anyone who has it can send requests billed to your team.',
    action: 'Delete the key in the xAI console under API keys now, and review usage for the period it was exposed.'
  }),
  'openrouter-api-key': narration({
    severity: 'critical',
    consequence: 'An OpenRouter API key is in the repository. Anyone who has it can spend your credits on any model OpenRouter offers.',
    action: 'Delete the key in OpenRouter under Keys now, and check your activity for requests you did not make.'
  }),
  'pinecone-api-key': narration({
    severity: 'serious',
    consequence: 'A Pinecone API key is in the repository. Anyone who has it can read, overwrite and delete the vectors in your project\'s indexes -- often embeddings of private documents.',
    action: 'Delete the key in the Pinecone console under API keys and create a new one.'
  }),
  'langsmith-api-key': narration({
    severity: 'serious',
    consequence: 'A LangSmith API key is in the repository. Anyone who has it can read your traces, which record every prompt and response your application sent.',
    action: 'Delete the key in LangSmith settings under API keys now.'
  }),
  'shippo-token': narration({
    severity: 'serious',
    consequence: 'A Shippo API token is in the repository. A live token buys shipping labels on your account and reads your customers\' addresses.',
    action: 'Regenerate the token in Shippo under Settings, API, and check for labels you did not buy.'
  }),
  'plaid-access-token': narration({
    severity: 'critical',
    consequence: 'A Plaid access token is in the repository. With your Plaid client credentials it reads a linked person\'s bank accounts and transactions.',
    action: 'Remove the Item with /item/remove or rotate it, and check how the token reached the repository -- access tokens belong server-side only.'
  }),
  'woocommerce-secret': narration({
    severity: 'serious',
    consequence: 'A WooCommerce REST API consumer secret is in the repository. With its consumer key, anyone can use your store\'s API with the key\'s permissions: orders, customers and products.',
    action: 'Revoke the key under WooCommerce, Settings, Advanced, REST API, and create a new one.'
  }),
  'slack-app-token': narration({
    severity: 'serious',
    consequence: 'A Slack app-level token is in the repository. Anyone who has it can open a Socket Mode connection as your app and receive the events it subscribes to, messages included.',
    action: 'Revoke the token on the app\'s Basic Information page in Slack and generate a new one.'
  }),
  'discord-bot-token': narration({
    severity: 'critical',
    consequence: 'A Discord bot token is in the repository. Anyone who has it can log in as your bot in every server it has joined and do anything its permissions allow -- post, ban, read messages.',
    action: 'Reset the token on the Developer Portal\'s Bot page now; the old one stops working at once.'
  }),
  'dropbox-token': narration({
    severity: 'serious',
    consequence: 'A Dropbox access token is in the repository. Anyone who has it can read and change the files its app can reach until it expires.',
    action: 'Revoke the token -- or the app\'s access -- in Dropbox, and check the account for files you did not change.'
  }),
  'asana-token': narration({
    severity: 'serious',
    consequence: 'An Asana personal access token is in the repository. Anyone who has it can read and change every task and project its user can see.',
    action: 'Revoke the token in Asana under My Settings, Apps, Developer apps now.'
  }),
  'algolia-admin-key': narration({
    severity: 'serious',
    consequence: 'An Algolia admin or write API key is in the repository. Anyone who has it can overwrite or delete your search indexes and manage their settings.',
    action: 'Regenerate the admin key or delete the write key in the Algolia dashboard under API Keys.'
  }),
  'keystore-file': narration({
    severity: 'serious',
    consequence: 'A keystore file (PKCS#12, Java or BouncyCastle) is committed. It holds private keys and certificates -- often an app-signing or TLS key -- protected only by a password that can be attacked offline.',
    action: 'Treat the keys inside as exposed: replace the certificate or signing key where you can, and remove the file from the repository and its history.'
  }),
  'password-database-file': narration({
    severity: 'serious',
    consequence: 'A password database (KeePass) is committed. Everything in it is protected by one master password, and anyone with a copy can try to guess it offline, forever.',
    action: 'Change the passwords stored in it, starting with the most important, and remove the file from the repository and its history.'
  })

});
