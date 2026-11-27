// Publishing through Zernio (zernio.com), multi-tenant:
//   one Zernio profile per LibreChat user (externalId = LibreChat user id),
//   the user connects their own social accounts through Zernio's OAuth link,
//   and posts may only target accounts inside that user's own profile.
// Zernio's /v1/posts accepts ANY accountId in the workspace, so the ownership
// check below is what keeps users from posting to each other's channels.

import crypto from 'node:crypto';
import { config } from './config.js';
import { getSocialProfile, setSocialProfile } from './storage.js';

export class SocialError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function call(method, pathAndQuery, body, extraHeaders = {}) {
  let res;
  try {
    res = await fetch(`${config.zernioBaseUrl}${pathAndQuery}`, {
      method,
      headers: {
        Authorization: `Bearer ${config.zernioKey}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...extraHeaders,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(120_000), // publishNow uploads the video synchronously
    });
  } catch (err) {
    throw new SocialError(`Publishing service unreachable: ${err?.message || err}`);
  }
  const raw = await res.text();
  let json;
  try {
    json = raw ? JSON.parse(raw) : {};
  } catch {
    json = { raw: raw.slice(0, 500) };
  }
  if (!res.ok) {
    const msg = json?.error?.message || json?.message || json?.error || raw.slice(0, 300) || `HTTP ${res.status}`;
    throw new SocialError(typeof msg === 'string' ? msg : JSON.stringify(msg), res.status);
  }
  return { status: res.status, json };
}

const idOf = (p) => p?._id || p?.id || p?.profileId;

/** Returns this user's Zernio profile id, creating the profile on first use. */
export async function ensureProfile(userId) {
  const known = getSocialProfile(userId);
  if (known) return known;
  const found = await call('GET', `/profiles?externalId=${encodeURIComponent(userId)}`);
  const list = Array.isArray(found.json?.profiles) ? found.json.profiles : Array.isArray(found.json) ? found.json : [];
  let id = idOf(list.find((p) => p?.externalId === userId)) || idOf(found.json?.profile);
  if (!id) {
    const created = await call('POST', '/profiles', { name: `velorafy-${userId}`, externalId: userId });
    id = idOf(created.json?.profile) || idOf(created.json);
  }
  if (!id) throw new SocialError('Publishing service did not return a profile id.');
  setSocialProfile(userId, id);
  return id;
}

export async function connectUrl(userId, platform) {
  const profileId = await ensureProfile(userId);
  const q = new URLSearchParams({ profileId });
  if (config.socialRedirectUrl) q.set('redirect_url', config.socialRedirectUrl);
  const { json } = await call('GET', `/connect/${encodeURIComponent(platform)}?${q}`);
  if (!json?.authUrl) throw new SocialError('Publishing service did not return a connect link.');
  return json.authUrl;
}

export async function listAccounts(userId) {
  const profileId = await ensureProfile(userId);
  const { json } = await call('GET', `/accounts?profileId=${encodeURIComponent(profileId)}`);
  const accounts = Array.isArray(json?.accounts) ? json.accounts : [];
  // defence in depth: keep only accounts that really belong to this profile
  return accounts
    .filter((a) => !a.profileId || (a.profileId?._id || a.profileId) === profileId)
    .map((a) => ({ account_id: a._id, platform: a.platform, username: a.username, active: a.isActive !== false }));
}

/**
 * targets: [{ account_id, youtube_title? }]
 * mode: 'now' | 'schedule' | 'draft'
 */
export async function publish(userId, { mediaUrls, caption, targets, mode, scheduledFor, timezone }) {
  const profileId = await ensureProfile(userId);
  const mine = new Map((await listAccounts(userId)).map((a) => [a.account_id, a]));
  const platforms = [];
  for (const t of targets) {
    const acc = mine.get(t.account_id);
    if (!acc) throw new SocialError(`Account ${t.account_id} is not connected to this user.`, 403);
    if (!acc.active) throw new SocialError(`The ${acc.platform} account @${acc.username} is disconnected; reconnect it first.`, 409);
    const entry = { platform: acc.platform, accountId: acc.account_id };
    if (acc.platform === 'youtube') entry.platformSpecificData = { title: (t.youtube_title || caption.split('\n')[0]).slice(0, 100) };
    platforms.push(entry);
  }

  const body = {
    content: caption,
    mediaItems: mediaUrls.map((url) => ({ url })),
    platforms,
    profileId,
    externalId: `velorafy-${userId}`,
  };
  if (mode === 'draft') body.isDraft = true;
  else if (mode === 'schedule') {
    body.scheduledFor = scheduledFor;
    if (timezone) body.timezone = timezone;
  } else body.publishNow = true;

  const { status, json } = await call('POST', '/posts', body, { 'Idempotency-Key': crypto.randomUUID() });
  const post = json?.post || {};
  return {
    httpStatus: status,
    postId: post._id,
    status: post.status,
    platforms: post.platforms || json?.platformResults,
    error: json?.error,
    warnings: json?.warnings,
  };
}
