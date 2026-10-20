import * as licences from './licences.ts';

/*
 * Uranus's catalogue: the engine's name, the categories a grade weighs, what
 * each severity costs, and every rule with what it means and how to fix it.
 */

export type Severity = 'critical' | 'serious' | 'warning';
export type CategoryId = 'supply-chain' | 'code' | 'access' | 'secrets' | 'dependencies' | 'infrastructure' | 'hygiene' | 'licences';
export interface Category {
  readonly id: CategoryId;
  readonly label: string;
  readonly weight: number;
}
/* What a rule finds, in the rule's own words: never a quotation of the code. */
export interface RuleDefinition {
  readonly category: CategoryId;
  readonly severity: Severity;
  readonly title: string;
  readonly why: string;
  readonly fix: string;
}

/* The engine's name and version, carried in every result and export. */
export const ENGINE = Object.freeze({ name: 'Uranus', version: '2.4.0' });

export const CATEGORIES: readonly Category[] = Object.freeze([
  Object.freeze({ id: 'supply-chain', label: 'Supply chain', weight: 0.15 }),
  Object.freeze({ id: 'code', label: 'Code security', weight: 0.25 }),
  Object.freeze({ id: 'access', label: 'Access control', weight: 0.15 }),
  Object.freeze({ id: 'secrets', label: 'Secrets', weight: 0.15 }),
  Object.freeze({ id: 'dependencies', label: 'Dependencies', weight: 0.1 }),
  Object.freeze({ id: 'infrastructure', label: 'Infrastructure', weight: 0.1 }),
  Object.freeze({ id: 'hygiene', label: 'Project hygiene', weight: 0.1 }),
  /* Compliance, not security: reported and exported with the rest, weighed at nothing in the grade. */
  Object.freeze({ id: 'licences', label: 'Licences', weight: 0 })
]);

export const SEVERITY_PENALTY: Readonly<Record<Severity, number>> = Object.freeze({ critical: 40, serious: 20, warning: 6 });
export const CRITICAL_CAP = 49;
/*
 * Confirmed serious findings hold the grade down too, by how many are open.
 * The grade is a weighted mean of seven categories, so serious findings
 * gathered in one category were spread thin: nine of them in Code security
 * could still average out to an A, under a headline that said "9 serious
 * issues to fix". The letter now never says less than the findings do: one
 * or two confirmed serious findings hold it to B at best, three to five to C,
 * six or more to D. Leads to confirm do not count, as they do not for the
 * critical cap.
 */
export const SERIOUS_CAPS: readonly (readonly [number, number])[] = Object.freeze([[6, 69], [3, 79], [1, 89]]);
export type Grade = 'A' | 'B' | 'C' | 'D' | 'F';
export const GRADES: readonly (readonly [Grade, number])[] = Object.freeze([['A', 90], ['B', 80], ['C', 70], ['D', 60], ['F', 0]]);

/* ---- Rules ----------------------------------------------------------------- */

/*
 * Each rule says what it found in words a person can act on, and how to fix
 * it. The words are the rule's own: the audit never quotes the code.
 */
export const RULES = Object.freeze<Record<string, RuleDefinition>>({
  'SUP-001': { category: 'supply-chain', severity: 'critical', title: 'An install script fetches or evaluates code',
    why: 'A preinstall, install, postinstall or prepare script runs on every machine that installs the package, before anyone reads it. Fetching or evaluating code there is how compromised packages steal credentials from developer laptops and CI.',
    fix: 'Remove network fetches and eval from lifecycle scripts. If a build step is needed, run it explicitly from a documented command, and vendor or pin whatever it downloads with a checksum.' },
  'SUP-002': { category: 'supply-chain', severity: 'serious', title: 'A remote script is piped straight into a shell',
    why: 'Whatever the server returns at that moment runs with the privileges of the build, with nothing checked. A compromised or hijacked host, or a man in the middle on plain HTTP, becomes code execution.',
    fix: 'Download the script to a file, verify it against a pinned checksum or signature, then run it. Prefer a package manager or a pinned release artifact.' },
  'SUP-003': { category: 'supply-chain', severity: 'critical', title: 'Encoded content is decoded and executed',
    why: 'Decoding a string and passing it to eval, Function or exec hides what runs from every reviewer and scanner. It is the signature of injected malware far more often than of a legitimate need.',
    fix: 'Replace the decoded execution with the plain code it stands for. If you did not write it, treat the repository as compromised: rotate its secrets and review recent commits.' },
  'SUP-004': { category: 'supply-chain', severity: 'warning', title: 'A long encoded payload is embedded in source',
    why: 'A multi-kilobyte encoded blob in application code cannot be reviewed. Often it is an inlined asset; sometimes it is a packed payload waiting to be decoded.',
    fix: 'Move assets into files and load them normally. If the blob is code, replace it with its source.' },
  'SUP-005': { category: 'supply-chain', severity: 'critical', title: 'Local credentials or the whole environment are read and sent out',
    why: 'Reading a credential store (SSH keys, cloud credentials, .npmrc, git credentials) or serialising the entire environment alongside a network call is how credential-stealing packages work.',
    fix: 'Remove the code. Read only the specific configuration values the application needs, and never transmit environment variables or local credential files.' },
  'SUP-006': { category: 'supply-chain', severity: 'warning', title: 'A dependency is installed from a URL or Git repository',
    why: 'A dependency fetched from a branch or URL has no published version, so what installs can change without the manifest changing and no advisory database tracks it.',
    fix: 'Depend on a published registry version, or pin the Git dependency to a full commit hash.' },
  'SUP-007': { category: 'supply-chain', severity: 'critical', title: 'A privileged workflow checks out pull-request code',
    why: 'pull_request_target and workflow_run jobs run with the repository’s secrets and a write token. Checking out the pull request’s head there runs whatever a stranger’s pull request contains -- build scripts, test hooks, install scripts -- with those secrets in reach.',
    fix: 'Build and test contributed code under the pull_request trigger, which has no secrets. If a privileged step is needed, keep it off the contributed code, or pass only artifacts from the unprivileged run to a workflow_run job that never executes them.' },
  'SUP-008': { category: 'supply-chain', severity: 'warning', title: 'A third-party action is not pinned to a commit',
    why: 'A tag or branch can be moved to different code at any time by whoever controls the action, and the next run executes it with the job’s secrets. That is how the tj-actions/changed-files compromise reached thousands of repositories.',
    fix: 'Pin the action to its full 40-character commit SHA with the version in a comment beside it, and let Dependabot or Renovate propose updates.' },
  'SUP-009': { category: 'supply-chain', severity: 'serious', title: 'Untrusted event text is spliced into a workflow script',
    why: 'Expressions are substituted into the script before the shell sees it, so an issue title, pull-request body, branch name or commit message that contains shell syntax becomes a command, run with the job’s token and secrets.',
    fix: 'Pass the value through an environment variable -- env: TITLE: ${{ github.event.issue.title }} -- and use "$TITLE", quoted, in the script, so the shell treats it as data.' },

  'SEC-001': { category: 'code', severity: 'critical', title: 'A SQL statement is built by string interpolation',
    why: 'Values spliced into SQL text are parsed as SQL. Any of them that a user can influence is an injection: read or delete data, bypass login.',
    fix: 'Use parameterised queries or the query builder’s placeholders, and pass values separately from the statement text.' },
  'SEC-002': { category: 'code', severity: 'serious', title: 'HTML is written from a variable without sanitising it',
    why: 'Assigning dynamic content to innerHTML, outerHTML, dangerouslySetInnerHTML or v-html renders any markup it contains, so user-controlled text becomes script (cross-site scripting).',
    fix: 'Set textContent instead, or render through the framework’s escaping. If HTML is required, sanitise it with a vetted sanitiser such as DOMPurify first.' },
  'SEC-003': { category: 'code', severity: 'serious', title: 'CORS lets any origin make credentialed requests',
    why: 'Reflecting every origin or allowing "*" together with credentials lets any website call this API with the visitor’s cookies and read the answer.',
    fix: 'Allow an explicit list of trusted origins, and enable credentials only for those.' },
  'SEC-004': { category: 'code', severity: 'warning', title: 'A cookie is set without HttpOnly or Secure',
    why: 'Without HttpOnly any script on the page can read the cookie; without Secure it travels over plain HTTP. For a session cookie either one is a takeover waiting for an XSS or a hostile network.',
    fix: 'Set httpOnly: true, secure: true and sameSite: ‘lax’ or ‘strict’ on session and authentication cookies.' },
  'SEC-005': { category: 'code', severity: 'serious', title: 'A non-cryptographic random number generates a secret value',
    why: 'Math.random() and Python’s random module are predictable. Tokens, reset codes, passwords or session identifiers made from them can be guessed.',
    fix: 'Use crypto.randomUUID() or crypto.getRandomValues() in JavaScript, crypto.randomBytes() in Node, and the secrets module in Python.' },
  'SEC-006': { category: 'code', severity: 'critical', title: 'A secret is placed in a variable the browser receives',
    why: 'Build tools copy variables with public prefixes (NEXT_PUBLIC_, VITE_, REACT_APP_, EXPO_PUBLIC_ and the like) into the JavaScript every visitor downloads. A secret named that way is published.',
    fix: 'Rename it without the public prefix, use it only in server code, and rotate the value: it has already shipped to browsers.' },
  'SEC-007': { category: 'code', severity: 'serious', title: 'A webhook endpoint never verifies its sender',
    why: 'Anyone who finds the URL can post a forged event (a paid invoice, a merged pull request) unless the handler checks the provider’s signature.',
    fix: 'Verify the provider’s signature header against the raw request body with the shared secret, using a constant-time comparison, before acting on the event.' },
  'SEC-008': { category: 'code', severity: 'serious', title: 'TLS certificate verification is switched off',
    why: 'With verification off, anyone on the network path can impersonate the server and read or alter the traffic, including credentials.',
    fix: 'Remove the override. If a private CA is involved, configure that CA as trusted instead of disabling checks.' },
  'SEC-009': { category: 'code', severity: 'critical', title: 'A token is accepted without verifying its signature',
    why: 'Decoding a JWT without verifying it, or allowing the "none" algorithm, accepts any token anyone writes, so every claim in it, including who the user is, can be forged.',
    fix: 'Verify every token with the expected algorithm and key (jwt.verify, jose.jwtVerify, PyJWT with algorithms=[...]) before trusting its claims.' },
  'SEC-010': { category: 'code', severity: 'critical', title: 'Request input is executed as code',
    why: 'Passing request data to eval, Function or exec -- or to PHP\u2019s eval and assert, a Java script engine, a SpEL or OGNL expression -- gives whoever sends the request the ability to run code on the server.',
    fix: 'Never evaluate input. Parse it as data (a JSON parser, a schema validator) and act on the parsed values.' },
  'SEC-011': { category: 'code', severity: 'serious', title: 'A shell command is built by string interpolation',
    why: 'Values spliced into a shell command are parsed by the shell. One that carries a semicolon or backtick runs a second command.',
    fix: 'Call the program with an argument list and no shell (execFile or spawn, subprocess.run([...]) with shell=False, exec.Command(name, args...), ProcessBuilder with separate arguments), or quote every PHP argument with escapeshellarg, so values are never parsed as shell syntax.' },
  'SEC-012': { category: 'code', severity: 'warning', title: 'Sign-in and account routes have no rate limiting',
    why: 'Without a limit, login, sign-up, password-reset and code-verification endpoints can be hammered for credential stuffing, enumeration or SMS/email cost.',
    fix: 'Add a per-IP and per-account rate limit to authentication routes (for example express-rate-limit, @upstash/ratelimit or Flask-Limiter).' },
  'SEC-013': { category: 'code', severity: 'serious', title: 'Debug mode is enabled in application configuration',
    why: 'Framework debug modes print stack traces, settings and sometimes an interactive console to anyone who triggers an error.',
    fix: 'Drive debug from an environment variable that defaults to off, and make sure production never sets it.' },
  'SEC-014': { category: 'code', severity: 'critical', title: 'Row level security is switched off on a table',
    why: 'With row level security disabled, the public anon key every visitor receives can read and change every row of the table through the auto-generated API.',
    fix: 'Enable it (alter table ... enable row level security) and add policies that give each role only the rows it should see.' },
  'SEC-015': { category: 'code', severity: 'serious', title: 'A table is created without row level security',
    why: 'Supabase serves every table in the public schema through its REST API. Until row level security is enabled, anyone holding the public anon key can read and write the whole table.',
    fix: 'Enable row level security in the same migration that creates the table, then write policies scoped to auth.uid() or to the roles that need access.' },
  'SEC-016': { category: 'code', severity: 'serious', title: 'A policy lets anyone change a table',
    why: 'A policy whose condition is simply true for insert, update, delete or all commands turns row level security on in name only: every caller it applies to can change every row.',
    fix: 'Replace true with a condition tied to the caller, such as auth.uid() = user_id, and grant the policy only to the roles that need it.' },
  'SEC-017': { category: 'code', severity: 'critical', title: 'Database rules let anyone write',
    why: 'Firebase rules that allow writes unconditionally, or test-mode rules that allow everything until a date, let anyone with the public app config change or delete the data.',
    fix: 'Require request.auth in every match block and check ownership, for example allow write: if request.auth != null && request.auth.uid == userId.' },
  'SEC-018': { category: 'code', severity: 'serious', title: 'Database rules let anyone read everything',
    why: 'A rule that allows reads on every document or path publishes the whole database to anyone with the public app config, which ships inside every client.',
    fix: 'Scope public reads to the collections meant to be public, and require request.auth with an ownership check everywhere else.' },
  'SEC-019': { category: 'code', severity: 'critical', title: 'The Supabase service-role key is used in browser code',
    why: 'The service-role key bypasses every row level security policy. Code that runs in the browser ships whatever it references to every visitor.',
    fix: 'Use the anon key in client code and keep the service-role key in server-only code (route handlers, server actions, edge functions). Rotate it if it was ever bundled.' },
  'SEC-020': { category: 'code', severity: 'warning', title: 'A redirect goes wherever the request says',
    why: 'Redirecting to a URL taken from the request lets anyone craft a link on your domain that lands on theirs -- the usual set-up for phishing and for stealing OAuth codes.',
    fix: 'Redirect only to relative paths or to an allow-list of known destinations, and reject anything else.' },
  'SEC-021': { category: 'code', severity: 'serious', title: 'The server fetches a URL taken from the request',
    why: 'Server-side request forgery: a caller can make the server reach internal services, the cloud metadata endpoint and private networks that it can see and they cannot.',
    fix: 'Accept an identifier rather than a URL, or check the URL against an allow-list of hosts and refuse private and link-local addresses after resolving the name.' },
  'SEC-022': { category: 'code', severity: 'serious', title: 'A file path is taken from the request',
    why: 'Path traversal: ../ in the value reaches files outside the intended folder -- configuration, keys, source code.',
    fix: 'Resolve the path against a fixed base directory and refuse it unless it stays inside, or map identifiers to files instead of accepting names.' },

  'SEC-023': { category: 'code', severity: 'serious', title: 'Passwords are hashed with a fast hash',
    why: 'MD5 and the SHA family are built to be fast, so a stolen table of password hashes can be guessed at billions of attempts a second on one graphics card.',
    fix: 'Hash passwords with a slow, salted password hash -- argon2id, scrypt or bcrypt -- through a maintained library, and rehash existing ones on next login.' },
  'SEC-024': { category: 'code', severity: 'serious', title: 'Untrusted data is deserialized into objects',
    why: 'pickle, marshal, yaml.load without the safe loader, node-serialize, Java\u2019s ObjectInputStream and XMLDecoder, SnakeYAML\u2019s default constructor and PHP\u2019s unserialize rebuild arbitrary objects from their input, and building the object runs code: whoever controls the bytes controls the process.',
    fix: 'Parse data with a data-only format -- JSON, yaml.safe_load, SnakeYAML\u2019s SafeConstructor, json_decode -- and validate it against a schema. Never deserialize objects from anything that crossed a network or a user\u2019s hands.' },
  'SEC-025': { category: 'code', severity: 'serious', title: 'A signing secret is written into the code',
    why: 'A JWT or session signing key in the source lets anyone who reads the repository mint tokens and sessions the application will trust as its own.',
    fix: 'Load the key from the environment or a secret manager, rotate it (every token signed with the old one becomes invalid), and keep it out of version control.' },

  'SEC-026': { category: 'code', severity: 'warning', title: 'A regular expression is built from input',
    why: 'A pattern a caller writes can take exponential time to evaluate (ReDoS), stalling the process for every other user, and can match far more than the code intended.',
    fix: 'Escape the input before building the pattern (escape-string-regexp in JavaScript, re.escape in Python), or match with plain string functions.' },
  'SEC-027': { category: 'code', severity: 'serious', title: 'Request data is merged into an object by its own keys',
    why: 'A deep merge or a path setter driven by a caller\u2019s keys can write __proto__ or constructor.prototype and change every object in the process (prototype pollution), which can bypass checks or run code.',
    fix: 'Merge only the fields you expect, reject __proto__, constructor and prototype keys, or merge into Object.create(null).' },
  'SEC-028': { category: 'code', severity: 'serious', title: 'A request body is written to the database as it arrived',
    why: 'Every field the caller adds is stored, including the ones the form never shows -- a role, an owner, a verified flag, a price (mass assignment).',
    fix: 'Pick the fields you mean to accept, or validate the body with a schema that strips unknown keys, before writing it.' },
  'SEC-029': { category: 'code', severity: 'serious', title: 'Request data is used as a database query object',
    why: 'In a JSON body a field can arrive as an object instead of a string, and a document database reads {"$ne": null} as an operator: a login that matches any password, a filter that returns everything (NoSQL injection).',
    fix: 'Coerce each field to the type you expect (String(value)) or validate the body with a schema before it reaches the query, and strip operator keys with a sanitiser such as express-mongo-sanitize.' },
  'SEC-030': { category: 'code', severity: 'critical', title: 'A server-side template is built from request data',
    why: 'Template engines evaluate expressions inside the template, so a template a caller writes runs their code on the server (server-side template injection).',
    fix: 'Render a fixed template and pass the input to it as a variable, never as the template\u2019s source.' },
  'SEC-031': { category: 'code', severity: 'warning', title: 'Error details are sent to the client',
    why: 'A stack trace or a raw error in a response tells an attacker file paths, library versions, queries and sometimes secrets, and shows them exactly which input broke what.',
    fix: 'Log the error on the server and answer with a generic message and an identifier the logs can be searched by.' },
  'SEC-032': { category: 'hygiene', severity: 'warning', title: 'Security work is left as a to-do in the code',
    why: 'A TODO or FIXME that mentions authentication, validation or permissions marks a check somebody knew was missing, and such notes outlive the sprint they were written in.',
    fix: 'Do the work the note describes, or file it where it is tracked and link the issue from the comment.' },
  'SEC-034': { category: 'code', severity: 'serious', title: 'XML from the request is parsed with external entities allowed',
    why: 'A parser that resolves external entities and document type definitions reads the files and fetches the URLs a document names (XML external entities): a request can return the server\u2019s own files, reach internal services, or expand nested entities until memory runs out.',
    fix: 'Turn document type definitions off on the parser (disallow-doctype-decl, or FEATURE_SECURE_PROCESSING with external entities disabled), leave LIBXML_NOENT and LIBXML_DTDLOAD unset in PHP, and parse with defusedxml in Python.' },
  'SEC-033': { category: 'code', severity: 'serious', title: 'Request input is written into an HTML response',
    why: 'Text from the request placed in HTML the server sends is markup to the browser, so a crafted link runs script on your domain with the visitor\u2019s session (reflected cross-site scripting).',
    fix: 'Render through a template engine that escapes by default, or escape the value for HTML before inserting it; answer with JSON where you can.' },

  'ACC-001': { category: 'access', severity: 'serious', title: 'An endpoint changes data without checking who is asking',
    why: 'Nothing before this handler or inside it establishes who the caller is, so anyone who finds the address can make the change -- create, edit or delete -- as easily as the application itself.',
    fix: 'Require a signed-in user before the handler runs (a middleware or the framework\u2019s session check), then confirm that user may change this particular record.' },
  'ACC-002': { category: 'access', severity: 'serious', title: 'A record is fetched by the caller\u2019s id and never checked against the caller',
    why: 'The handler checks that someone is signed in but not that the record is theirs, so changing the id in the request reads or changes somebody else\u2019s record (an insecure direct object reference) -- the most common serious flaw in generated applications.',
    fix: 'Scope the query to the signed-in user (for example where: { id, userId: session.user.id }), or load the record and refuse it unless its owner is the caller.' },
  'ACC-003': { category: 'access', severity: 'serious', title: 'An administrative or debugging endpoint is open',
    why: 'Endpoints for administration, debugging, metrics or seeding give whoever reaches them powers ordinary users never have, and their names are the first ones scanners try.',
    fix: 'Put the endpoint behind authentication and a role check, or leave it out of production builds entirely.' },
  'ACC-004': { category: 'access', severity: 'serious', title: 'A server action changes data without checking who is calling',
    why: 'Every exported server action is a public POST endpoint the browser can call directly with any arguments -- hiding its button does not hide the action.',
    fix: 'Check the session at the top of the action, then confirm the caller may act on the record its arguments name.' },
  'ACC-005': { category: 'access', severity: 'serious', title: 'An edge function accepts calls without a verified user',
    why: 'verify_jwt = false switches off the platform\u2019s check that a caller holds a valid token, and this function makes no check of its own, so anyone with its address can invoke it.',
    fix: 'Turn verify_jwt back on, or verify the Authorization header inside the function (supabase.auth.getUser) before doing anything else.' },

  'AI-001': { category: 'code', severity: 'critical', title: 'A language model\u2019s reply is executed or rendered unchecked',
    why: 'A model\u2019s reply is text shaped by whatever the prompt contained, including instructions planted in a document, a web page or a message. Executing it, running it as SQL or inserting it as HTML hands whoever planted them the sink.',
    fix: 'Treat the reply as untrusted data: parse it against a schema, allow only listed actions, escape it before rendering, and never pass it to eval, a shell or a query string.' },
  'AI-002': { category: 'code', severity: 'warning', title: 'Request text is written into a model\u2019s instructions',
    why: 'Text a user writes, placed in the system prompt, can override the instructions around it (prompt injection) and steer every tool and answer the model has.',
    fix: 'Keep user text in a user message, never in the system prompt; delimit it, and enforce what the model may do in code rather than in the prompt.' },
  'AI-003': { category: 'secrets', severity: 'serious', title: 'A model provider\u2019s key is used from the browser',
    why: 'dangerouslyAllowBrowser sends the provider key to every visitor, who can read it from the page and spend on your account or reach your data.',
    fix: 'Call the model from a server route or an edge function that holds the key, and have the browser call that route.' },

  'IAC-001': { category: 'infrastructure', severity: 'warning', title: 'The container runs as root',
    why: 'Without a USER instruction the process inside the image runs as root, so a bug that gives an attacker the process gives them root in the container and a far shorter path out of it.',
    fix: 'Create an unprivileged user in the image and switch to it with USER before the entrypoint, or start from a nonroot base image.' },
  'IAC-002': { category: 'infrastructure', severity: 'serious', title: 'The image adds a file straight from a URL',
    why: 'ADD with a URL downloads whatever the server returns at build time with no integrity check, and bakes it into every container.',
    fix: 'Download with curl in a RUN step and verify a pinned checksum, or use ADD --checksum=sha256:... so a changed file fails the build.' },
  'IAC-003': { category: 'infrastructure', severity: 'serious', title: 'A secret is baked into the container image',
    why: 'ENV and ARG values are stored in the image\u2019s layers and history; anyone who can pull the image can read them with docker history.',
    fix: 'Pass secrets at run time (environment or mounted secret) or with BuildKit --mount=type=secret during the build, and rotate the value that was baked in.' },
  'IAC-004': { category: 'infrastructure', severity: 'serious', title: 'A workflow gives its token write access to everything',
    why: 'permissions: write-all hands every step -- including third-party actions -- a token that can push code, change releases and edit workflows.',
    fix: 'Declare the least permissions the job needs (for example contents: read) at the workflow or job level.' },
  'IAC-005': { category: 'infrastructure', severity: 'critical', title: 'A storage bucket is public',
    why: 'A public-read ACL lets anyone on the internet list and download the bucket\u2019s objects; public-read-write lets them upload and overwrite them too.',
    fix: 'Make the bucket private, enable the account-level public access block, and serve public files through a CDN with signed URLs if they must be reachable.' },
  'IAC-006': { category: 'infrastructure', severity: 'serious', title: 'An admin or database port is open to the internet',
    why: 'A security group that lets 0.0.0.0/0 reach SSH, RDP or a database port puts the service in front of every scanner on the internet.',
    fix: 'Restrict the rule to known addresses or a VPN, or reach the host through a bastion or a managed session service instead.' },
  'IAC-007': { category: 'infrastructure', severity: 'warning', title: 'Data is stored without encryption at rest',
    why: 'An unencrypted volume, snapshot or database can be read by anyone who gets a copy of the storage, which is how many cloud leaks happen.',
    fix: 'Set encrypted = true (or storage_encrypted = true) and use a managed key.' },
  'IAC-008': { category: 'infrastructure', severity: 'serious', title: 'A database accepts connections from the internet',
    why: 'publicly_accessible = true gives the database a public address, so its password is the only thing between it and the internet.',
    fix: 'Set publicly_accessible = false and reach the database from inside the network or through a proxy.' },
  'IAC-009': { category: 'infrastructure', severity: 'serious', title: 'A container runs privileged or shares the host',
    why: 'A privileged container, or one on the host\u2019s network, process or IPC namespace, can reach the node itself -- escaping it takes one bug, not a chain.',
    fix: 'Remove privileged: true and the host namespaces, and grant only the specific capabilities the workload needs.' },
  'IAC-010': { category: 'infrastructure', severity: 'warning', title: 'A container may run as root or escalate privileges',
    why: 'runAsUser: 0 or allowPrivilegeEscalation: true lets the process gain root inside the container, which widens what any compromise of it can do.',
    fix: 'Set runAsNonRoot: true, a non-zero runAsUser, and allowPrivilegeEscalation: false in the securityContext.' },

  'SCR-001': { category: 'secrets', severity: 'critical', title: 'A credential is committed to the repository',
    why: 'Anyone who can read the repository, or any fork, clone or backup of it, can use the credential. Deleting the file later does not remove it from history.',
    fix: 'Revoke or rotate the credential with its provider first, then load it from an environment variable or a secret store at runtime. Exposure shows every place it appears, history included.' },

  'DEP-001': { category: 'dependencies', severity: 'serious', title: 'A dependency does not exist in the public registry',
    why: 'A package name the registry has never heard of is often one an assistant invented. Anyone can publish under that name later, and the next install will fetch their code.',
    fix: 'Check the name against the package’s documentation. Replace it with the real package, or remove it if nothing uses it.' },
  'DEP-002': { category: 'dependencies', severity: 'warning', title: 'A scoped dependency is not in the public registry',
    why: 'A scoped package missing from the public registry is either private (fine, if the registry is configured) or invented. If the scope is not yours, anyone who registers it controls what installs.',
    fix: 'Confirm the scope belongs to your organisation and the registry is configured in .npmrc; otherwise replace or remove the dependency.' },
  'DEP-003': { category: 'dependencies', severity: 'serious', title: 'A dependency version has a published vulnerability',
    why: 'The version in use is listed in OSV, the open vulnerability database that gathers GitHub, npm and PyPI advisories. Published vulnerabilities are the first thing automated attacks try.',
    fix: 'Upgrade to the fixed version or later, regenerate the lockfile and run the tests. For a transitive dependency, upgrade the package that brings it in, or add an override.' },
  'DEP-004': { category: 'dependencies', severity: 'warning', title: 'A dependency name is one keystroke from a popular package',
    why: 'Typosquats copy a popular name with one letter changed, added or swapped and run their payload on install. A legitimate package can sit that close too, which is why this asks rather than accuses.',
    fix: 'Check the name against the documentation of the package you meant. If it is a typo, replace it and treat every machine that installed it as exposed.' },
  'DEP-005': { category: 'dependencies', severity: 'warning', title: 'A version range still allows a vulnerable release',
    why: 'Nothing pins what installs, and the lowest version the range accepts has a published vulnerability -- a fresh install, an old cache or another package manager can still pick it.',
    fix: 'Raise the floor of the range to the fixed version and commit a lockfile so every install resolves the same versions.' },
  'DEP-006': { category: 'dependencies', severity: 'critical', title: 'A dependency is a known malicious package',
    why: 'OSV lists this package as malicious: it was published to steal credentials, mine or open a backdoor, and it runs when it is installed.',
    fix: 'Remove it, then treat every machine and CI runner that installed it as compromised: rotate the credentials they held and review what ran.' },

  'HYG-001': { category: 'hygiene', severity: 'critical', title: 'An environment file is committed',
    why: 'Anyone who can read the repository, now or in any fork or clone, can read what the file holds. Removing it later does not remove it from history.',
    fix: 'Delete the file, add it to .gitignore, rotate every value it contained, and keep a .env.example with placeholder values instead.' },
  'HYG-002': { category: 'hygiene', severity: 'serious', title: '.gitignore does not exclude environment files',
    why: 'The project reads configuration from the environment, and nothing stops the next person committing their .env with it.',
    fix: 'Add ".env" and ".env.*" (with "!.env.example") to .gitignore.' },
  'HYG-003': { category: 'hygiene', severity: 'warning', title: 'The JavaScript project has no lockfile',
    why: 'Without a lockfile every install resolves versions afresh, so builds are not reproducible and a newly published malicious patch version installs silently.',
    fix: 'Commit the lockfile your package manager produces (package-lock.json, pnpm-lock.yaml or yarn.lock) and install with the frozen/ci mode.' },
  'HYG-004': { category: 'hygiene', severity: 'warning', title: 'More than one lockfile is committed',
    why: 'Two package managers resolve the same manifest differently, so which versions are installed depends on who ran what.',
    fix: 'Choose one package manager, delete the other lockfiles, and record the choice in package.json ("packageManager").' },
  'HYG-005': { category: 'hygiene', severity: 'warning', title: 'Dependencies accept any future version',
    why: 'A version of "*", "latest", "x" or an open-ended ">=" range installs whatever is published next, including a breaking or malicious release.',
    fix: 'Use a caret or exact version range and let the lockfile pin the resolved versions.' },
  'HYG-006': { category: 'hygiene', severity: 'warning', title: 'A container base image is not pinned',
    why: 'An image tagged latest, or with no tag, changes underneath the build, so the same Dockerfile produces different images over time.',
    fix: 'Pin the base image to a specific version tag, ideally with its digest (image:1.2.3@sha256:...).' },
  'HYG-007': { category: 'hygiene', severity: 'warning', title: 'TypeScript strict mode is off',
    why: 'Without strict mode, null and undefined flow through unchecked and implicit any hides type errors that become runtime failures.',
    fix: 'Set "strict": true in tsconfig.json and fix what it reports, or enable its checks one at a time.' },
  'HYG-008': { category: 'hygiene', severity: 'warning', title: 'The repository has no README',
    why: 'Nobody arriving at the repository, reviewers and future maintainers included, can tell what it does or how to run it safely.',
    fix: 'Add a README covering what the project is, how to run it locally, how configuration and secrets are supplied, and how to report a security issue.' },
  'HYG-009': { category: 'hygiene', severity: 'warning', title: 'No automated tests were found',
    why: 'Without tests every change, including a security fix, is verified by hand or not at all.',
    fix: 'Add a test runner and start with tests for authentication, authorisation and payment paths.' },
  /* What each dependency may be used under: licences.ts. */
  ...licences.RULES
});

/* Why the per-rule contribution to a category is capped: one rule firing thirty times is one problem. */
export const RULE_CAP = 2;

export const SEVERITY_ORDER: Readonly<Record<Severity, number>> = Object.freeze({ critical: 0, serious: 1, warning: 2 });

/* A rule's definition by its id; an id the catalogue does not hold is a defect in the caller, never a finding. */
export function ruleOf(rule: string): RuleDefinition {
  const definition = Object.hasOwn(RULES, rule) ? RULES[rule] : undefined;
  if (!definition) throw new Error(`Uranus has no rule ${rule}.`);
  return definition;
}
