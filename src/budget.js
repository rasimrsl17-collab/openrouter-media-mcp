// Credit check against LiteLLM customer budgets.
//
// LiteLLM tracks chat spend per customer (LibreChat sends the user id in x-litellm-customer-id)
// and your billing service sets the customer's max_budget. Media calls bypass LiteLLM, so this
// server keeps its own ledger of what it charged (storage.js) and computes:
//
//   remaining = max_budget - spend (LiteLLM) - media charged by this server - in-flight holds

import { config } from './config.js';
import { getMediaSpend } from './storage.js';

export class BudgetError extends Error {}

const held = new Map(); // userId -> USD currently reserved by calls in flight

const round = (n) => Math.round(n * 1e6) / 1e6;
export const usd = (n) => `$${(Math.round(n * 1e4) / 1e4).toFixed(4)}`;

/** Reads the customer from LiteLLM. Returns { found, maxBudget, spend, blocked }. */
export async function fetchCustomer(userId) {
  let res;
  try {
    res = await fetch(`${config.litellmUrl}/customer/info?end_user_id=${encodeURIComponent(userId)}`, {
      headers: { Authorization: `Bearer ${config.litellmCustomerKey}` },
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    throw new BudgetError(`LiteLLM unreachable: ${err?.message || err}`);
  }
  // LiteLLM answers 400/404 for a customer that does not exist yet (never got a plan).
  if (res.status === 400 || res.status === 404) {
    return { found: false, maxBudget: 0, spend: 0, blocked: false, restricted: false };
  }
  if (!res.ok) throw new BudgetError(`LiteLLM /customer/info returned HTTP ${res.status}`);
  const j = await res.json();
  const maxBudget = j?.litellm_budget_table?.max_budget ?? j?.max_budget;
  return {
    found: true,
    // No budget configured = no credit (fail closed); billing always sets one.
    maxBudget: typeof maxBudget === 'number' ? maxBudget : 0,
    spend: Number(j?.spend) || 0,
    blocked: j?.blocked === true,
    // Your billing service restricts free accounts to a model list ([FREE_MODEL]) and clears it
    // (models = []) when the user has paid credit, so a non-empty list means "free plan".
    restricted: Array.isArray(j?.models) && j.models.length > 0,
  };
}

/** Available credit for new media calls, in USD. */
export async function getAvailable(userId) {
  const c = await fetchCustomer(userId);
  const media = getMediaSpend(userId);
  const inflight = held.get(userId) ?? 0;
  const available = c.blocked || c.restricted ? 0 : Math.max(0, round(c.maxBudget - c.spend - media - inflight));
  return { ...c, media, inflight, available };
}

/**
 * Checks that the user can afford `estimateUsd` (x markup) and holds that amount while the call runs.
 * Returns { ok: true, release } or { ok: false, message }.
 */
export async function reserve(userId, estimateUsd) {
  if (config.budgetDisabled) return { ok: true, release() {} };
  const need = round(estimateUsd * config.costMarkup);
  let a;
  try {
    a = await getAvailable(userId);
  } catch (err) {
    console.error('[budget]', err.message);
    return {
      ok: false,
      message: 'The credit check is temporarily unavailable, so no paid media was generated. Ask the user to try again in a minute.',
    };
  }
  if (a.available < need) {
    const topup = config.topupUrl ? ` They can top up at ${config.topupUrl}.` : '';
    return {
      ok: false,
      message:
        `Not enough credit for this media request: it needs about ${usd(need)} and the user has ${usd(a.available)} available. ` +
        `Image, video and speech tools are paid from the user's credit (free-plan accounts cannot use them).${topup} ` +
        `Tell the user this plainly; do not retry.`,
    };
  }
  held.set(userId, (held.get(userId) ?? 0) + need);
  let done = false;
  return {
    ok: true,
    release() {
      if (done) return;
      done = true;
      const left = round((held.get(userId) ?? 0) - need);
      if (left > 0) held.set(userId, left);
      else held.delete(userId);
    },
  };
}
