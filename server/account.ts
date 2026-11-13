import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as querystring from 'querystring';

import polka from 'polka';

import {LADDERS_FILE, SETTLED_MAX_SE, SETTLED_MIN_MATCHES, loadLadderPools} from '../db';
import type * as db from '../db';
import {header, injectLiveBanner, renderer} from '../static/build';
import {
  VERSION_RE,
  escapeHtml,
  formatUtcDate,
  formatUtcDateTime,
  renderTemplate,
  root,
} from '../static/util';

import {Auth, isCrossSiteRequest} from './auth';
import {
  RejectedTeam,
  splitSubmittedTeams,
  validateCompetitorTeamsIncremental,
} from './teams';

export function deducePackageFormat(url: string): db.PackageFormat {
  const cleanPath = url.split('?')[0].toLowerCase();
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

// One-time private artifact pull tokens (e.g. scoped GitHub Release / R2 / GHCR headers) are
// encrypted at rest in SQLite with AES-256-GCM under an HKDF-derived subkey of `SESSION_SECRET`.
// The Mac mini runner decrypts the header once via `/api/arena/pending-submissions` and the server
// wipes `auth_token_encoding = NULL` as soon as `/api/arena/submission-status` reports back.
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
const SHA256_RE = /^[0-9a-fA-F]{64}$/;
const OCI_REF_RE = new RegExp(
  '^[A-Za-z0-9._-]+(?::\\d{1,5})?/[A-Za-z0-9._/-]+' +
  '(?::[A-Za-z0-9._-]+)?(?:@sha256:[0-9a-fA-F]{64})?$'
);
const MAX_SUBMISSION_BYTES = 512 * 1024;
const RATE_LIMIT_WINDOW_SECONDS = 60;
const RATE_LIMIT_MAX_ATTEMPTS = 5;

const STYLE = fs.readFileSync(root('static', 'account.css'), 'utf8');
const TEMPLATE = fs.readFileSync(root('static', 'account.html'), 'utf8');

export interface Options {
  db: db.Database;
  auth: Auth;
  laddersFile?: string;
  poolsByLadder?: Map<string, string[]>;
  rateLimitMaxAttempts?: number;
  rateLimitWindowSeconds?: number;
  allowPrivateUrls?: boolean;
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

function renderActiveSection(entries: db.ActiveEntryView[]): string {
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
    const elo = Math.round(e.elo);
    const ci = Math.round(1.96 * e.se);
    const settled = e.settledAt !== undefined || (
      e.se <= SETTLED_MAX_SE && e.matches >= SETTLED_MIN_MATCHES
    );

    if (isChampion) {
      const rankCell = e.rankCurrent !== undefined
        ? `<strong>#${e.rankCurrent}</strong>`
        : '<span class="muted">—</span>';
      const statusCell = settled
        ? '<span class="yes">Settled</span>'
        : '<span class="muted">Provisional</span>';
      return `<tr>
        <td><tt>${escapeHtml(e.ladderName)}</tt></td>
        <td><code><strong>${escapeHtml(e.version)}</strong></code></td>
        <td class="num">${rankCell}</td>
        <td class="num"><strong>${elo}</strong> <span class="muted">±${ci}</span></td>
        <td class="num">${w}–${l}–${t}</td>
        <td>${statusCell}</td>
      </tr>`;
    }

    return `<tr class="secondary">
      <td><tt>${escapeHtml(e.ladderName)}</tt></td>
      <td><code>${escapeHtml(e.version)}</code></td>
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
  versions: db.VersionHistoryView[],
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
      const parsed = JSON.parse(v.laddersJson) as unknown;
      if (Array.isArray(parsed)) ladderIds = parsed.map(String);
    } catch {}
    const ladderLabels = ladderIds.map(id => escapeHtml(ladderNameById.get(id) ?? id));
    const tourneyLabels = (v.tournamentNames ?? []).map(name => {
      const m = /^Tournament #(\d+)/.exec(name);
      return m ? `<span title="${escapeHtml(name)}">T#${m[1]}</span>` : escapeHtml(name);
    });
    const laddersStr = [...ladderLabels, ...tourneyLabels].join(', ');

    const shortSha = `sha256:${v.sha256.slice(0, 4)}…${v.sha256.slice(-4)}`;
    const sizeMb = v.unpackedBytes !== undefined
      ? Math.max(1, Math.round(v.unpackedBytes / (1024 * 1024)))
      : undefined;
    const sizeNote = sizeMb !== undefined ? ` <span class="muted">(${sizeMb} MB)</span>` : '';
    const artifactCell = `<tt>${escapeHtml(shortSha)}</tt>${sizeNote}`;

    const isTournamentOnly = ladderLabels.length === 0 && (v.tournamentNames?.length ?? 0) > 0;
    const isFullyActive = v.smokeStatus === 'passed' && (
      isTournamentOnly || (
        v.activeLadderNames.length > 0 &&
        v.activeLadderNames.length >= ladderLabels.length
      )
    );
    const isPartiallyActive = !isTournamentOnly &&
      v.smokeStatus === 'passed' &&
      v.activeLadderNames.length > 0 &&
      v.activeLadderNames.length < ladderLabels.length;
    const isRetired = !isTournamentOnly &&
      v.smokeStatus === 'passed' &&
      v.activeLadderNames.length === 0;

    let smokeCell: string;
    if (v.smokeStatus === 'pending') {
      smokeCell = '<span class="muted">PENDING</span>';
    } else if (v.smokeStatus === 'passed') {
      const passTag = isRetired ? '<span>PASS</span>' : '<span class="yes">PASS</span>';
      const statsParts: string[] = [];
      if (v.smokeDurationMillis !== undefined) {
        statsParts.push(`${(v.smokeDurationMillis / 1000).toFixed(1)}s`);
      }
      if (v.smokeTurnMillis !== undefined) {
        statsParts.push(`${v.smokeTurnMillis}ms/turn`);
      }
      if (v.smokePeakRam !== undefined) {
        statsParts.push(`${v.smokePeakRam.toLocaleString('en-US')} MiB`);
      }
      const statsSuffix = statsParts.length
        ? ` <span class="muted">(${escapeHtml(statsParts.join(' · '))})</span>`
        : '';
      smokeCell = `${passTag}${statsSuffix}`;
    } else {
      const label = v.smokeStatus === 'quarantined' ? 'QUARANTINED' : 'FAIL';
      const dmNote = v.notified ? ' <span class="muted">(DM sent)</span>' : '';
      const logDetails = v.smokeError
        ? `<details class="smoke-log">
            <summary>Sandbox <tt>stderr</tt> log</summary>
            <pre><code>${escapeHtml(v.smokeError)}</code></pre>
          </details>`
        : '';
      smokeCell = `<span class="no">${label}</span>${dmNote}${logDetails}`;
    }

    let stateCell: string;
    if (v.smokeStatus === 'pending') {
      stateCell = '<span class="muted">Pending</span>';
    } else if (v.smokeStatus === 'failed') {
      stateCell = '<span class="muted">Rejected</span>';
    } else if (v.smokeStatus === 'quarantined') {
      stateCell = '<span class="no">Quarantined</span>';
    } else if (isFullyActive) {
      stateCell = isTournamentOnly
        ? '<span class="yes">Entered</span>'
        : '<span class="yes">Active</span>';
    } else if (isPartiallyActive) {
      const activeList = escapeHtml(v.activeLadderNames.join(', '));
      stateCell = `Active <span class="muted">(${activeList})</span>`;
    } else {
      stateCell = '<span class="muted">Retired</span>';
    }

    const rowClass = isRetired ? ' class="secondary"' : '';
    const verHtml = isFullyActive
      ? `<code><strong>${escapeHtml(v.version)}</strong></code>`
      : `<code>${escapeHtml(v.version)}</code>`;

    return `<tr${rowClass}>
      <td>${verHtml}</td>
      <td><tt>${laddersStr}</tt></td>
      <td>${artifactCell}</td>
      <td>${smokeCell}</td>
      <td>${stateCell}</td>
      <td class="num muted">${formatIsoDate(v.submittedAt)}</td>
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
  developer: db.DeveloperRow;
  agent: db.AgentRow;
  status: db.SubmissionStatus;
  tournamentStatuses?: db.TournamentSubmissionStatus[];
  currentLadders: db.LadderRow[];
  needsTeamsLadders: db.LadderRow[];
  savedTeamsByLadder?: Map<string, number>;
  activeEntries: db.ActiveEntryView[];
  versions: db.VersionHistoryView[];
  allLadders: db.LadderRow[];
  liveTournament?: {id: string; name: string};
  now?: number;
}): string {
  const {
    developer,
    agent,
    status,
    tournamentStatuses = [],
    currentLadders,
    needsTeamsLadders,
    savedTeamsByLadder = new Map<string, number>(),
    activeEntries,
    versions,
    allLadders,
    liveTournament,
    now = Math.floor(Date.now() / 1000),
  } = opts;

  const linkHref = '/auth/discord?intent=link&amp;return_to=%2Faccount%2F';
  const discordHtml = developer.discordUsername
    ? `<span id="discord-view">
        <tt id="discord-val">@${escapeHtml(developer.discordUsername)}</tt>
        <span class="muted">(<a href="${linkHref}" class="subtle">change</a> / ` +
        '<a href="#account" id="discord-unlink-btn" class="subtle">unlink</a>)</span>' +
      '</span>'
    : `<span id="discord-view">
        <span class="muted" id="discord-val">None</span>
        <span class="muted">(<a href="${linkHref}" class="subtle">link</a>)</span>
      </span>`;

  const projectHref = `/projects/${encodeURIComponent(agent.slug)}/`;

  // 'pending' projects cannot submit to continuous ladders (`status.canSubmit === false`), but are
  // intentionally allowed to enter scheduled tournaments (`canSubmitTourney === true`).
  const canSubmitTourney = tournamentStatuses.some(t => t.canSubmit);
  const canSubmitAny = status.canSubmit || canSubmitTourney;

  const statusClass = status.label === 'Eligible'
    ? 'yes'
    : status.label === 'Ineligible' ? 'no' : 'muted';
  const statusTitle =
    status.reason ?? 'Submission status: Pending / Qualified / Eligible / Ineligible';

  const needsTeamsIds = new Set(needsTeamsLadders.map(l => l.id));
  const activeLadderIdsWithAgent = new Set(activeEntries.map(e => e.ladderId));
  const checkboxesHtml = currentLadders.map(l => {
    const isOpen = l.status === 'upcoming' || l.status === 'active';
    const canCheck = isOpen && status.canSubmit;
    const checked = canCheck && activeLadderIdsWithAgent.has(l.id) ? ' checked' : '';
    const disabled = canCheck ? '' : ' disabled';
    const needsTeams = needsTeamsIds.has(l.id);
    const savedCount = savedTeamsByLadder.get(l.id) ?? 0;
    const requiredCount = l.teams ?? 0;
    const teamAttrs = canCheck && needsTeams
      ? ` data-needs-teams="true" data-required-teams="${requiredCount}" ` +
        `data-saved-teams="${savedCount}" data-ladder-name="${escapeHtml(l.name)}" ` +
        `data-upcoming="${l.status === 'upcoming' ? 'true' : 'false'}"`
      : '';
    const val = escapeHtml(l.id);
    const label = escapeHtml(l.name);
    let labelAttrs = '';
    if (!isOpen) {
      labelAttrs = ' class="upcoming" title="Not open for submissions"';
    } else if (!status.canSubmit) {
      const reasonAttr = escapeHtml(status.reason ?? 'Not currently eligible for ladders');
      labelAttrs = ` class="upcoming" title="${reasonAttr}"`;
    } else if (l.status === 'upcoming') {
      labelAttrs = ' title="Upcoming — accepting initial entries before matchmaking begins"';
    }
    const statusParts: string[] = [];
    if (l.status === 'upcoming') statusParts.push('upcoming');
    if (needsTeams && requiredCount > 0 && savedCount > 0) {
      statusParts.push(`${savedCount}/${requiredCount} saved`);
    }
    const hintText = statusParts.length ? ` (${escapeHtml(statusParts.join(' · '))})` : '';
    const statusHint = needsTeams
      ? `<span class="muted pool-status-hint">${hintText}</span>`
      : hintText ? `<span class="muted">${hintText}</span>` : '';
    return `<label${labelAttrs}><input type="checkbox" name="ladders" value="${val}"` +
      `${checked}${disabled}${teamAttrs}> ${label}${statusHint}</label>`;
  }).join('\n            ');

  let tournamentsRowHtml = '';
  if (tournamentStatuses.length) {
    const tourneyChecksHtml = tournamentStatuses.map(t => {
      const val = escapeHtml(t.tournamentId);
      const name = escapeHtml(t.name);
      const scheduleHint =
        `starts ${formatUtcDate(t.startsAt)} · entries close ${formatUtcDateTime(t.closesAt)}`;
      if (t.canSubmit) {
        const checked = !status.canSubmit && tournamentStatuses.length === 1 ? ' checked' : '';
        const title =
          `OCI image required (linux/amd64); ${scheduleHint}`;
        return `<label title="${escapeHtml(title)}"><input type="checkbox" name="tournaments" ` +
          `value="${val}"${checked}> ${name} <span class="muted">(OCI · ` +
          `closes ${escapeHtml(formatUtcDateTime(t.closesAt))})</span></label>`;
      }
      const badge = t.enteredVersion
        ? `entered: ${escapeHtml(t.enteredVersion)}`
        : t.pendingVersion
          ? `pending: ${escapeHtml(t.pendingVersion)}`
          : now >= t.closesAt
            ? 'entries closed'
            : 'closed';
      const titleAttr = t.reason ? ` title="${escapeHtml(t.reason)}"` : '';
      return `<label class="upcoming"${titleAttr}><input type="checkbox" name="tournaments" ` +
        `value="${val}" disabled> ${name} <span class="muted">(${badge})</span></label>`;
    }).join('\n            ');
    tournamentsRowHtml =
      '<label>Tournaments</label>\n' +
      '        <div class="check-group">\n' +
      `          ${tourneyChecksHtml}\n` +
      '        </div>';
  }

  const firstPoolLadder = needsTeamsLadders[0];
  let poolTeamsRowHtml = '';
  if (firstPoolLadder?.teams && status.canSubmit) {
    const count = firstPoolLadder.teams;
    const saved = savedTeamsByLadder.get(firstPoolLadder.id) ?? 0;
    const remaining = Math.max(0, count - saved);
    const pct = count > 0 ? Math.min(100, Math.round((saved / count) * 100)) : 0;
    const progressText = remaining === 0
      ? `<strong>${saved} / ${count}</strong> distinct teams saved &mdash; ready to submit`
      : `<strong>${saved} / ${count}</strong> distinct teams saved &mdash; ` +
        `${remaining} more needed`;
    const placeholder =
      `Paste up to ${count} Showdown teams (=== [format] Team Name ===) — ` +
      'valid distinct teams save immediately; locked for this season once your build passes';
    const clearHide = saved > 0 ? '' : ' hide';
    poolTeamsRowHtml =
      '<label for="sub-teams" class="pool-teams-field hide">Teams</label>\n' +
      '        <div class="pool-teams-field hide" id="pool-teams-panel">\n' +
      '          <div class="teams-progress" id="pool-progress-box">\n' +
      '            <div class="teams-progress-head">\n' +
      `              <span id="pool-progress-text">${progressText}</span>\n` +
      '              <span class="muted">1-NN &ge; 1.30</span>\n' +
      '            </div>\n' +
      '            <div class="progress-track"><div class="progress-fill" ' +
      `id="pool-progress-fill" style="width:${pct}%"></div></div>\n` +
      '          </div>\n' +
      '          <textarea id="sub-teams" name="teams" class="input-text" ' +
      `spellcheck="false" placeholder="${placeholder}"></textarea>\n` +
      '          <div class="teams-tools">\n' +
      '            <span class="muted">Paste all teams or add remaining ones in ' +
      'batches.</span>\n' +
      '            <div class="teams-actions">\n' +
      '              <label class="btn-subtle">Load .txt ' +
      '<input id="sub-teams-file" type="file" accept=".txt,text/plain" class="hide"></label>\n' +
      '              <button type="button" id="validate-teams-btn" class="btn-subtle">' +
      'Validate &amp; Save Teams</button>\n' +
      `              <button type="button" id="clear-teams-btn" class="btn-subtle${clearHide}">` +
      'Clear Saved</button>\n' +
      '            </div>\n' +
      '          </div>\n' +
      '          <div id="teams-feedback" class="teams-feedback hide">' +
      '<div id="teams-feedback-summary"></div>' +
      '<ul id="teams-rejections" class="teams-rejections"></ul></div>\n' +
      '        </div>';
  }

  let statusNotice = '<div id="sub-status" class="hide"></div>';
  if (!canSubmitAny && status.reason) {
    statusNotice = `<div id="sub-status" class="muted">${escapeHtml(status.reason)}</div>`;
  } else if (!status.canSubmit && canSubmitTourney && status.reason) {
    statusNotice =
      `<div id="sub-status" class="muted">Ladders: ${escapeHtml(status.reason)} ` +
      'Tournament registration remains open above (1 OCI entry per project).</div>';
  }

  const ladderNameById = new Map(allLadders.map(l => [l.id, l.name]));
  const content = renderTemplate(TEMPLATE, {
    ghHref: `https://github.com/${encodeURIComponent(developer.githubLogin)}`,
    ghLogin: developer.githubLogin,
    discordHtml,
    projectHref,
    projectName: agent.name,
    statusClass,
    statusTitle,
    statusLabel: status.label,
    activeSection: renderActiveSection(activeEntries),
    formDisabledClass: canSubmitAny ? '' : ' form-disabled',
    fieldsetDisabled: canSubmitAny ? '' : ' disabled',
    poolTeamsRowHtml,
    tournamentsRowHtml,
    checkboxesHtml,
    submitDisabled: canSubmitAny ? '' : ' disabled',
    submitTitleAttr: !canSubmitAny && status.reason ? ` title="${escapeHtml(status.reason)}"` : '',
    statusNotice,
    historySection: renderHistorySection(versions, ladderNameById),
  });

  return renderer.render({
    id: 'account-page',
    title: 'Account | pkmn.ai',
    header: injectLiveBanner(header('Account'), liveTournament),
    path: '/account/',
    style: STYLE,
    content,
  }, s => s.replace('</title>', '</title><meta name="robots" content="noindex">'));
}

function renderNotRegisteredError(
  login: string,
  liveTournament?: {id: string; name: string}
): string {
  return renderer.render({
    id: 'error',
    title: '403 | pkmn.ai',
    header: injectLiveBanner(header('403'), liveTournament),
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
  packageFormat?: string;
  url: string;
  sha256: string;
  authToken: string;
  ladders: string[];
  tournaments: string[];
  teams?: string | string[];
} {
  const parseList = (raw: unknown): string[] => {
    if (Array.isArray(raw)) {
      return raw.map(v => String(v ?? '').trim()).filter(Boolean);
    }
    return typeof raw === 'string' && raw.trim() ? [raw.trim()] : [];
  };

  if (contentType?.includes('application/json')) {
    const json = JSON.parse(rawBody || '{}') as Record<string, unknown>;
    const rawTeams = json.teams;
    const teams = Array.isArray(rawTeams)
      ? rawTeams.map(String)
      : typeof rawTeams === 'string' ? rawTeams : undefined;
    return {
      version: typeof json.version === 'string' ? json.version.trim() : '',
      packageFormat: typeof json.package === 'string' ? json.package.trim() : undefined,
      url: typeof json.url === 'string' ? json.url.trim() : '',
      sha256: typeof json.sha256 === 'string' ? json.sha256.trim() : '',
      authToken: typeof json.authToken === 'string' ? json.authToken.trim() : '',
      ladders: parseList(json.ladders),
      tournaments: parseList(json.tournaments),
      teams,
    };
  }

  const parsed = querystring.parse(rawBody);
  const str = (v: string | string[] | undefined) =>
    (Array.isArray(v) ? v[0] : v ?? '').trim();

  return {
    version: str(parsed.version),
    packageFormat: str(parsed.package) || undefined,
    url: str(parsed.url),
    sha256: str(parsed.sha256),
    authToken: str(parsed.authToken),
    ladders: parseList(parsed.ladders),
    tournaments: parseList(parsed.tournaments),
    teams: parsed.teams !== undefined ? str(parsed.teams) : undefined,
  };
}

// Rejects loopback, unspecified, link-local (AWS/GCP/Linode 169.254.169.254 metadata), and
// RFC1918 / IPv6 ULA targets so a competitor cannot trick the Mac mini runner into fetching from
// its own LAN, SSH tunnel ports, or cloud metadata endpoints when pulling a bundle archive.
export function isPrivateOrLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    return true;
  }

  const mappedIpv4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(host);
  const candidate = mappedIpv4 ? mappedIpv4[1] : host;

  const ipVer = net.isIP(candidate);
  if (ipVer === 4) {
    const parts = candidate.split('.').map(Number);
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }

  if (ipVer === 6) {
    if (candidate === '::' || candidate === '::1') return true;
    if (/^f[cd][0-9a-f]{2}:/i.test(candidate)) return true; // fc00::/7 ULA
    if (/^fe[89ab][0-9a-f]:/i.test(candidate)) return true; // fe80::/10 link-local
    return false;
  }

  return false;
}

export function validateArtifactUrl(
  url: string,
  packageFormat: db.PackageFormat,
  allowPrivateUrls = false
): string | undefined {
  if (!url || /\s/.test(url)) {
    return 'Artifact URL must not be empty or contain whitespace.';
  }
  const deduced = deducePackageFormat(url);
  if (deduced !== packageFormat) {
    return packageFormat === 'bundle'
      ? 'Bundle Artifact URL must end in .tar.gz, .tgz, .tar.xz, .txz, .tar.zst, or .tzst.'
      : 'OCI image reference must not point to a .tar.{gz,xz,zst} archive.';
  }
  if (packageFormat === 'bundle') {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return 'Bundle Artifact URL must be a valid URL.';
    }
    const allowHttp = process.env.NODE_ENV !== 'production';
    if (parsed.protocol !== 'https:' && !(allowHttp && parsed.protocol === 'http:')) {
      return 'Bundle Artifact URL must use HTTPS.';
    }
    if (!allowPrivateUrls && isPrivateOrLoopbackHost(parsed.hostname)) {
      return 'Bundle Artifact URL must point to a public host.';
    }
    return undefined;
  }

  if (url.startsWith('http://') || url.startsWith('https://')) {
    return (
      'OCI image reference must be a registry reference ' +
      '(e.g. ghcr.io/org/agent:1.0.0), not an HTTP URL.'
    );
  }
  if (!OCI_REF_RE.test(url) || !url.includes('/')) {
    return 'Invalid OCI image reference (expected e.g. ghcr.io/org/agent:1.0.0).';
  }
  const slash = url.indexOf('/');
  const registryHost = url.slice(0, slash).split(':')[0];
  if (
    !allowPrivateUrls &&
    (registryHost.includes('.') || registryHost === 'localhost') &&
    isPrivateOrLoopbackHost(registryHost)
  ) {
    return 'OCI image registry must point to a public host.';
  }
  return undefined;
}

export function register(app: polka.Polka, options: Options) {
  const {db, auth} = options;
  const getNow = options.now ?? (() => Math.floor(Date.now() / 1000));
  const getPools = () => options.poolsByLadder ??
    loadLadderPools(options.laddersFile ?? LADDERS_FILE);
  const maxAttempts = options.rateLimitMaxAttempts ?? RATE_LIMIT_MAX_ATTEMPTS;
  const windowSeconds = options.rateLimitWindowSeconds ?? RATE_LIMIT_WINDOW_SECONDS;
  const attemptsByAgent = new Map<number, number[]>();
  const teamAttemptsByAgent = new Map<number, number[]>();

  // Enforced before body parsing and 1-NN team-uniqueness checks so a logged-in developer cannot
  // exhaust CPU by spamming 20-team validation pastes (supplements Nginx's IP-based `submission`
  // zone when multiple co-authors submit for the same project).
  const checkBucketRateLimit = (
    bucket: Map<number, number[]>,
    agentId: number,
    now: number
  ): number | undefined => {
    const cutoff = now - windowSeconds;
    const recent = (bucket.get(agentId) ?? []).filter(ts => ts > cutoff);
    if (recent.length >= maxAttempts) {
      bucket.set(agentId, recent);
      return Math.max(1, recent[0] + windowSeconds - now);
    }
    recent.push(now);
    bucket.set(agentId, recent);
    return undefined;
  };
  const checkSubmissionRateLimit = (agentId: number, now: number) =>
    checkBucketRateLimit(attemptsByAgent, agentId, now);
  const checkTeamValidationRateLimit = (agentId: number, now: number) =>
    checkBucketRateLimit(teamAttemptsByAgent, agentId, now);

  const handleGetAccount = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    forceJson: boolean
  ) => {
    const wantsJson = forceJson || Boolean(req.headers.accept?.includes('application/json'));
    const login = auth.getGitHubUser(req);
    if (!login) {
      if (wantsJson) {
        sendJson(res, 401, {error: 'GitHub authentication required.'});
      } else {
        redirect(res, '/auth/github?return_to=%2Faccount%2F');
      }
      return;
    }

    const developer = db.getDeveloperByGitHub(login);
    const agent = developer ? db.getAgentById(developer.agentId) : undefined;
    const liveTournament = db.getRunningTournament();
    if (!developer || !agent || agent.status === 'disabled') {
      if (wantsJson) {
        sendJson(res, 403, {
          error: `GitHub account "${login}" is not registered to an approved Arena project.`,
        });
      } else {
        sendHtml(res, 403, renderNotRegisteredError(login, liveTournament));
      }
      return;
    }

    const now = getNow();
    const status = db.computeAgentSubmissionStatus(agent.id, now);
    const tournamentStatuses = db.computeAgentTournamentStatuses(agent.id, now);
    const currentLadders = db.getCurrentLadders();
    const needsTeamsLadders = currentLadders.filter(
      l => (l.status === 'upcoming' || l.status === 'active') &&
        l.team === 'pools' &&
        !db.hasActiveLadderTeams(l.id, agent.id)
    );
    const savedTeamsByLadder = new Map<string, number>();
    const savedTeamsJson: Record<string, {
      savedCount: number;
      requiredCount: number;
      remainingCount: number;
      complete: boolean;
      locked: boolean;
    }> = {};
    for (const l of currentLadders) {
      if (l.team !== 'pools' || !l.teams) continue;
      const locked = db.hasActiveLadderTeams(l.id, agent.id);
      const savedCount = locked
        ? l.teams
        : db.getTeamsForAgentLadder(l.id, agent.id, 'saved').length;
      if (!locked) savedTeamsByLadder.set(l.id, savedCount);
      const remainingCount = locked ? 0 : Math.max(0, l.teams - savedCount);
      savedTeamsJson[l.id] = {
        savedCount,
        requiredCount: l.teams,
        remainingCount,
        complete: remainingCount === 0,
        locked,
      };
    }
    const activeEntries = db.getActiveEntriesForAgent(agent.id);
    const versions = db.getVersionsForAgent(agent.id);

    if (wantsJson) {
      const needsTeamsIds = new Set(needsTeamsLadders.map(l => l.id));
      sendJson(res, 200, {
        developer: {
          github: developer.githubLogin,
          smogon: developer.smogonUsername,
          smogonId: developer.smogonId,
          discordId: developer.discordId,
          discordUsername: developer.discordUsername,
        },
        agent: {
          slug: agent.slug,
          name: agent.name,
          status: agent.status,
          profileHref: `/projects/${encodeURIComponent(agent.slug)}/`,
        },
        submissionStatus: status,
        tournamentStatuses,
        savedTeams: savedTeamsJson,
        currentLadders: currentLadders.map(l => ({
          id: l.id,
          slot: l.slot,
          name: l.name,
          format: l.format,
          team: l.team,
          teams: l.teams,
          status: l.status,
          needsTeams: needsTeamsIds.has(l.id),
          savedCount: savedTeamsJson[l.id]?.savedCount ?? 0,
          remainingTeams: savedTeamsJson[l.id]?.remainingCount ?? 0,
        })),
        activeEntries,
        versions,
      });
      return;
    }

    const html = renderAccountPage({
      developer,
      agent,
      status,
      tournamentStatuses,
      currentLadders,
      needsTeamsLadders,
      savedTeamsByLadder,
      activeEntries,
      versions,
      allLadders: db.getLadders(),
      liveTournament,
      now,
    });
    sendHtml(res, 200, html);
  };

  app.get('/account', (req, res) => handleGetAccount(req, res, false));
  app.get('/account.json', (req, res) => handleGetAccount(req, res, true));
  app.get('/account/index.json', (req, res) => handleGetAccount(req, res, true));

  const requirePoolAccount = (
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): db.AgentRow | undefined => {
    if (isCrossSiteRequest(req)) {
      sendJson(res, 403, {error: 'Cross-site requests are not allowed.'});
      return undefined;
    }
    const login = auth.getGitHubUser(req);
    if (!login) {
      sendJson(res, 401, {error: 'GitHub authentication required.'});
      return undefined;
    }
    const developer = db.getDeveloperByGitHub(login);
    const agent = developer ? db.getAgentById(developer.agentId) : undefined;
    if (!developer || !agent || agent.status === 'disabled') {
      sendJson(res, 403, {error: 'GitHub account is not registered to an Arena project.'});
      return undefined;
    }
    if (agent.status === 'pending') {
      sendJson(res, 403, {error: 'Pending accounts cannot enter ladders yet.'});
      return undefined;
    }
    return agent;
  };

  app.post('/api/account/teams', async (req, res) => {
    const agent = requirePoolAccount(req, res);
    if (!agent) return;

    const now = getNow();
    const retryAfter = checkTeamValidationRateLimit(agent.id, now);
    if (retryAfter !== undefined) {
      sendJson(
        res,
        429,
        {error: `Too many team validation attempts; wait ${retryAfter}s before retrying.`},
        {'Retry-After': String(retryAfter)}
      );
      return;
    }

    let bodyObj: Record<string, unknown>;
    try {
      const rawBody = await readBody(req);
      bodyObj = JSON.parse(rawBody || '{}') as Record<string, unknown>;
    } catch (err: any) {
      sendJson(res, err?.status ?? 400, {error: err?.message || 'Malformed request body.'});
      return;
    }

    const ladderId = typeof bodyObj.ladderId === 'string' ? bodyObj.ladderId.trim() : '';
    const ladder = db.getCurrentLadders().find(
      l => l.id === ladderId && (l.status === 'upcoming' || l.status === 'active') &&
        l.team === 'pools'
    );
    if (!ladder?.teams) {
      sendJson(res, 400, {error: `Unknown or non-pool ladder "${ladderId}".`});
      return;
    }
    if (db.hasActiveLadderTeams(ladder.id, agent.id)) {
      sendJson(res, 400, {
        error:
          `Your ${ladder.teams} teams for ${ladder.name} (${ladder.id}) ` +
          'are already locked for this season.',
      });
      return;
    }

    const rawTeams = bodyObj.teams;
    const validTeamsInput =
      typeof rawTeams === 'string'
        ? rawTeams.trim().length > 0
        : Array.isArray(rawTeams) && rawTeams.some(t => String(t ?? '').trim().length > 0);
    if (!validTeamsInput) {
      sendJson(res, 400, {error: 'Paste at least one team to validate.'});
      return;
    }

    const existingSaved = db.getTeamsForAgentLadder(ladder.id, agent.id, 'saved');
    const poolsMap = getPools();
    const result = validateCompetitorTeamsIncremental(
      rawTeams as string | string[],
      {
        format: ladder.format,
        pools: poolsMap.get(ladder.id) ?? [],
        teams: ladder.teams,
      },
      existingSaved
    );

    if (result.allSaved.length !== existingSaved.length) {
      db.replaceSavedTeams(ladder.id, agent.id, result.allSaved, getNow());
    }

    sendJson(res, 200, {
      ok: true,
      ladderId: ladder.id,
      savedCount: result.allSaved.length,
      newlySavedCount: result.newlySavedCount,
      requiredCount: result.requiredCount,
      remainingCount: result.remainingCount,
      complete: result.complete,
      rejections: result.rejections,
    });
  });

  app.post('/api/account/teams/clear', async (req, res) => {
    const agent = requirePoolAccount(req, res);
    if (!agent) return;

    let bodyObj: Record<string, unknown>;
    try {
      const rawBody = await readBody(req);
      bodyObj = JSON.parse(rawBody || '{}') as Record<string, unknown>;
    } catch (err: any) {
      sendJson(res, err?.status ?? 400, {error: err?.message || 'Malformed request body.'});
      return;
    }

    const ladderId = typeof bodyObj.ladderId === 'string' ? bodyObj.ladderId.trim() : '';
    const ladder = db.getCurrentLadders().find(
      l => l.id === ladderId && (l.status === 'upcoming' || l.status === 'active') &&
        l.team === 'pools'
    );
    if (!ladder?.teams) {
      sendJson(res, 400, {error: `Unknown or non-pool ladder "${ladderId}".`});
      return;
    }
    if (db.hasActiveLadderTeams(ladder.id, agent.id)) {
      sendJson(res, 400, {
        error:
          `Your ${ladder.teams} teams for ${ladder.name} (${ladder.id}) ` +
          'are already locked for this season.',
      });
      return;
    }

    db.clearSavedTeams(ladder.id, agent.id);
    sendJson(res, 200, {
      ok: true,
      ladderId: ladder.id,
      savedCount: 0,
      requiredCount: ladder.teams,
      remainingCount: ladder.teams,
      complete: false,
    });
  });

  app.post('/api/submissions', async (req, res) => {
    if (isCrossSiteRequest(req)) {
      sendJson(res, 403, {error: 'Cross-site requests are not allowed.'});
      return;
    }
    const login = auth.getGitHubUser(req);
    if (!login) {
      sendJson(res, 401, {error: 'GitHub authentication required.'});
      return;
    }

    const developer = db.getDeveloperByGitHub(login);
    const agent = developer ? db.getAgentById(developer.agentId) : undefined;
    if (!developer || !agent || agent.status === 'disabled') {
      sendJson(res, 403, {error: 'GitHub account is not registered to an Arena project.'});
      return;
    }

    const now = getNow();
    const eligibility = db.computeAgentSubmissionStatus(agent.id, now);
    const tournamentStatuses = db.computeAgentTournamentStatuses(agent.id, now);
    if (!eligibility.canSubmit && !tournamentStatuses.length) {
      const code = eligibility.label === 'Pending' || eligibility.label === 'Qualified'
        ? 403
        : 429;
      sendJson(res, code, {error: eligibility.reason ?? 'Not currently eligible to submit.'});
      return;
    }

    const retryAfter = checkSubmissionRateLimit(agent.id, now);
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
        error:
          'Invalid version string (must be 1–12 chars matching ^[A-Za-z0-9][A-Za-z0-9._-]{0,11}$).',
      });
      return;
    }

    const packageFormat: db.PackageFormat =
      payload.packageFormat === 'bundle' || payload.packageFormat === 'oci'
        ? payload.packageFormat
        : deducePackageFormat(payload.url);
    if (
      payload.packageFormat &&
      payload.packageFormat !== 'bundle' &&
      payload.packageFormat !== 'oci'
    ) {
      sendJson(res, 400, {error: 'Invalid package (expected "bundle" or "oci").'});
      return;
    }

    const urlErr = validateArtifactUrl(payload.url, packageFormat, options.allowPrivateUrls);
    if (urlErr) {
      sendJson(res, 400, {error: urlErr});
      return;
    }

    if (!SHA256_RE.test(payload.sha256)) {
      sendJson(res, 400, {error: 'Invalid sha256 (must be a 64-character hex digest).'});
      return;
    }
    const sha256 = payload.sha256.toLowerCase();

    if (!payload.ladders.length && !payload.tournaments.length) {
      sendJson(res, 400, {error: 'Select at least one active ladder or scheduled tournament.'});
      return;
    }

    if (payload.ladders.length && !eligibility.canSubmit) {
      const code = eligibility.label === 'Pending' || eligibility.label === 'Qualified'
        ? 403
        : 429;
      sendJson(
        res,
        code,
        {error: eligibility.reason ?? 'Not currently eligible for ladder submissions.'}
      );
      return;
    }

    const tourneyStatusById = new Map(tournamentStatuses.map(t => [t.tournamentId, t]));
    const selectedTournamentIds: string[] = [];
    for (const rawTid of payload.tournaments) {
      const tStatus = tourneyStatusById.get(rawTid);
      if (!tStatus) {
        sendJson(res, 400, {error: `Unknown or closed tournament "${rawTid}".`});
        return;
      }
      if (!tStatus.canSubmit) {
        const code = now >= tStatus.closesAt ? 400 : 409;
        sendJson(res, code, {error: tStatus.reason ?? `Cannot submit to "${tStatus.name}".`});
        return;
      }
      if (!selectedTournamentIds.includes(tStatus.tournamentId)) {
        selectedTournamentIds.push(tStatus.tournamentId);
      }
    }

    if (selectedTournamentIds.length && packageFormat !== 'oci') {
      sendJson(res, 400, {
        error: 'Tournament submissions require an OCI image (package: "oci").',
      });
      return;
    }

    const currentLadders = db.getCurrentLadders();
    const byId = new Map(currentLadders.map(l => [l.id.toLowerCase(), l]));
    const bySlot = new Map(currentLadders.map(l => [l.slot.toLowerCase(), l]));
    const byName = new Map(currentLadders.map(l => [l.name.toLowerCase(), l]));

    const selectedLadders: db.LadderRow[] = [];
    const seenLadderIds = new Set<string>();
    for (const raw of payload.ladders) {
      const key = raw.toLowerCase();
      const ladder = byId.get(key) ?? bySlot.get(key) ?? byName.get(key);
      if (!ladder) {
        sendJson(res, 400, {error: `Unknown or closed ladder "${raw}".`});
        return;
      }
      if (!seenLadderIds.has(ladder.id)) {
        seenLadderIds.add(ladder.id);
        selectedLadders.push(ladder);
      }
    }

    const poolsMap = getPools();
    const teamsByLadder: Record<string, string[]> = {};
    const hasSubmittedTeams = Array.isArray(payload.teams)
      ? payload.teams.some(t => t.trim().length > 0)
      : Boolean(payload.teams?.trim());

    const poolLadders = selectedLadders.filter(l => l.team === 'pools');
    if (!poolLadders.length && hasSubmittedTeams) {
      sendJson(res, 400, {
        error: 'Custom team pools are only accepted when entering a seasonal pools ladder.',
      });
      return;
    }

    for (const ladder of poolLadders) {
      const requiredTeams = ladder.teams!;
      const alreadyLocked = db.hasActiveLadderTeams(ladder.id, agent.id);
      if (alreadyLocked) {
        if (hasSubmittedTeams) {
          sendJson(res, 400, {
            error:
              `Your ${requiredTeams} teams for ${ladder.name} (${ladder.id}) ` +
              'are already locked for this season; omit teams to reuse your locked pool.',
          });
          return;
        }
        continue;
      }

      const existingSaved = db.getTeamsForAgentLadder(ladder.id, agent.id, 'saved');
      if (!hasSubmittedTeams || !payload.teams) {
        if (existingSaved.length === requiredTeams) {
          teamsByLadder[ladder.id] = existingSaved;
          continue;
        }
        const suffix = existingSaved.length > 0
          ? ` (${existingSaved.length}/${requiredTeams} distinct teams saved — ` +
            `${requiredTeams - existingSaved.length} more needed).`
          : '.';
        sendJson(res, 400, {
          error:
            `First submission to ${ladder.name} requires ${requiredTeams} ` +
            `valid teams passing the 1.30 uniqueness threshold${suffix}`,
          ladderId: ladder.id,
          savedCount: existingSaved.length,
          requiredCount: requiredTeams,
          remainingCount: requiredTeams - existingSaved.length,
          rejections: [] as RejectedTeam[],
        });
        return;
      }

      const pools = poolsMap.get(ladder.id) ?? [];
      const result = validateCompetitorTeamsIncremental(
        payload.teams,
        {
          format: ladder.format,
          pools,
          teams: requiredTeams,
        },
        existingSaved
      );

      if (result.allSaved.length !== existingSaved.length) {
        db.replaceSavedTeams(ladder.id, agent.id, result.allSaved, now);
      }

      if (!result.complete || result.rejections.length > 0) {
        const chunkCount = splitSubmittedTeams(payload.teams).length;
        const baseError = result.rejections.length > 0
          ? result.rejections[0].reason
          : `Expected ${requiredTeams} teams for ${ladder.format}, received ${chunkCount}.`;
        const progressNote =
          `(${result.allSaved.length}/${requiredTeams} distinct teams saved — ` +
          `${result.remainingCount} more needed)`;
        sendJson(res, 400, {
          error: `${baseError} ${progressNote}`,
          ladderId: ladder.id,
          savedCount: result.allSaved.length,
          newlySavedCount: result.newlySavedCount,
          requiredCount: requiredTeams,
          remainingCount: result.remainingCount,
          rejections: result.rejections,
        });
        return;
      }

      teamsByLadder[ladder.id] = result.allSaved;
    }

    let authTokenEncoding: string | undefined;
    if (payload.authToken) {
      const secret = auth.getConfig()?.sessionSecret;
      if (!secret) {
        sendJson(res, 503, {error: 'SESSION_SECRET is required to encrypt authToken.'});
        return;
      }
      authTokenEncoding = encryptSecret(payload.authToken, secret);
    }

    try {
      const created = db.createSubmission({
        agentId: agent.id,
        developerId: developer.id,
        version: payload.version,
        package: packageFormat,
        url: payload.url,
        sha256,
        authTokenEncoding,
        ladderIds: selectedLadders.map(l => l.id),
        tournamentIds: selectedTournamentIds,
        teamsByLadder: Object.keys(teamsByLadder).length ? teamsByLadder : undefined,
        now,
      });

      if (req.headers.accept?.includes('application/json')) {
        sendJson(res, 201, {
          ok: true,
          versionId: created.id,
          version: created.version,
          smokeStatus: created.smokeStatus,
        });
        return;
      }
      redirect(res, '/account/', 303);
    } catch (err: any) {
      sendJson(res, err?.status ?? 500, {error: err?.message || 'Failed to save submission.'});
    }
  });
}
