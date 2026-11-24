/*
 * Quasar's routes: exposure scans requested, read, cancelled and cleared; the
 * findings they recorded and each scan's report; and the three decisions
 * about a finding -- asking its provider whether the credential still works,
 * asking a project what its anonymous key can read, and accepting the risk.
 *
 * Every one of them carries the same chain as a governance route, and for the
 * same reasons: a provider session, the alpha repository boundary, the
 * capability gate, authentication, a governance role, and -- where something is
 * decided rather than read -- a mutation context that records it. The guards
 * are handed in under the names the route policy records
 * (test/oracles/route-policy.json), and the routes are registered in its order.
 *
 * Two things about this chain are load-bearing rather than copied.
 *
 * The identity comes from the governance actor's identity key, and it is
 * passed into every store call so the boundary lives in the WHERE clause
 * rather than in a comparison somebody could forget. A scan id is a uuid a
 * caller could hold without owning.
 *
 * Accepting the risk of a live credential requires `administrator`, not
 * `reader`. A repository reader can ask for a scan of a repository they can
 * already read, and cannot wave away what it finds: deciding that an exposed
 * credential is acceptable is a decision about somebody else's security.
 */
import crypto from 'node:crypto';
import type { Application, Request, RequestHandler, Response } from 'express';
import type { Severity } from '../../../../../../packages/contracts/src/findings.ts';
import { isFields, member, read } from '../../../platform/values/fields.ts';
import type { Fields } from '../../../platform/values/fields.ts';
import { cleanText } from '../../../platform/values/text.ts';
import { DETECTION_ENGINE_VERSION, RULES_VERSION, detectInText } from '../domain/exposure-detection.ts';
import { FINGERPRINT_KEY_VERSION, buildFindings, fingerprintKeyId, revealForVerification } from '../domain/exposure-findings.ts';
import { describeProbe, describeVerification, exposureSeverityOf } from '../domain/exposure-narration.ts';
import { adapterForCandidate, signVerificationAuthorization } from '../client/credential-verification.ts';
import type { VerificationRecord, VerifyInput } from '../client/credential-verification.ts';
import { OPERATIONS as READABILITY_OPERATIONS, discoverProject, signReadabilityAuthorization } from '../client/anonymous-readability-probe.ts';
import type { ProbeInput, ReadabilityObservation } from '../client/anonymous-readability-probe.ts';
import type * as ExposureReader from '../client/exposure-reader.ts';
import { EXPOSURE_CONFIG_VERSION } from '../persistence/exposure-store.ts';
import type { ExposureStore } from '../persistence/exposure-store.ts';
import { exposureFindingPayload } from './finding-payload.ts';

/* What a governance role check may admit beyond the repository's collaborators. */
export interface GovernanceAccessOptions {
  readonly publicRepositories?: boolean;
}

/* The store calls these routes make. */
export type ExposureRecords = Pick<ExposureStore,
  'requestScan' | 'getScan' | 'listScans' | 'scanRuleCounts' | 'clearHistory' | 'cancelScan' | 'listFindingsPage'
  | 'latestAnswers' | 'scanReportPage' | 'getFinding' | 'recordVerification' | 'listVerifications'
  | 'recordReadabilityProbe' | 'listReadabilityProbes' | 'acceptRisk'>;

export interface ExposureRouteDeps {
  readonly providerSessionAccess: RequestHandler;
  readonly alphaRepositoryAccess: RequestHandler;
  readonly capabilityAccess: (feature: string) => RequestHandler;
  readonly auth: RequestHandler;
  readonly governanceAccess: (role: string, options?: GovernanceAccessOptions) => RequestHandler;
  /* Admits a public repository's reader to the routes whose data is their own. */
  readonly OWN_WORK: GovernanceAccessOptions;
  readonly governanceMutationContext: (action: string) => RequestHandler;
  /* What the governance guard attached: the scope and the actor it resolved. */
  readonly governance: (req: Request) => unknown;
  /* The provider account the session is acting as, as the guards attached it. */
  readonly account: (req: Request) => unknown;
  /* Who a scan, a check or a decision is recorded as asked by. */
  retainedActor(req: Request): unknown;
  /* The server's public error body: it refuses to echo a message carrying a secret signal. */
  publicErrorBody(error: unknown): unknown;
  /* The scans' store; throws without a database. */
  exposureService(): ExposureRecords;
  /* Starts the worker on a scan now rather than at its next tick. */
  nudgeWorker(): void;
  /* The keys each grant and fingerprint is made with, each derived for its own purpose. */
  readonly keys: {
    readonly fingerprint: unknown;
    readonly verification: unknown;
    readonly verificationSubject: unknown;
    readonly readability: unknown;
  };
  /* The repository reader, the credential verifier and the readability prober: the three parties these routes reach. */
  readonly reader: Pick<typeof ExposureReader, 'resolveCommit' | 'readFileAtCommit'>;
  verifyCredential(input: VerifyInput): Promise<VerificationRecord>;
  probeReadability(input: ProbeInput): Promise<ReadabilityObservation>;
}

/* The tally a scan's history carries, by severity. */
function emptyTally(): Record<Severity, number> {
  return { critical: 0, serious: 0, warning: 0 };
}

/* A request body that is a plain object, or an empty one. */
function bodyOf(value: unknown): Fields {
  return isFields(value) && !Buffer.isBuffer(value) ? value : {};
}

export function registerExposureRoutes(app: Application, deps: ExposureRouteDeps): void {
  const {
    providerSessionAccess, alphaRepositoryAccess, capabilityAccess, auth,
    governanceAccess, OWN_WORK, governanceMutationContext, account
  } = deps;
  const scopeOf = (req: Request): unknown => member(deps.governance(req), 'scope');
  const identityOf = (req: Request): unknown => member(member(deps.governance(req), 'actor'), 'identityKey');
  const tokenOf = (req: Request): unknown => member(account(req), 'token');

  /*
   * The same public-error body every other route uses. It is the one that
   * already refuses to echo a message carrying a secret signal, which matters
   * more here than anywhere else: an error on this path can have been raised
   * while a request carrying a discovered credential was in flight.
   */
  const exposureFailure = (res: Response, error: unknown): void => {
    const status = Number.isInteger(error ? member(error, 'status') : error) ? member(error, 'status') : 500;
    res.status(Number(status)).json(deps.publicErrorBody(error));
  };

  app.post('/api/repo/:owner/:repo/exposure/scans', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('exposure.scan'), auth, governanceAccess('reader', OWN_WORK), governanceMutationContext('exposure.scan.request'), async (req: Request, res: Response) => {
    try {
      const store = deps.exposureService();
      /*
       * The ref is resolved here, once, and the commit is what the scan records.
       * Resolving it later -- in the worker, per read -- is what would let a push
       * between the tree read and the blob reads mix two trees.
       */
      const resolved = await deps.reader.resolveCommit({
        scope: scopeOf(req),
        ref: String(read(req.body, 'ref') || 'HEAD'),
        token: tokenOf(req)
      });
      const requested = await store.requestScan({
        scope: scopeOf(req),
        identityKey: identityOf(req),
        requestedBy: deps.retainedActor(req),
        refName: resolved.ref,
        commitSha: resolved.commitSha,
        rulesVersion: RULES_VERSION,
        engineVersion: DETECTION_ENGINE_VERSION,
        fingerprintKeyVersion: FINGERPRINT_KEY_VERSION,
        fingerprintKeyId: fingerprintKeyId(deps.keys.fingerprint),
        configVersion: EXPOSURE_CONFIG_VERSION,
        /* History is asked for, not assumed: it is many times the requests of a
           tree read, against the reader's own provider allowance. Only a literal
           true asks. */
        scanMode: read(req.body, 'history') === true ? 'history' : 'tree',
        idempotencyKey: cleanText(String(req.get('Idempotency-Key') || crypto.randomUUID()), 200)
      });
      deps.nudgeWorker();
      res.status(requested.created ? 201 : 200).json({ scan: requested.scan, created: requested.created });
    } catch (error) { exposureFailure(res, error); }
  });

  app.get('/api/repo/:owner/:repo/exposure/scans/:scanId', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('exposure.scan'), auth, governanceAccess('reader', OWN_WORK), async (req: Request, res: Response) => {
    try {
      const store = deps.exposureService();
      const scan = await store.getScan({
        scope: scopeOf(req),
        scanId: String(req.params.scanId || ''),
        identityKey: identityOf(req)
      });
      if (!scan) { res.status(404).json({ error: 'Not found', code: 'EXPOSURE_SCAN_NOT_FOUND' }); return; }
      res.json({ scan });
    } catch (error) { exposureFailure(res, error); }
  });

  /*
   * The history: this person's scans of this repository, newest first, each with
   * how many findings of each severity it recorded, summed by the narration
   * table's severity. Paged by the last row seen, so a scan finishing mid-page
   * does not shift the next page.
   */
  app.get('/api/repo/:owner/:repo/exposure/scans', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('exposure.scan'), auth, governanceAccess('reader', OWN_WORK), async (req: Request, res: Response) => {
    try {
      const store = deps.exposureService();
      const scope = scopeOf(req);
      const identityKey = identityOf(req);
      const beforeAt = String(req.query.beforeAt || '');
      const beforeId = String(req.query.beforeId || '');
      const scans = await store.listScans({
        scope, identityKey,
        limit: Number.parseInt(String(req.query.limit || '20'), 10),
        before: beforeAt && beforeId ? { createdAt: beforeAt, scanId: beforeId } : null
      });
      const counts = await store.scanRuleCounts({ scope, identityKey, scanIds: scans.map(scan => scan.scanId) });
      const severities = new Map<unknown, Record<Severity, number>>();
      for (const item of counts) {
        const tally = severities.get(item.scanId) || emptyTally();
        tally[exposureSeverityOf(item.rule)] += item.total;
        severities.set(item.scanId, tally);
      }
      res.json({
        scans: scans.map(scan => ({
          ...scan,
          severityCounts: severities.get(scan.scanId) || emptyTally()
        }))
      });
    } catch (error) { exposureFailure(res, error); }
  });

  /*
   * Clearing this person's exposure record for this repository: every scan,
   * finding and check result. The ledger entry this route writes is what
   * survives, so clearing the evidence of a decision never clears the evidence
   * of the clear.
   */
  app.post('/api/repo/:owner/:repo/exposure/clear', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('exposure.scan'), auth, governanceAccess('reader', OWN_WORK), governanceMutationContext('exposure.history.clear'), async (req: Request, res: Response) => {
    try {
      /* The same explicit word as the other irreversible actions, refused
         before anything is touched. */
      const body = bodyOf(req.body);
      if (String(body.confirm || '') !== 'clear-exposure-history') {
        res.status(400).json({
          error: 'Clearing exposure history requires an explicit confirmation',
          code: 'EXPOSURE_CLEAR_UNCONFIRMED'
        });
        return;
      }
      const store = deps.exposureService();
      const cleared = await store.clearHistory({
        scope: scopeOf(req),
        identityKey: identityOf(req)
      });
      res.status(201).json({ cleared });
    } catch (error) { exposureFailure(res, error); }
  });

  app.post('/api/repo/:owner/:repo/exposure/scans/:scanId/cancel', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('exposure.scan'), auth, governanceAccess('reader', OWN_WORK), governanceMutationContext('exposure.scan.cancel'), async (req: Request, res: Response) => {
    try {
      const store = deps.exposureService();
      const scan = await store.cancelScan({
        scope: scopeOf(req),
        scanId: String(req.params.scanId || ''),
        identityKey: identityOf(req)
      });
      if (!scan) { res.status(404).json({ error: 'Not found', code: 'EXPOSURE_SCAN_NOT_FOUND' }); return; }
      res.status(201).json({ scan });
    } catch (error) { exposureFailure(res, error); }
  });

  /*
   * The current findings, each described with its observed locations, and the
   * latest answer to each question asked of them. Locations come from the one
   * consistent page: a later location read would overwrite snapshot evidence.
   */
  app.get('/api/repo/:owner/:repo/exposure/findings', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('exposure.scan'), auth, governanceAccess('reader', OWN_WORK), async (req: Request, res: Response) => {
    try {
      const store = deps.exposureService();
      const scope = scopeOf(req);
      const identityKey = identityOf(req);
      const page = await store.listFindingsPage({
        scope, identityKey, currentGeneration: true,
        limit: Number.parseInt(String(req.query.limit || '50'), 10),
        cursor: req.query.cursor ? String(req.query.cursor) : null,
        query: String(req.query.q || ''), severity: String(req.query.severity || 'all'),
        where: String(req.query.where || 'all'),
        dispositions: req.query.status && req.query.status !== 'all' ? [String(req.query.status)] : undefined
      });
      const fingerprints = page.findings.map(finding => finding.fingerprint);
      const answers = await store.latestAnswers({ scope, identityKey, fingerprints });
      res.json({
        ...page,
        findings: page.findings.map(exposureFindingPayload),
        verifications: Object.fromEntries(Object.entries(answers.verifications)
          .map(([fingerprint, item]) => [fingerprint, { ...Object(item), narration: describeVerification(item) }])),
        probes: Object.fromEntries(Object.entries(answers.probes)
          .map(([fingerprint, item]) => [fingerprint, { ...Object(item), narration: describeProbe(item) }]))
      });
    } catch (error) { exposureFailure(res, error); }
  });

  app.get('/api/repo/:owner/:repo/exposure/scans/:scanId/observations', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('exposure.scan'), auth, governanceAccess('reader', OWN_WORK), async (req: Request, res: Response) => {
    try {
      /*
       * A scan's report: each observation with the finding it is about, so a
       * history entry can be opened and read without a second request per row.
       */
      const store = deps.exposureService();
      const report = await store.scanReportPage({
        scope: scopeOf(req),
        scanId: String(req.params.scanId || ''),
        identityKey: identityOf(req),
        limit: Number.parseInt(String(req.query.limit || '50'), 10),
        cursor: req.query.cursor ? String(req.query.cursor) : null
      });
      res.json({
        nextCursor: report.nextCursor,
        complete: report.complete,
        observations: report.observations.map(entry => ({
          ...entry.observation,
          /* Described with this scan's locations, so "where" names the line. */
          finding: exposureFindingPayload({
            ...entry.finding,
            occurrences: entry.observation.occurrences,
            occurrenceCount: entry.observation.occurrenceCount,
            truncated: entry.observation.truncated,
            inTree: entry.observation.inTree,
            introducedCommit: entry.observation.introducedCommit,
            introducedAt: entry.observation.introducedAt,
            historyCommits: entry.observation.historyCommits,
            decodedFrom: entry.observation.decodedFrom
          })
        }))
      });
    } catch (error) { exposureFailure(res, error); }
  });

  /*
   * Asking the provider whether a discovered credential is still live.
   *
   * This is the most consequential thing the feature does: it takes a credential
   * found in somebody's repository and sends it to a third party. So it is the
   * one route that asks for an explicit word rather than a click, and the word
   * is checked before anything is read.
   *
   * The interesting part is where the credential comes from. Nothing stored it --
   * that is the whole design of `nv_exposure_findings`, which holds a keyed
   * fingerprint, a generated placeholder and bounded line numbers. So the bytes
   * are recovered the only honest way: re-read that blob from the provider at
   * the commit the finding recorded, run detection over it again, and take the
   * candidate whose fingerprint matches. If the file changed, no candidate
   * matches and nothing is sent.
   *
   * The bytes exist for the length of one probe and are never written down. That
   * is a weaker claim than "erased" and it is the true one: a JavaScript string
   * cannot be wiped, so what is promised is that no copy is kept.
   */
  app.post('/api/repo/:owner/:repo/exposure/findings/:fingerprint/verify', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('exposure.scan'), auth, governanceAccess('administrator'), governanceMutationContext('exposure.credential.verify'), async (req: Request, res: Response) => {
    try {
      const store = deps.exposureService();
      const scope = scopeOf(req);
      const identityKey = identityOf(req);
      const fingerprint = String(req.params.fingerprint || '').toLowerCase();

      /*
       * The explicit word. A button that reads "check this" and a request that
       * says so are not the same thing: this is the confirmation the plan
       * requires an operator to give before a credential is used, and it is
       * refused before any repository read happens.
       */
      if (String(read(req.body, 'confirm') || '') !== 'use-this-credential' || member(req.body, 'authorized') !== true) {
        res.status(400).json({
          error: 'Verifying a credential requires an explicit confirmation',
          code: 'EXPOSURE_VERIFY_UNCONFIRMED'
        });
        return;
      }

      const finding = await store.getFinding({ scope, identityKey, fingerprint });
      if (!finding) { res.status(404).json({ error: 'Not found', code: 'EXPOSURE_FINDING_NOT_FOUND' }); return; }
      if (!finding.commit) {
        res.status(409).json({
          error: 'Run a new scan to establish the finding commit', code: 'EXPOSURE_PROVENANCE_REQUIRED'
        });
        return;
      }

      /*
       * Re-read, re-detect, and match by fingerprint. A file that changed since
       * the scan yields no match, and that is reported rather than guessed at:
       * verifying a credential the repository no longer contains would be using
       * a secret nobody asked about. The file is read as it stood at the
       * finding's commit -- inside an archive when the finding is, and at the
       * commit that added it when it is only in history.
       */
      const blob = await deps.reader.readFileAtCommit({
        scope, commitSha: finding.commit, path: finding.path, token: tokenOf(req)
      });
      if (blob.skip === 'missing') {
        res.status(409).json({ error: 'That file is no longer readable at that commit', code: 'EXPOSURE_CANDIDATE_GONE' });
        return;
      }
      if (blob.skip || typeof blob.text !== 'string') {
        res.status(409).json({ error: 'That file could not be read', code: 'EXPOSURE_CANDIDATE_GONE' });
        return;
      }
      const built = buildFindings({
        detection: detectInText({ text: blob.text }),
        path: finding.path, scope, commit: finding.commit,
        hmacKey: deps.keys.fingerprint, keyVersion: finding.fingerprintKeyVersion
      });
      const probe = built.probes.find(item => item.fingerprint === fingerprint);
      if (!probe) {
        res.status(409).json({ error: 'That credential is no longer at that location', code: 'EXPOSURE_CANDIDATE_GONE' });
        return;
      }

      /*
       * The grant is minted here and spent immediately, which is not
       * ceremony. It binds the probe to this candidate, this repository, this
       * commit, this adapter and this target, and the verifier checks all of it
       * -- so the verifier cannot be called for anything other than what this
       * route resolved. It expires in a minute: spent now or not at all.
       */
      const candidate = revealForVerification(probe);
      const adapter = adapterForCandidate(candidate);
      const issuedAt = new Date();
      const authorizationId = crypto.randomUUID();
      const authorization = signVerificationAuthorization({
        hmacKey: deps.keys.verification,
        authorizationId,
        actorLogin: deps.retainedActor(req),
        scope,
        commit: finding.commit,
        candidateFingerprint: fingerprint,
        adapter: adapter ? adapter.id : 'none',
        targetId: adapter ? adapter.targetId : 'none',
        issuedAt: issuedAt.toISOString(),
        expiresAt: new Date(issuedAt.getTime() + 60_000).toISOString()
      });

      const record = await deps.verifyCredential({
        candidate,
        authorization,
        authorizationKey: deps.keys.verification,
        subjectKey: deps.keys.verificationSubject,
        actorLogin: deps.retainedActor(req),
        now: issuedAt.getTime()
      });

      /* Recorded whatever the answer, because the history is the evidence. */
      const stored = await store.recordVerification({
        scope, identityKey, fingerprint,
        requestedBy: deps.retainedActor(req),
        adapterVersion: record.adapterVersion,
        targetId: record.targetId,
        authorizationId,
        record
      });
      res.status(201).json({
        verification: stored.verification,
        finding: exposureFindingPayload(stored.finding),
        narration: describeVerification(record)
      });
    } catch (error) { exposureFailure(res, error); }
  });

  app.get('/api/repo/:owner/:repo/exposure/findings/:fingerprint/verifications', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('exposure.scan'), auth, governanceAccess('reader', OWN_WORK), async (req: Request, res: Response) => {
    try {
      const store = deps.exposureService();
      const verifications = await store.listVerifications({
        scope: scopeOf(req),
        identityKey: identityOf(req),
        fingerprint: String(req.params.fingerprint || '').toLowerCase(),
        limit: Number.parseInt(String(req.query.limit || '20'), 10)
      });
      res.json({
        verifications: verifications.map(item => ({ ...item, narration: describeVerification(item) }))
      });
    } catch (error) { exposureFailure(res, error); }
  });

  /*
   * Asking a project what the anonymous role can read.
   *
   * This is the one question a scan cannot answer by looking. An anonymous key
   * in a repository is published on purpose -- it is in the browser bundle of
   * every app that uses one -- and whether it can read anything is decided by
   * row-level security policies that live in somebody's project, not in their
   * tree. Reporting the key as a leak would make every project a critical
   * finding; reporting nothing would miss the projects where the policies are
   * open. So the product asks.
   *
   * Three things an operator supplies and this route will not invent: the
   * confirmation, the relation, and the columns. A probe against a table nobody
   * named would be this server choosing what to read out of somebody's
   * database, and the grant is signed over exactly what was named so the prober
   * cannot be asked for anything else.
   */
  app.post('/api/repo/:owner/:repo/exposure/findings/:fingerprint/probe-readability', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('exposure.scan'), auth, governanceAccess('administrator'), governanceMutationContext('exposure.readability.probe'), async (req: Request, res: Response) => {
    try {
      const store = deps.exposureService();
      const scope = scopeOf(req);
      const identityKey = identityOf(req);
      const fingerprint = String(req.params.fingerprint || '').toLowerCase();
      const body = bodyOf(req.body);

      /* Refused before any repository read, like the verification confirmation
         beside it: this contacts a third party's project. */
      if (String(body.confirm || '') !== 'contact-this-project' || body.authorized !== true) {
        res.status(400).json({
          error: 'Probing readability requires an explicit confirmation',
          code: 'EXPOSURE_PROBE_UNCONFIRMED'
        });
        return;
      }
      const relation = String(body.relation || '').trim();
      const projection = (Array.isArray(body.projection) ? body.projection : [])
        .map(column => String(column || '').trim());

      const finding = await store.getFinding({ scope, identityKey, fingerprint });
      if (!finding) { res.status(404).json({ error: 'Not found', code: 'EXPOSURE_FINDING_NOT_FOUND' }); return; }
      if (!finding.commit) {
        res.status(409).json({
          error: 'Run a new scan to establish the finding commit', code: 'EXPOSURE_PROVENANCE_REQUIRED'
        });
        return;
      }

      /*
       * Only the anonymous key. A service-role key looks almost exactly like it
       * and bypasses every policy, so a probe with one comes back readable
       * whatever the project permits: it would prove nothing and would have used
       * an administrator credential to do it. The prober refuses it too; this
       * refuses it earlier, without reading the file.
       */
      if (finding.rule !== 'supabase-anon-key') {
        res.status(400).json({
          error: 'Only an anonymous key can be used to ask what the public can read',
          code: 'EXPOSURE_PROBE_NOT_ANONYMOUS'
        });
        return;
      }

      /* The file as it stood at the finding's commit -- inside an archive when
         the finding is, and at the commit that added it when it is only in
         history. */
      const blob = await deps.reader.readFileAtCommit({
        scope, commitSha: finding.commit, path: finding.path, token: tokenOf(req)
      });
      if (blob.skip === 'missing') {
        res.status(409).json({ error: 'That file is no longer readable at that commit', code: 'EXPOSURE_CANDIDATE_GONE' });
        return;
      }
      if (blob.skip || typeof blob.text !== 'string') {
        res.status(409).json({ error: 'That file could not be read', code: 'EXPOSURE_CANDIDATE_GONE' });
        return;
      }

      /*
       * The project reference comes out of the same file, and `discoverProject`
       * rebuilds the origin from twenty validated letters rather than copying a
       * URL somebody put in a repository. Without one there is nothing to ask,
       * and that is reported rather than guessed at.
       */
      const project = discoverProject(blob.text);
      if (!project) {
        res.status(409).json({
          error: 'No project reference was found beside that key',
          code: 'EXPOSURE_PROBE_NO_PROJECT'
        });
        return;
      }

      const built = buildFindings({
        detection: detectInText({ text: blob.text }),
        path: finding.path, scope, commit: finding.commit,
        hmacKey: deps.keys.fingerprint, keyVersion: finding.fingerprintKeyVersion
      });
      const found = built.probes.find(item => item.fingerprint === fingerprint);
      if (!found) {
        res.status(409).json({ error: 'That credential is no longer at that location', code: 'EXPOSURE_CANDIDATE_GONE' });
        return;
      }

      /*
       * Minted here and spent immediately, with its own key: a grant to ask a
       * provider "is this credential yours" is not a grant to ask a project
       * "may the public read this table". It binds the probe to this candidate,
       * this repository, this commit, this project, this relation and these
       * columns in this order -- and the prober checks all of it, so it cannot
       * be called for anything other than what an operator named.
       */
      const candidate = revealForVerification(found);
      const issuedAt = new Date();
      const authorizationId = crypto.randomUUID();
      const authorization = signReadabilityAuthorization({
        hmacKey: deps.keys.readability,
        operation: READABILITY_OPERATIONS.PROBE,
        authorizationId,
        actorLogin: deps.retainedActor(req),
        scope,
        commit: finding.commit,
        candidateFingerprint: fingerprint,
        projectRef: project.projectRef,
        relation,
        projection,
        issuedAt: issuedAt.toISOString(),
        expiresAt: new Date(issuedAt.getTime() + 60_000).toISOString()
      });

      const record = await deps.probeReadability({
        candidate,
        anonKey: candidate.secret,
        authorization,
        authorizationKey: deps.keys.readability,
        actorLogin: deps.retainedActor(req),
        projectRef: project.projectRef,
        relation,
        projection,
        now: issuedAt.getTime()
      });

      /* Recorded whatever the answer, including the ones that never went out. */
      const stored = await store.recordReadabilityProbe({
        scope, identityKey, fingerprint,
        requestedBy: deps.retainedActor(req),
        authorizationId,
        record
      });
      res.status(201).json({
        probe: stored.probe,
        narration: describeProbe(record)
      });
    } catch (error) { exposureFailure(res, error); }
  });

  app.get('/api/repo/:owner/:repo/exposure/findings/:fingerprint/readability-probes', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('exposure.scan'), auth, governanceAccess('reader', OWN_WORK), async (req: Request, res: Response) => {
    try {
      const store = deps.exposureService();
      const probes = await store.listReadabilityProbes({
        scope: scopeOf(req),
        identityKey: identityOf(req),
        fingerprint: String(req.params.fingerprint || '').toLowerCase(),
        limit: Number.parseInt(String(req.query.limit || '20'), 10)
      });
      res.json({ probes: probes.map(item => ({ ...item, narration: describeProbe(item) })) });
    } catch (error) { exposureFailure(res, error); }
  });

  /*
   * Accepting the risk of a finding.
   *
   * This was gated on the capability being Supported, and that was wrong. It
   * performs no outbound request, uses no credential and changes nothing at the
   * provider: it records that a named person looked at a finding and decided it
   * was acceptable, and the finding stays listed under that disposition.
   *
   * What blocking it actually produced was a reader with a false positive -- a
   * documentation example, a deliberately public fixture token -- and no way to
   * triage it, so every scan re-reported it. A screen that cannot be cleared is
   * a screen people stop reading, which costs more than the thing the gate was
   * protecting.
   *
   * The meaningful control here is the role, and it stays: a repository reader
   * cannot wave away their own finding, and a governance administrator who does
   * has their name on it.
   */
  app.post('/api/repo/:owner/:repo/exposure/findings/:fingerprint/accept-risk', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('exposure.scan'), auth, governanceAccess('administrator'), governanceMutationContext('exposure.finding.accept-risk'), async (req: Request, res: Response) => {
    try {
      const store = deps.exposureService();
      const finding = await store.acceptRisk({
        scope: scopeOf(req),
        identityKey: identityOf(req),
        fingerprint: String(req.params.fingerprint || ''),
        actor: deps.retainedActor(req)
      });
      if (!finding) { res.status(404).json({ error: 'Not found', code: 'EXPOSURE_FINDING_NOT_FOUND' }); return; }
      res.status(201).json({ finding: exposureFindingPayload(finding) });
    } catch (error) { exposureFailure(res, error); }
  });
}
