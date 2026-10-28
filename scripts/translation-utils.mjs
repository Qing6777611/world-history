import { hashText } from "./event-records.mjs";

export const hasChinese = text => typeof text === "string" && /\p{Script=Han}/u.test(text);
export function hasRepeatedText(text) {
  if (typeof text !== "string") return false;
  const compact = text.replace(/\s+/g, "");
  return /([\p{Script=Han}])\1{4,}/u.test(compact) || /(.{2,16})\1{3,}/u.test(compact);
}

function chineseNumber(raw) {
  const digits = { 零: "0", 〇: "0", 一: "1", 二: "2", 两: "2", 三: "3", 四: "4", 五: "5", 六: "6", 七: "7", 八: "8", 九: "9", 点: "." };
  const text = raw.replace(/[零〇一二两三四五六七八九点]/g, char => digits[char]);
  if (!/[十百千万亿]/.test(text)) return Number(text);
  let total = 0, section = 0, number = 0;
  const units = { 十: 10, 百: 100, 千: 1000, 万: 10000, 亿: 100000000 };
  for (const token of text.match(/\d+(?:\.\d+)?|[十百千万亿]/g) ?? []) {
    if (!units[token]) { number = Number(token); continue; }
    const unit = units[token];
    if (unit < 10000) section += (number || 1) * unit;
    else if (unit === 10000) { total += (section + number || 1) * unit; section = 0; }
    else { total = (total + section + number || 1) * unit; section = 0; }
    number = 0;
  }
  return total + section + number;
}

function numericFacts(text, chinese) {
  const normalized = text.normalize("NFKC").replace(/[,，](?=\d)/g, "")
    .replace(/([0-9零〇一二两三四五六七八九十百千万亿])\s+(?=[十百千万亿])/g, "$1");
  if (chinese) return [...normalized.matchAll(/[0-9零〇一二两三四五六七八九十百千万亿]+(?:[.点][0-9零〇一二两三四五六七八九]+)?(?:[十百千万亿]+)?/g)]
    .map(([raw]) => ({ raw, value: chineseNumber(raw) }));

  // Ignore only the exponent of a measured area/volume, not all digits after
  // letters: "38000 m3" has one quantity, while H2S and M3 retain their 2/3.
  const exponents = new Set([...normalized.matchAll(/\b\d+(?:\.\d+)?(?:\s*(?:hundred|thousand|million|billion|trillion))?\s*(?:km|mi|m)[23]\b/g)]
    .map(match => match.index + match[0].length - 1));
  const scales = { hundred: 100, thousand: 1000, million: 1e6, billion: 1e9, trillion: 1e12, m: 1e6, bn: 1e9 };
  return [...normalized.matchAll(/([$£€¥]\s*)?(\d+(?:\.\d+)?|\.\d+)(?:\s*(hundred|thousand|million|billion|trillion|bn|m)\b)?/gi)]
    .filter(match => !exponents.has(match.index))
    .map(([raw, currency, amount, suffix]) => {
      const unit = suffix?.toLowerCase();
      // Bare "53m" can mean metres. Financial abbreviations require a currency.
      const scale = (unit === "m" || unit === "bn") && !currency ? 1 : scales[unit] ?? 1;
      return { raw, value: Number(amount) * scale };
    });
}

/** Mechanical checks catch malformed output; accepted prose still needs sampling. */
export function validateTranslation(source, translated) {
  const reasons = [], review = [];
  if (typeof translated !== "string" || !hasChinese(translated)) return { valid: false, reasons: ["missing-chinese"], review };
  const text = translated.trim(), han = [...text.matchAll(/\p{Script=Han}/gu)].length;
  if (hasRepeatedText(text)) reasons.push("repeated-text");
  const ratio = text.length / Math.max(1, source.length);
  if (han < (source.length < 24 ? 2 : 3) || ratio < 0.12 || ratio > 1.5) reasons.push("implausible-length");
  const target = numericFacts(text, true);
  for (const number of numericFacts(source, false)) {
    const match = target.find(item => Math.abs(item.value - number.value) <= Number.EPSILON * 8 * Math.max(1, Math.abs(number.value)));
    if (!match && number.value === 1 && /首[次届位个场部座航]/.test(text)) { review.push(`numeric-word:${number.raw}`); continue; }
    if (!match && /^\d{2}$/.test(number.raw) && new RegExp(`(?:–|—|-)\\s*${number.raw}\\b`).test(source)
      && target.some(item => item.value >= 1000 && item.value % 100 === number.value)) {
      review.push(`expanded-year:${number.raw}`); continue;
    }
    if (!match) reasons.push(`number-mismatch:${number.raw}`);
    else if (match.raw !== number.raw) review.push(`normalized-number:${number.raw}→${match.raw}`);
  }
  return { valid: reasons.length === 0, reasons: [...new Set(reasons)], review: [...new Set(review)] };
}

export function translationQueue(events, cache = {}, manual = {}, repairKeys) {
  const pending = new Map();
  for (const event of events) {
    if (typeof event.de !== "string" || !event.de.trim()) continue;
    const key = hashText(event.de);
    if (event.dzSrc === "manual" || hasChinese(manual[key])) continue;
    const repair = event.dzSrc === "mt" && (repairKeys ? repairKeys.has(key) : hasRepeatedText(event.dz) || hasRepeatedText(cache[key]));
    if (hasChinese(event.dz) && !repair) continue;
    if (validateTranslation(event.de, cache[key]).valid) continue;
    if (!pending.has(key)) pending.set(key, { key, source: event.de, year: event.y ?? 0, repair });
  }
  return [...pending.values()].sort((a, b) => b.year - a.year);
}

export function packBatches(entries, maxChars = 3500) {
  const batches = [];
  let batch = [], size = 0;
  for (const entry of entries) {
    const length = entry.source.length + 10;
    if (length > maxChars) throw new Error(`Source ${entry.key} exceeds the ${maxChars}-character request budget`);
    if (batch.length && size + length > maxChars) { batches.push(batch); batch = []; size = 0; }
    batch.push(entry); size += length;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

const lineId = index => `E${String(index + 1).padStart(4, "0")}`;
export const markedInput = entries => entries.map((entry, index) => `[${lineId(index)}] ${entry.source}`).join("\n");

export function parseMarkedOutput(text, entries) {
  if (typeof text !== "string") throw new Error("Translation response is not text");
  const markers = [...text.matchAll(/\[E\d+\]/g)], expected = new Set(entries.map((_, index) => `[${lineId(index)}]`));
  if (markers.length !== entries.length || text.slice(0, markers[0]?.index ?? text.length).trim()) throw new Error("Translation response has missing IDs or unmarked text");
  const mapped = new Map();
  markers.forEach((marker, index) => {
    if (!expected.has(marker[0]) || mapped.has(marker[0])) throw new Error("Translation response has duplicate or unknown IDs");
    const value = text.slice(marker.index + marker[0].length, markers[index + 1]?.index ?? text.length).trim();
    if (!value) throw new Error("Translation response has an empty item");
    mapped.set(marker[0], value);
  });
  return entries.map((_, index) => mapped.get(`[${lineId(index)}]`));
}
