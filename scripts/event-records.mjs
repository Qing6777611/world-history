import { createHash } from "node:crypto";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const pad = (value) => String(value).padStart(2, "0");

// Keep this digest compatible with the existing sentence translation caches.
export const hashText = (text) => createHash("sha1").update(text).digest("hex").slice(0, 16);
export const clampText = (text, max) => text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** An entity label identifies a topic, not necessarily the recorded event. */
export function summaryTitle(text, max = 120) {
  const sentence = text.replace(/\s+/g, " ").trim();
  // Only strip a leading topic, never a colon inside a translated name's
  // parentheses or a later clause (for example “元帅（法语: …）”).
  const topic = /^[^:：()（）[\]【】《》]{1,40}[:：]\s*(.+)$/u.exec(sentence);
  const body = topic?.[1]?.length > 12 ? topic[1] : sentence;
  const title = clampText(body, max);
  return /\p{Script=Han}/u.test(sentence) && !/\p{Script=Han}/u.test(title) ? clampText(sentence, max) : title;
}

/** The feed sentence is copied from this calendar-day page, not its linked entities. */
export function englishDaySource(month, day) {
  if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(day) || day < 1 || day > new Date(Date.UTC(2024, month, 0)).getUTCDate()) {
    throw new Error("Invalid calendar day for source URL");
  }
  return `https://en.wikipedia.org/wiki/${MONTHS[month - 1]}_${day}#Events`;
}

export function eventId({ year, month, day, text }) {
  const digest = createHash("sha256").update(text).digest("hex").slice(0, 24);
  return `en-${year}-${pad(month)}-${pad(day)}-${digest}`;
}

/**
 * Only translations bound to the exact English sentence are automatically used.
 * A shared Wikidata entity, even on the same date, does not prove event identity.
 * Chinese Wikipedia candidates are retained separately for editorial review.
 */
export function translatedDescription(source, manual = {}, machine = {}) {
  const key = hashText(source);
  for (const [cache, kind] of [[manual, "manual"], [machine, "mt"]]) {
    const value = cache[key];
    if (typeof value === "string" && /\p{Script=Han}/u.test(value)) {
      return { text: value.trim(), source: kind };
    }
  }
  return { text: null, source: null };
}

export function validateFeed(value, label) {
  if (!value || !Array.isArray(value.events) || value.events.length === 0 || value.events.some((event) =>
    !event || !Number.isInteger(event.year) || event.year === 0 || typeof event.text !== "string" || !event.text.trim() || !Array.isArray(event.pages),
  )) {
    throw new Error(`Missing or invalid event feed: ${label}`);
  }
  return value;
}

const stripWiki = (text) => text
  .replace(/<ref[^>]*>[\s\S]*?<\/ref>/g, "")
  .replace(/<ref[^>]*\/>/g, "")
  .replace(/\{\{([^{}]*)\}\}/g, (_, inner) => {
    const parts = inner.split("|");
    return parts.length > 1 ? parts[parts.length - 1] : "";
  })
  .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, "$1")
  .replace(/'''?/g, "")
  .replace(/\[https?:\/\/[^\s\]]+\s*([^\]]*)\]/g, "$1")
  .replace(/[ \t]+/g, " ")
  .trim();

/** Extract review candidates with their complete date and original source. */
export function parseChineseDay(wikitext, month, day) {
  const entries = [];
  let inEvents = false;
  for (const line of wikitext.split("\n")) {
    if (/^==\s*(大事记|大事記|事件|大事年表)\s*==/.test(line)) { inEvents = true; continue; }
    if (/^==[^=]/.test(line)) { inEvents = false; continue; }
    if (!inEvents) continue;
    const match = /^\*\s*(?:\[\[)?\s*(公元前|前)?\s*(\d{1,4})\s*年(?:\]\])?\s*[：:]\s*(.+)$/.exec(line);
    if (!match) continue;
    const year = Number(match[2]) * (match[1] ? -1 : 1);
    if (year === 0) continue;
    const links = [...match[3].matchAll(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g)]
      .map((link) => link[1].split("#")[0].trim())
      .filter((title) => title && !/^\d+年$/.test(title));
    const text = stripWiki(match[3]);
    if (text) entries.push({ year, month, day, text, links, source: `https://zh.wikipedia.org/wiki/${month}月${day}日` });
  }
  return entries;
}

export function indexChineseCandidates(entries, resolved) {
  const byQid = {};
  for (const entry of entries) {
    const title = entry.links[0];
    const qid = title ? resolved.get(title) : undefined;
    if (!qid) continue;
    (byQid[qid] ??= []).push({ t: title, d: entry.text, y: entry.year, m: entry.month, day: entry.day, s: entry.source });
  }
  return byQid;
}
