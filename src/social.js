// Publishing through Post for Me (postforme.dev), multi-tenant:
//   every LibreChat user's social accounts are tagged with external_id = "lc_<userId>" when they connect
//   them through Post for Me's OAuth link (Quickstart project = Post for Me's pre-approved platform apps),
//   and a post may only target accounts carrying that user's tag.
// Post for Me's /social-posts accepts ANY account id in the project, so the ownership check below is what
// keeps users from posting to each other's channels. Account objects also contain OAuth tokens: they are
// never passed through to the model.

import { config } from './config.js';

export class SocialError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

const tag = (userId) => `lc_${userId}`;

async function call(method, pathAndQuery, body) {
  let res;
  try {
    res = await fetch(`${config.postForMeBaseUrl}${pathAndQuery}`, {
      method,
      headers: {
        Authorization: `Bearer ${config.postForMeKey}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    throw new SocialError(`Publishing service unreachable: ${err.message}`);
  }
  const raw = await res.text();
  let data = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    let msg = data?.message || data?.error || raw.slice(0, 300) || `HTTP ${res.status}`;
    if (Array.isArray(msg)) msg = msg.join('; ');
    if (Array.isArray(data?.errors) && data.errors.length) msg += ': ' + data.errors.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('; ');
    throw new SocialError(String(msg).slice(0, 600), res.status);
  }
  return data;
}

const PLATFORM_DATA = {
  // Quickstart (Post for Me's own credentials) requires the "organization" LinkedIn flow.
  linkedin: { linkedin: { connection_type: 'organization' } },
  instagram: { instagram: { connection_type: 'instagram' } },
};

export async function connectUrl(userId, platform) {
  const r = await call('POST', '/social-accounts/auth-url', {
    platform,
    external_id: tag(userId),
    permissions: ['posts', 'feeds'],
    ...(PLATFORM_DATA[platform] ? { platform_data: PLATFORM_DATA[platform] } : {}),
  });
  if (!r?.url) throw new SocialError('The publishing service did not return a connect link.');
  return r.url;
}

/** The user's own accounts only, without tokens. */
export async function listAccounts(userId) {
  const out = [];
  for (let offset = 0; offset < 500; offset += 100) {
    const r = await call('GET', `/social-accounts?external_id=${encodeURIComponent(tag(userId))}&limit=100&offset=${offset}`);
    const page = r?.data || [];
    for (const a of page) {
      if (a.external_id !== tag(userId)) continue; // never trust the filter alone
      out.push({ account_id: a.id, platform: a.platform, username: a.username ?? null, connected: a.status !== 'disconnected' });
    }
    if (page.length < 100) break;
  }
  return out;
}

/** "2026-12-01T18:00:00" in "Asia/Baku" -> UTC ISO string. Strings with Z or an offset are kept as they are. */
export function toUtcIso(local, timeZone) {
  if (/[zZ]$|[+-]\d\d:?\d\d$/.test(local) || !timeZone) {
    const d = new Date(local);
    if (Number.isNaN(d.getTime())) throw new SocialError('scheduled_for is not a valid date/time.');
    return d.toISOString();
  }
  const m = local.match(/^(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d)(?::(\d\d))?$/);
  if (!m) throw new SocialError('scheduled_for must look like 2026-12-01T18:00:00.');
  const asUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  let fmt;
  try {
    fmt = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    throw new SocialError(`Unknown timezone "${timeZone}". Use an IANA name like Asia/Baku or America/New_York.`);
  }
  const offsetAt = (ts) => {
    const p = Object.fromEntries(fmt.formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - ts;
  };
  let ts = asUtc - offsetAt(asUtc);
  ts = asUtc - offsetAt(ts); // second pass handles DST edges
  return new Date(ts).toISOString();
}

function accountConfig(platform, t, { aiGenerated, isVideo }) {
  const ai = aiGenerated !== false;
  switch (platform) {
    case 'tiktok':
    case 'tiktok_business':
      return {
        ...(t.title ? { title: t.title.slice(0, 90) } : {}),
        privacy_status: t.privacy || 'public',
        is_ai_generated: ai,
        disclose_your_brand: false,
        disclose_branded_content: false,
        ...(t.tiktok_draft ? { is_draft: true } : {}),
      };
    case 'youtube':
      return {
        ...(t.title ? { title: t.title.slice(0, 100) } : {}),
        privacy_status: ['public', 'private', 'unlisted'].includes(t.privacy) ? t.privacy : 'public',
        made_for_kids: false,
        contains_synthetic_media: ai,
      };
    case 'instagram':
      return { placement: isVideo ? 'reels' : 'timeline' };
    case 'facebook':
      return { placement: isVideo ? 'reels' : 'timeline' };
    case 'threads':
      return { placement: 'timeline' };
    case 'x':
      return { made_with_ai: ai };
    case 'pinterest':
    case 'linkedin':
      return t.title ? { title: t.title.slice(0, 100) } : {};
    default:
      return {};
  }
}

/**
 * targets: [{ account_id, title?, privacy?, tiktok_draft? }]
 * mode: 'now' | 'schedule' | 'draft'
 * aiGenerated: label the post as AI-made where the platform supports it (default true)
 */
export async function publish(userId, { mediaUrls, caption, targets, mode, scheduledFor, timezone, aiGenerated }) {
  const mine = new Map((await listAccounts(userId)).map((a) => [a.account_id, a]));
  for (const t of targets) {
    const a = mine.get(t.account_id);
    if (!a) throw new SocialError(`Account ${t.account_id} is not one of this user's connected accounts. Call social_list_accounts.`, 403);
    if (!a.connected) throw new SocialError(`The ${a.platform} account @${a.username} is disconnected. Reconnect it with social_connect_account.`, 409);
  }
  const isVideo = mediaUrls.some((u) => /\.(mp4|mov|webm)$/i.test(u));
  const body = {
    caption,
    external_id: tag(userId), // lets social_list_scheduled find this user's posts
    social_accounts: targets.map((t) => t.account_id),
    media: mediaUrls.map((url) => ({ url })),
    account_configurations: targets.map((t) => ({
      social_account_id: t.account_id,
      configuration: accountConfig(mine.get(t.account_id).platform, t, { aiGenerated, isVideo }),
    })),
    ...(mode === 'schedule' ? { scheduled_at: toUtcIso(scheduledFor, timezone) } : {}),
    ...(mode === 'draft' ? { isDraft: true } : {}),
  };
  if (mode === 'schedule' && new Date(body.scheduled_at).getTime() < Date.now() + 60_000) {
    throw new SocialError('scheduled_for must be at least a minute in the future.', 400);
  }
  const post = await call('POST', '/social-posts', body);
  return {
    postId: post?.id,
    status: post?.status,
    scheduledAt: post?.scheduled_at ?? null,
    accounts: targets.map((t) => ({ account_id: t.account_id, platform: mine.get(t.account_id).platform })),
  };
}

async function ownedPost(userId, postId) {
  const post = await call('GET', `/social-posts/${encodeURIComponent(postId)}`);
  const accounts = post?.social_accounts || [];
  if (!accounts.length || accounts.some((a) => a.external_id !== tag(userId))) throw new SocialError('Unknown post_id.', 404);
  return post;
}

/** This user's scheduled posts and drafts (newest first). */
export async function listPending(userId) {
  const q = `external_id=${encodeURIComponent(tag(userId))}&status=scheduled&status=draft&limit=50`;
  const r = await call('GET', `/social-posts?${q}`);
  return (r?.data || [])
    .filter((p) => (p.social_accounts || []).length && p.social_accounts.every((a) => a.external_id === tag(userId)))
    .filter((p) => p.status === 'scheduled' || p.status === 'draft')
    .map((p) => ({
      post_id: p.id,
      status: p.status,
      scheduled_at: p.scheduled_at ?? null,
      caption: String(p.caption || '').slice(0, 120),
      platforms: p.social_accounts.map((a) => `${a.platform}${a.username ? ' @' + a.username : ''}`),
    }));
}

/** Cancel a scheduled post or delete a draft (published posts cannot be removed this way). */
export async function cancelPost(userId, postId) {
  const post = await ownedPost(userId, postId);
  if (post.status !== 'scheduled' && post.status !== 'draft') {
    throw new SocialError(`This post is already ${post.status}; only scheduled posts and drafts can be cancelled. Delete published posts on the platform itself.`, 400);
  }
  await call('DELETE', `/social-posts/${encodeURIComponent(postId)}`);
  return { postId, wasStatus: post.status, scheduledAt: post.scheduled_at ?? null };
}

/** Per-account outcome of a post that belongs to this user. */
export async function postStatus(userId, postId) {
  const post = await ownedPost(userId, postId);
  const accounts = post.social_accounts;
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const r = await call('GET', `/social-post-results?post_id=${encodeURIComponent(postId)}&limit=50`);
  const raw = r?.data || [];
  const results = raw.map((x) => ({
    platform: byId.get(x.social_account_id)?.platform,
    username: byId.get(x.social_account_id)?.username ?? null,
    success: !!x.success,
    url: x.platform_data?.url ?? null,
    error: x.success ? null : x.error || x.details?.error || 'failed',
  }));
  const pending = accounts.filter((a) => !raw.some((x) => x.social_account_id === a.id)).length;
  return { postId, status: post.status, scheduledAt: post.scheduled_at ?? null, results, pending };
}
