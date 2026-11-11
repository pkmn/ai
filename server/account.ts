import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as querystring from 'querystring';

import type polka from 'polka';

import {
  type ActiveEntryView,
  type ArenaDB,
  type BotRow,
  type DeveloperRow,
  type FormatType,
  LADDERS_FILE,
  type LadderRow,
  SETTLED_MAX_SE,
  SETTLED_MIN_MATCHES,
  type SubmissionStatus,
  type VersionHistoryView,
  loadLadderPoolDirs,
} from '../db';
import {header, renderer} from '../static/build';
import {escapeHtml, renderTemplate, root} from '../static/util';

import {Auth} from './auth';
import {validateCompetitorTeams} from './teams';

export function deduceFormatType(downloadUrl: string): FormatType {
  const cleanPath = downloadUrl.split('?')[0].toLowerCase();
  if (
    cleanPath.endsWith('.tar.gz') ||
    cleanPath.endsWith('.tgz') ||
    cleanPath.endsWith('.tar.xz') ||
    cleanPath.endsWith('.txz') ||
    cleanPath.endsWith('.tar.zst') ||
    cleanPath.endsWith('.tzst')
  ) {
    return 'bundle';
  }
  return 'oci';
}

function deriveSecretKey(secret: string): Buffer {
  return Buffer.from(
    crypto.hkdfSync('sha256', secret, '', 'pkmn-arena-auth-token-v1', 32)
  );
}

export function encryptSecret(plaintext: string, secret: string): string {
  const key = deriveSecretKey(secret);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    iv.toString('base64url'),
    tag.toString('base64url'),
    encrypted.toString('base64url'),
  ].join('.');
}

export function decryptSecret(encoded: string, secret: string): string {
  const parts = encoded.split('.');
  if (parts.length !== 3) throw new Error('Invalid encrypted secret format');
  const key = deriveSecretKey(secret);
  const iv = Buffer.from(parts[0], 'base64url');
  const tag = Buffer.from(parts[1], 'base64url');
  const data = Buffer.from(parts[2], 'base64url');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

const REGISTER_ISSUE_URL = 'https://github.com/pkmn/ai/issues/new?template=register.yml';
const VERSION_RE = /^[A-Za-z0-9._-]{1,12}$/;
const SHA256_RE = /^[0-9a-fA-F]{64}$/;
const OCI_REF_RE = /^[A-Za-z0-9._/-]+(?::[A-Za-z0-9._-]+)?(?:@sha256:[0-9a-fA-F]{64})?$/;
const MAX_SUBMISSION_BYTES = 512 * 1024;
const RATE_LIMIT_WINDOW_S = 60;
const RATE_LIMIT_MAX_ATTEMPTS = 5;

const STYLE = fs.readFileSync(root('static', 'account.css'), 'utf8');
const TEMPLATE = fs.readFileSync(root('static', 'account.html'), 'utf8');

export interface AccountOptions {
  db: ArenaDB;
  auth: Auth;
  laddersFile?: string;
  poolDirsByLadder?: Map<string, string[]>;
  rateLimitMaxAttempts?: number;
  rateLimitWindowSeconds?: number;
  now?: () => number;
}

function readBody(req: http.IncomingMessage, maxBytes = MAX_SUBMISSION_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        reject(Object.assign(new Error('Submission payload exceeds 512 KB limit.'), {status: 413}));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendHtml(res: http.ServerResponse, status: number, html: string) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'private, no-store',
  });
  res.end(html);
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  payload: object,
  extraHeaders?: http.OutgoingHttpHeaders
) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'private, no-store',
    ...extraHeaders,
  });
  res.end(JSON.stringify(payload));
}

function redirect(res: http.ServerResponse, location: string, status = 302) {
  res.writeHead(status, {
    Location: location,
    'Cache-Control': 'private, no-store',
  });
  res.end();
}

function formatIsoDate(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

function renderActiveSection(entries: ActiveEntryView[]): string {
  if (!entries.length) {
    return `<section id="active">
      <h3><a href="#active" class="subtle">Active</a></h3>
      <p class="muted">No active versions on any ladder yet.</p>
    </section>`;
  }

  const rows = entries.map(e => {
    const isChampion = e.role === 'champion';
    const w = e.ww + e.wt;
    const l = e.ll + e.tl;
    const t = e.split;
    const elo = Math.round(e.rating_elo);
    const ci = Math.round(1.96 * e.rating_se);
    const settled = e.settled_at !== null || (
      e.rating_se <= SETTLED_MAX_SE && e.matches_played >= SETTLED_MIN_MATCHES
    );

    if (isChampion) {
      const rankCell = e.rank_current !== null
        ? `<strong>#${e.rank_current}</strong>`
        : '<span class="muted">—</span>';
      const statusCell = settled
        ? '<span class="yes">Settled</span>'
        : '<span class="muted">Provisional</span>';
      return `<tr>
        <td><tt>${escapeHtml(e.display_name)}</tt></td>
        <td><code><strong>${escapeHtml(e.version_str)}</strong></code></td>
        <td class="num">${rankCell}</td>
        <td class="num"><strong>${elo}</strong> <span class="muted">±${ci}</span></td>
        <td class="num">${w}–${l}–${t}</td>
        <td>${statusCell}</td>
      </tr>`;
    }

    return `<tr class="secondary">
      <td><tt>${escapeHtml(e.display_name)}</tt></td>
      <td><code>${escapeHtml(e.version_str)}</code></td>
      <td class="num muted">—</td>
      <td class="num">${elo} <span class="muted">±${ci}</span></td>
      <td class="num">${w}–${l}–${t}</td>
      <td>${settled ? 'Settled' : 'Provisional'}</td>
    </tr>`;
  }).join('');

  return `<section id="active">
    <h3><a href="#active" class="subtle">Active</a></h3>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Ladder</th>
            <th>Version</th>
            <th class="num">Rank</th>
            <th class="num">Elo</th>
            <th class="num">W–L–T</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </section>`;
}

function renderHistorySection(
  versions: VersionHistoryView[],
  ladderNameById: Map<string, string>
): string {
  if (!versions.length) {
    return `<section id="history">
      <h3><a href="#history" class="subtle">History</a></h3>
      <p class="muted">No versions submitted yet.</p>
    </section>`;
  }

  const rows = versions.map(v => {
    let ladderIds: string[] = [];
    try {
      const parsed = JSON.parse(v.ladders_json) as unknown;
      if (Array.isArray(parsed)) ladderIds = parsed.map(String);
    } catch {}
    const ladderLabels = ladderIds.map(id => ladderNameById.get(id) ?? id);
    const laddersStr = escapeHtml(ladderLabels.join(', '));

    const shortSha = `sha256:${v.sha256.slice(0, 4)}…${v.sha256.slice(-4)}`;
    const sizeMb = v.unpacked_bytes !== null
      ? Math.max(1, Math.round(v.unpacked_bytes / (1024 * 1024)))
      : null;
    const sizeNote = sizeMb !== null ? ` <span class="muted">(${sizeMb} MB)</span>` : '';
    const artifactCell = `<tt>${escapeHtml(shortSha)}</tt>${sizeNote}`;

    const isFullyActive = v.smoke_status === 'passed' &&
      v.active_ladder_names.length > 0 &&
      v.active_ladder_names.length >= ladderLabels.length;
    const isPartiallyActive = v.smoke_status === 'passed' &&
      v.active_ladder_names.length > 0 &&
      v.active_ladder_names.length < ladderLabels.length;
    const isRetired = v.smoke_status === 'passed' && v.active_ladder_names.length === 0;

    let smokeCell: string;
    if (v.smoke_status === 'pending_pull') {
      smokeCell = '<span class="muted">PENDING</span>';
    } else if (v.smoke_status === 'passed') {
      const passTag = isRetired ? '<span>PASS</span>' : '<span class="yes">PASS</span>';
      const statsParts: string[] = [];
      if (v.smoke_duration_ms !== null) {
        statsParts.push(`${(v.smoke_duration_ms / 1000).toFixed(1)}s`);
      }
      if (v.smoke_turn_ms !== null) {
        statsParts.push(`${v.smoke_turn_ms}ms/turn`);
      }
      if (v.smoke_peak_ram_mb !== null) {
        statsParts.push(`${v.smoke_peak_ram_mb.toLocaleString('en-US')} MiB`);
      }
      const statsSuffix = statsParts.length
        ? ` <span class="muted">(${escapeHtml(statsParts.join(' · '))})</span>`
        : '';
      smokeCell = `${passTag}${statsSuffix}`;
    } else {
      const label = v.smoke_status === 'quarantined' ? 'QUARANTINED' : 'FAIL';
      const dmNote = v.dm_sent ? ' <span class="muted">(DM sent)</span>' : '';
      const logDetails = v.smoke_error_log
        ? `<details class="smoke-log">
            <summary>Sandbox <tt>stderr</tt> log</summary>
            <pre><code>${escapeHtml(v.smoke_error_log)}</code></pre>
          </details>`
        : '';
      smokeCell = `<span class="no">${label}</span>${dmNote}${logDetails}`;
    }

    let stateCell: string;
    if (v.smoke_status === 'pending_pull') {
      stateCell = '<span class="muted">Pending</span>';
    } else if (v.smoke_status === 'failed_smoke_test') {
      stateCell = '<span class="muted">Rejected</span>';
    } else if (v.smoke_status === 'quarantined') {
      stateCell = '<span class="no">Quarantined</span>';
    } else if (isFullyActive) {
      stateCell = '<span class="yes">Active</span>';
    } else if (isPartiallyActive) {
      const activeList = escapeHtml(v.active_ladder_names.join(', '));
      stateCell = `Active <span class="muted">(${activeList})</span>`;
    } else {
      stateCell = '<span class="muted">Retired</span>';
    }

    const rowClass = isRetired ? ' class="secondary"' : '';
    const verHtml = isFullyActive
      ? `<code><strong>${escapeHtml(v.version_str)}</strong></code>`
      : `<code>${escapeHtml(v.version_str)}</code>`;

    return `<tr${rowClass}>
      <td>${verHtml}</td>
      <td><tt>${laddersStr}</tt></td>
      <td>${artifactCell}</td>
      <td>${smokeCell}</td>
      <td>${stateCell}</td>
      <td class="num muted">${formatIsoDate(v.created_at)}</td>
    </tr>`;
  }).join('');

  return `<section id="history">
    <h3><a href="#history" class="subtle">History</a></h3>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Version</th>
            <th>Ladders</th>
            <th>Artifact</th>
            <th>Smoke Test</th>
            <th>State</th>
            <th class="num">Submitted</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </section>`;
}

export function renderAccountPage(opts: {
  developer: DeveloperRow;
  bot: BotRow;
  hasProfilePage: boolean;
  status: SubmissionStatus;
  currentLadders: LadderRow[];
  needsTeamsLadders: LadderRow[];
  activeEntries: ActiveEntryView[];
  versions: VersionHistoryView[];
  allLadders: LadderRow[];
}): string {
  const {
    developer,
    bot,
    hasProfilePage,
    status,
    currentLadders,
    needsTeamsLadders,
    activeEntries,
    versions,
    allLadders,
  } = opts;

  const linkHref = '/auth/discord?intent=link&amp;return_to=%2Faccount%2F';
  const discordHtml = developer.discord_username
    ? `<span id="discord-view">
        <tt id="discord-val">@${escapeHtml(developer.discord_username)}</tt>
        <span class="muted">(<a href="${linkHref}" class="subtle">change</a> / ` +
        '<a href="#account" id="discord-unlink-btn" class="subtle">unlink</a>)</span>' +
      '</span>'
    : `<span id="discord-view">
        <span class="muted" id="discord-val">None</span>
        <span class="muted">(<a href="${linkHref}" class="subtle">link</a>)</span>
      </span>`;

  const projectHref = hasProfilePage
    ? `/leaderboard/${encodeURIComponent(bot.slug)}/`
    : `/projects/#${encodeURIComponent(bot.name.replaceAll(' ', ''))}`;

  const statusClass = status.label === 'Eligible'
    ? 'yes'
    : status.label === 'Ineligible' ? 'no' : 'muted';
  const statusTitle =
    status.reason ?? 'Submission status: Pending / Qualified / Eligible / Ineligible';

  const needsTeamsIds = new Set(needsTeamsLadders.map(l => l.id));
  const activeLadderIdsWithBot = new Set(activeEntries.map(e => e.ladder_id));
  const checkboxesHtml = currentLadders.map(l => {
    const isOpen = l.status === 'active';
    const checked = isOpen && activeLadderIdsWithBot.has(l.id) ? ' checked' : '';
    const disabled = isOpen ? '' : ' disabled';
    const needsTeams = isOpen && needsTeamsIds.has(l.id) ? ' data-needs-teams="true"' : '';
    const val = escapeHtml(l.id);
    const label = escapeHtml(l.display_name);
    const labelAttrs = isOpen
      ? ''
      : ' class="upcoming" title="Upcoming — not open for submissions yet"';
    return `<label${labelAttrs}><input type="checkbox" name="ladders" value="${val}"` +
      `${checked}${disabled}${needsTeams}> ${label}</label>`;
  }).join('\n            ');

  const firstPoolLadder = needsTeamsLadders[0];
  let vgcTeamsRowHtml = '';
  if (firstPoolLadder?.team_count) {
    const count = firstPoolLadder.team_count;
    const placeholder =
      `Paste ${count} Showdown teams (=== [format] Team Name ===) ` +
      '— locked for this seasonal ladder on first pass';
    vgcTeamsRowHtml =
      '<label for="sub-teams" class="vgc-teams-field hide">VGC Teams</label>\n' +
      '        <div class="vgc-teams-field hide">\n' +
      '          <textarea id="sub-teams" name="teams" class="input-text" ' +
      `spellcheck="false" placeholder="${placeholder}"></textarea>\n` +
      '          <div class="teams-tools">\n' +
      `            <span class="muted">Required once per season (${count} ` +
      'legal teams, 1-NN distance &ge; 1.30).</span>\n' +
      '            <label class="btn-subtle">Load .txt ' +
      '<input id="sub-teams-file" type="file" accept=".txt,text/plain" class="hide"></label>\n' +
      '          </div>\n' +
      '        </div>';
  }

  const ladderNameById = new Map(allLadders.map(l => [l.id, l.display_name]));
  const content = renderTemplate(TEMPLATE, {
    ghHref: `https://github.com/${encodeURIComponent(developer.github_login)}`,
    ghLogin: developer.github_login,
    discordHtml,
    projectHref,
    botName: bot.name,
    statusClass,
    statusTitle,
    statusLabel: status.label,
    activeSection: renderActiveSection(activeEntries),
    formDisabledClass: status.canSubmit ? '' : ' form-disabled',
    fieldsetDisabled: status.canSubmit ? '' : ' disabled',
    vgcTeamsRowHtml,
    checkboxesHtml,
    submitDisabled: status.canSubmit ? '' : ' disabled',
    submitTitleAttr: status.reason ? ` title="${escapeHtml(status.reason)}"` : '',
    statusNotice: !status.canSubmit && status.reason
      ? `<div id="sub-status" class="muted">${escapeHtml(status.reason)}</div>`
      : '<div id="sub-status" class="hide"></div>',
    historySection: renderHistorySection(versions, ladderNameById),
  });

  return renderer.render({
    id: 'account-page',
    title: 'Account | pkmn.ai',
    header: header('Account'),
    path: '/account/',
    style: STYLE,
    content,
  }, s => s.replace('</title>', '</title><meta name="robots" content="noindex">'));
}

function renderNotRegisteredError(login: string): string {
  return renderer.render({
    id: 'error',
    title: '403 | pkmn.ai',
    header: header('403'),
    path: '/account/',
    content:
      `<p>GitHub account <code>${escapeHtml(login)}</code> ` +
      'is not registered to an approved pkmn.ai Arena project.</p>' +
      `<p><a href="${REGISTER_ISSUE_URL}">Request project registration on GitHub</a>.</p>`,
    style: `
      #error h2 { text-decoration: none; font-size: 20vh; margin: 0; }
      #error main { font-size: 1.2em; position: relative; top: -4vh; text-align: center; }`,
  }, s => s.replace('</title>', '</title><meta name="robots" content="noindex">'));
}

function parseSubmissionPayload(
  rawBody: string,
  contentType: string | undefined
): {
  version: string;
  formatType?: string;
  downloadUrl: string;
  sha256: string;
  authToken: string;
  ladders: string[];
  teams?: string | string[];
} {
  if (contentType?.includes('application/json')) {
    const json = JSON.parse(rawBody || '{}') as Record<string, unknown>;
    const rawLadders = json.ladders;
    const ladders = Array.isArray(rawLadders)
      ? rawLadders.map(v => String(v ?? '').trim()).filter(Boolean)
      : typeof rawLadders === 'string' && rawLadders.trim()
        ? [rawLadders.trim()]
        : [];
    const rawTeams = json.teams;
    const teams = Array.isArray(rawTeams)
      ? rawTeams.map(String)
      : typeof rawTeams === 'string' ? rawTeams : undefined;
    return {
      version: typeof json.version === 'string' ? json.version.trim() : '',
      formatType: typeof json.format_type === 'string' ? json.format_type.trim() : undefined,
      downloadUrl: typeof json.download_url === 'string' ? json.download_url.trim() : '',
      sha256: typeof json.sha256 === 'string' ? json.sha256.trim() : '',
      authToken: typeof json.auth_token === 'string' ? json.auth_token.trim() : '',
      ladders,
      teams,
    };
  }

  const parsed = querystring.parse(rawBody);
  const str = (v: string | string[] | undefined) =>
    (Array.isArray(v) ? v[0] : v ?? '').trim();
  const rawLadders = parsed.ladders;
  const ladders = Array.isArray(rawLadders)
    ? rawLadders.map(s => s.trim()).filter(Boolean)
    : typeof rawLadders === 'string' && rawLadders.trim()
      ? [rawLadders.trim()]
      : [];

  return {
    version: str(parsed.version),
    formatType: str(parsed.format_type) || undefined,
    downloadUrl: str(parsed.download_url),
    sha256: str(parsed.sha256),
    authToken: str(parsed.auth_token),
    ladders,
    teams: parsed.teams !== undefined ? str(parsed.teams) : undefined,
  };
}

function validateDownloadUrl(downloadUrl: string, formatType: FormatType): string | undefined {
  if (!downloadUrl || /\s/.test(downloadUrl)) {
    return 'Artifact URL must not be empty or contain whitespace.';
  }
  const deduced = deduceFormatType(downloadUrl);
  if (deduced !== formatType) {
    return formatType === 'bundle'
      ? 'Bundle Artifact URL must end in .tar.gz, .tgz, .tar.xz, .txz, .tar.zst, or .tzst.'
      : 'OCI image reference must not point to a .tar.{gz,xz,zst} archive.';
  }
  if (formatType === 'bundle') {
    let parsed: URL;
    try {
      parsed = new URL(downloadUrl);
    } catch {
      return 'Bundle Artifact URL must be a valid URL.';
    }
    const allowHttp = process.env.NODE_ENV !== 'production';
    if (parsed.protocol !== 'https:' && !(allowHttp && parsed.protocol === 'http:')) {
      return 'Bundle Artifact URL must use HTTPS.';
    }
    return undefined;
  }

  if (downloadUrl.startsWith('http://') || downloadUrl.startsWith('https://')) {
    return (
      'OCI image reference must be a registry reference ' +
      '(e.g. ghcr.io/org/bot:1.0.0), not an HTTP URL.'
    );
  }
  if (!OCI_REF_RE.test(downloadUrl) || !downloadUrl.includes('/')) {
    return 'Invalid OCI image reference (expected e.g. ghcr.io/org/bot:1.0.0).';
  }
  return undefined;
}

export function register(app: polka.Polka, options: AccountOptions) {
  const {db, auth} = options;
  const getNow = options.now ?? (() => Math.floor(Date.now() / 1000));
  const getPoolDirs = () =>
    options.poolDirsByLadder ?? loadLadderPoolDirs(options.laddersFile ?? LADDERS_FILE);
  const maxAttempts = options.rateLimitMaxAttempts ?? RATE_LIMIT_MAX_ATTEMPTS;
  const windowSeconds = options.rateLimitWindowSeconds ?? RATE_LIMIT_WINDOW_S;
  const attemptsByBot = new Map<number, number[]>();

  const checkSubmissionRateLimit = (botId: number, now: number): number | undefined => {
    const cutoff = now - windowSeconds;
    const recent = (attemptsByBot.get(botId) ?? []).filter(ts => ts > cutoff);
    if (recent.length >= maxAttempts) {
      attemptsByBot.set(botId, recent);
      return Math.max(1, recent[0] + windowSeconds - now);
    }
    recent.push(now);
    attemptsByBot.set(botId, recent);
    return undefined;
  };

  app.get('/account', (req, res) => {
    const login = auth.getGitHubUser(req);
    if (!login) {
      redirect(res, '/auth/github?return_to=%2Faccount%2F');
      return;
    }

    const developer = db.getDeveloperByGitHub(login);
    const bot = developer ? db.getBotById(developer.bot_id) : undefined;
    if (!developer || !bot || bot.status === 'disabled') {
      sendHtml(res, 403, renderNotRegisteredError(login));
      return;
    }

    const now = getNow();
    const currentLadders = db.getCurrentLadders();
    const needsTeamsLadders = currentLadders.filter(
      l => l.status === 'active' &&
        l.team_mode === 'competitor_pool' &&
        !db.hasActiveLadderTeams(l.id, bot.id)
    );

    const html = renderAccountPage({
      developer,
      bot,
      hasProfilePage: db.hasAnyLeaderboardEntry(bot.id),
      status: db.computeBotSubmissionStatus(bot.id, now),
      currentLadders,
      needsTeamsLadders,
      activeEntries: db.getActiveEntriesForBot(bot.id),
      versions: db.getVersionsForBot(bot.id),
      allLadders: db.getLadders(),
    });
    sendHtml(res, 200, html);
  });

  app.post('/api/submissions', async (req, res) => {
    const login = auth.getGitHubUser(req);
    if (!login) {
      sendJson(res, 401, {error: 'GitHub authentication required.'});
      return;
    }

    const developer = db.getDeveloperByGitHub(login);
    const bot = developer ? db.getBotById(developer.bot_id) : undefined;
    if (!developer || !bot || bot.status === 'disabled') {
      sendJson(res, 403, {error: 'GitHub account is not registered to an Arena project.'});
      return;
    }

    const now = getNow();
    const eligibility = db.computeBotSubmissionStatus(bot.id, now);
    if (!eligibility.canSubmit) {
      const code = eligibility.label === 'Pending' || eligibility.label === 'Qualified'
        ? 403
        : 429;
      sendJson(res, code, {error: eligibility.reason ?? 'Not currently eligible to submit.'});
      return;
    }

    const retryAfter = checkSubmissionRateLimit(bot.id, now);
    if (retryAfter !== undefined) {
      sendJson(
        res,
        429,
        {error: `Too many submission attempts; wait ${retryAfter}s before retrying.`},
        {'Retry-After': String(retryAfter)}
      );
      return;
    }

    let payload: ReturnType<typeof parseSubmissionPayload>;
    try {
      const rawBody = await readBody(req);
      payload = parseSubmissionPayload(rawBody, req.headers['content-type']);
    } catch (err: any) {
      sendJson(res, err?.status ?? 400, {error: err?.message || 'Malformed request body.'});
      return;
    }

    if (!VERSION_RE.test(payload.version)) {
      sendJson(res, 400, {
        error: 'Invalid version string (must match ^[A-Za-z0-9._-]{1,12}$).',
      });
      return;
    }

    const formatType: FormatType = payload.formatType === 'bundle' || payload.formatType === 'oci'
      ? payload.formatType
      : deduceFormatType(payload.downloadUrl);
    if (payload.formatType && payload.formatType !== 'bundle' && payload.formatType !== 'oci') {
      sendJson(res, 400, {error: 'Invalid format_type (expected "bundle" or "oci").'});
      return;
    }

    const urlErr = validateDownloadUrl(payload.downloadUrl, formatType);
    if (urlErr) {
      sendJson(res, 400, {error: urlErr});
      return;
    }

    if (!SHA256_RE.test(payload.sha256)) {
      sendJson(res, 400, {error: 'Invalid sha256 (must be a 64-character hex digest).'});
      return;
    }
    const sha256 = payload.sha256.toLowerCase();

    if (!payload.ladders.length) {
      sendJson(res, 400, {error: 'Select at least one active ladder.'});
      return;
    }

    const activeLadders = db.getActiveLadders();
    const byId = new Map(activeLadders.map(l => [l.id.toLowerCase(), l]));
    const bySlot = new Map(activeLadders.map(l => [l.slot.toLowerCase(), l]));
    const byName = new Map(activeLadders.map(l => [l.display_name.toLowerCase(), l]));

    const selectedLadders: LadderRow[] = [];
    const seenLadderIds = new Set<string>();
    for (const raw of payload.ladders) {
      const key = raw.toLowerCase();
      const ladder = byId.get(key) ?? bySlot.get(key) ?? byName.get(key);
      if (!ladder) {
        sendJson(res, 400, {error: `Unknown or inactive ladder "${raw}".`});
        return;
      }
      if (!seenLadderIds.has(ladder.id)) {
        seenLadderIds.add(ladder.id);
        selectedLadders.push(ladder);
      }
    }

    const poolDirsMap = getPoolDirs();
    const teamsByLadder: Record<string, string[]> = {};
    const hasSubmittedTeams = Array.isArray(payload.teams)
      ? payload.teams.some(t => t.trim().length > 0)
      : Boolean(payload.teams?.trim());

    const competitorPoolLadders = selectedLadders.filter(l => l.team_mode === 'competitor_pool');
    if (!competitorPoolLadders.length && hasSubmittedTeams) {
      sendJson(res, 400, {
        error: 'Custom team pools are only accepted when entering a seasonal VGC ladder.',
      });
      return;
    }

    for (const ladder of competitorPoolLadders) {
      const requiredTeams = ladder.team_count!;
      const alreadyLocked = db.hasActiveLadderTeams(ladder.id, bot.id);
      if (alreadyLocked) {
        if (hasSubmittedTeams) {
          sendJson(res, 400, {
            error:
              `Your ${requiredTeams} teams for ${ladder.display_name} (${ladder.id}) ` +
              'are already locked for this season; omit teams to reuse your locked pool.',
          });
          return;
        }
        continue;
      }

      if (!hasSubmittedTeams || !payload.teams) {
        sendJson(res, 400, {
          error:
            `First submission to ${ladder.display_name} requires ${requiredTeams} ` +
            'valid teams passing the 1.30 uniqueness threshold.',
        });
        return;
      }

      try {
        const poolDirs = poolDirsMap.get(ladder.id) ?? [];
        teamsByLadder[ladder.id] = validateCompetitorTeams(payload.teams, {
          formatId: ladder.format_id,
          poolDirs,
          teamCount: requiredTeams,
        });
      } catch (err: any) {
        sendJson(res, 400, {error: err?.message || 'Team pool validation failed.'});
        return;
      }
    }

    let authTokenEnc: string | null = null;
    if (payload.authToken) {
      const secret = auth.getConfig()?.sessionSecret;
      if (!secret) {
        sendJson(res, 503, {error: 'SESSION_SECRET is required to encrypt auth_token.'});
        return;
      }
      authTokenEnc = encryptSecret(payload.authToken, secret);
    }

    try {
      const created = db.createSubmission({
        botId: bot.id,
        submittedByDevId: developer.id,
        versionStr: payload.version,
        formatType,
        downloadUrl: payload.downloadUrl,
        sha256,
        authTokenEnc,
        ladderIds: selectedLadders.map(l => l.id),
        teamsByLadder: Object.keys(teamsByLadder).length ? teamsByLadder : undefined,
        now,
      });

      if (req.headers.accept?.includes('application/json')) {
        sendJson(res, 201, {
          ok: true,
          version_id: created.id,
          version: created.version_str,
          smoke_status: created.smoke_status,
        });
        return;
      }
      redirect(res, '/account/', 303);
    } catch (err: any) {
      sendJson(res, err?.status ?? 500, {error: err?.message || 'Failed to save submission.'});
    }
  });
}
