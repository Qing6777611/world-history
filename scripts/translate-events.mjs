#!/usr/bin/env node
/** Translate missing Chinese and repair clearly repetitive MT; never overwrite manual translations.
 * Usage: node scripts/translate-events.mjs [--provider google|libre] [--limit 500]
 * Checkpoints are atomic. Reports contain failures, retries, and numeric normalization review items.
 */
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { markedInput, packBatches, parseMarkedOutput, translationQueue, validateTranslation } from "./translation-utils.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ENDPOINTS = { google: "https://translate.google.com/translate_a/single", libre: "https://translate.disroot.org/translate" };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function readCache(path) {
  let value;
  try { value = JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return {}; throw new Error(`Cannot read cache ${path}; refusing to overwrite it`, { cause: error }); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid cache object: ${path}`);
  return value;
}

export async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value));
  await rename(temporary, path);
}

class RequestError extends Error {
  constructor(message, permanent = false) { super(message); this.permanent = permanent; }
}

/** One shared pacing gate covers requests, retries, and split-batch recovery. */
export function createTranslator({ provider = "google", fetchFn = fetch, sleepFn = sleep, interval = 700, log = () => {} } = {}) {
  if (!ENDPOINTS[provider]) throw new Error(`Unknown provider: ${provider}`);
  let lastRequest = 0;
  async function request(entries, single = false) {
    let endpoint = ENDPOINTS[provider];
    for (let attempt = 0; attempt < 3; attempt++) {
      const wait = interval - (Date.now() - lastRequest);
      if (wait > 0) await sleepFn(wait);
      lastRequest = Date.now();
      let response;
      try {
        const input = single ? entries[0].source : markedInput(entries);
        const url = new URL(endpoint);
        const options = { signal: AbortSignal.timeout(30_000) };
        if (provider === "google") {
          url.search = new URLSearchParams({ client: "gtx", sl: "en", tl: "zh-CN", dt: "t", q: input }).toString();
        } else {
          options.method = "POST";
          options.headers = { "Content-Type": "application/json", "User-Agent": "WorldHistoryAtlas/1.0 (offline data build)" };
          options.body = JSON.stringify({ q: input, source: "en", target: "zh", format: "text" });
        }
        response = await fetchFn(url, options);
        if (!response.ok) {
          const transient = response.status === 408 || response.status === 429 || response.status >= 500;
          throw new RequestError(`HTTP ${response.status}`, !transient);
        }
        const data = await response.json();
        const text = provider === "google"
          ? Array.isArray(data?.[0]) && data[0].every(segment => typeof segment?.[0] === "string") ? data[0].map(segment => segment[0]).join("") : null
          : data?.translatedText;
        await log({ kind: "request", endpoint, attempt: attempt + 1, count: entries.length, status: response.status });
        if (typeof text !== "string") return { mappingError: "Unexpected response shape" };
        if (single) return { values: [text] };
        try { return { values: parseMarkedOutput(text, entries) }; }
        catch (error) { return { mappingError: error.message }; }
      } catch (error) {
        await log({ kind: "request-error", endpoint, attempt: attempt + 1, count: entries.length, error: error.message, cause: error.cause?.code });
        if (error.permanent || attempt === 2) throw new RequestError(error.message, !!error.permanent);
        // Host fallback is limited to transport failures, never HTTP rate limits or access denials.
        if (!response && provider === "google") endpoint = "https://translate.googleapis.com/translate_a/single";
        const retryAfter = response?.headers?.get("retry-after");
        const retryDelay = retryAfter && /^\d+(?:\.\d+)?$/.test(retryAfter) ? Number(retryAfter) * 1000 : 1000 * 2 ** attempt;
        await sleepFn(Math.min(30_000, retryDelay));
      }
    }
  }

  async function translate(entries, single = false) {
    const result = await request(entries, single);
    if (result.mappingError) {
      await log({ kind: "mapping-error", count: entries.length, error: result.mappingError });
      if (single) return entries.map(entry => ({ ...entry, text: "", valid: false, reasons: [result.mappingError], review: [] }));
      if (entries.length === 1) return translate(entries, true);
      const mid = Math.ceil(entries.length / 2);
      return [...await translate(entries.slice(0, mid)), ...await translate(entries.slice(mid))];
    }
    const output = [];
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index], text = result.values[index].trim();
      const validation = validateTranslation(entry.source, text);
      if (!validation.valid && !single) output.push(...await translate([entry], true));
      else output.push({ ...entry, text, ...validation });
    }
    return output;
  }
  return translate;
}

export function parseOptions(args) {
  const options = { provider: "google", limit: Infinity };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--provider") {
      options.provider = args[++i];
      if (!ENDPOINTS[options.provider]) throw new Error("--provider must be google or libre");
    } else if (args[i] === "--limit") {
      const value = args[++i];
      if (!value || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error("--limit requires a non-negative integer");
      options.limit = Number(value);
    } else throw new Error(`Unknown argument: ${args[i]}`);
  }
  return options;
}

export async function runTranslations({ root = ROOT, provider = "google", limit = Infinity, translate: suppliedTranslator, output = console.log } = {}) {
  const cachePath = join(root, ".cache/translations.json");
  const cache = await readCache(cachePath), manual = await readCache(join(root, ".cache/translations-manual.json"));
  let repairKeys;
  try { repairKeys = new Set(JSON.parse(await readFile(join(root, ".cache/translation-anomalies.json"), "utf8")).map(item => item.key)); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const directory = join(root, "public/data/events/year");
  const files = (await readdir(directory)).filter(file => /^-?\d+\.json$/.test(file));
  const events = (await Promise.all(files.map(file => readFile(join(directory, file), "utf8")))).flatMap(text => JSON.parse(text));
  const pending = translationQueue(events, cache, manual, repairKeys), queue = pending.slice(0, limit), batches = packBatches(queue);
  const report = { provider, startedAt: new Date().toISOString(), pending: pending.length, requested: queue.length, completed: 0, failed: [], review: [], requests: [] };
  const reportPath = join(root, ".cache", `translation-report-${report.startedAt.replace(/[:.]/g, "-")}.json`);
  const translate = suppliedTranslator ?? createTranslator({ provider, log: async event => {
    report.requests.push({ at: new Date().toISOString(), ...event });
    await atomicJson(reportPath, report);
  } });
  output(`${pending.length} sentences need translation/repair; ${queue.length} selected with ${provider}`);
  let consecutiveErrors = 0;
  for (let index = 0; index < batches.length; index++) {
    const batch = batches[index];
    try {
      const translated = await translate(batch);
      if (translated.length !== batch.length || translated.some((item, i) => item.key !== batch[i].key)) throw new Error("Translator returned mismatched entries");
      for (const item of translated) {
        // Validate again at the persistence boundary; custom providers cannot bypass it.
        const validation = validateTranslation(item.source, item.text);
        if (validation.valid) {
          cache[item.key] = item.text.trim(); report.completed++;
          if (validation.review.length) report.review.push({ key: item.key, source: item.source, text: item.text, reasons: validation.review });
        } else report.failed.push({ key: item.key, source: item.source, text: item.text, reasons: validation.reasons });
      }
      consecutiveErrors = 0;
    } catch (error) {
      consecutiveErrors++;
      report.failed.push(...batch.map(entry => ({ key: entry.key, source: entry.source, reasons: [error.message] })));
      if (error.permanent || consecutiveErrors >= 2) {
        report.aborted = `Provider stopped after ${error.permanent ? "a permanent error" : "two failed batches"}: ${error.message}`;
        report.failed.push(...batches.slice(index + 1).flat().map(entry => ({ key: entry.key, source: entry.source, reasons: ["not-attempted-provider-failure"] })));
      }
    }
    report.updatedAt = new Date().toISOString();
    await atomicJson(cachePath, cache);
    await atomicJson(reportPath, report);
    output(`translated ${report.completed}/${queue.length}; failed ${report.failed.length}`);
    if (report.aborted) break;
  }
  report.finishedAt = new Date().toISOString();
  await atomicJson(reportPath, report);
  output(`Report: ${reportPath}`);
  return { ...report, reportPath, exitCode: report.failed.length ? 1 : 0 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--help")) console.log("Usage: node scripts/translate-events.mjs [--provider google|libre] [--limit 500]");
  else runTranslations(parseOptions(process.argv.slice(2))).then(result => { process.exitCode = result.exitCode; }).catch(error => { console.error(error); process.exitCode = 1; });
}
