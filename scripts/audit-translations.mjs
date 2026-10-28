#!/usr/bin/env node
/**
 * Read-only audit of published event shards. No translation service is called.
 * Usage: node scripts/audit-translations.mjs [--data-dir <dir>] [--output <file>]
 * Missing Chinese content and inconsistent shards are errors (exit 1).
 * Repetition and possible untranslated English are review warnings (exit 0).
 * Warnings are heuristics, not a claim that every translation is correct/incorrect.
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { hashText } from "./event-records.mjs";

const DEFAULT_DATA = fileURLToPath(new URL("../public/data/events/", import.meta.url));
const hasChinese = (value) => typeof value === "string" && /\p{Script=Han}/u.test(value);
const excerpt = (value, length = 180) => value.length > length ? `${value.slice(0, length - 1)}…` : value;

export function translationWarnings(text) {
  if (typeof text !== "string" || !text) return [];
  const warnings = [];
  const repetition = /(\p{Script=Han})\1{3,}/u.exec(text)
    || /([\p{Script=Han}]{2,16})\1{2,}/u.exec(text)
    || /([\p{Script=Han}][\p{Script=Han}:：;；,，、()（） ]{1,20})\1{3,}/u.exec(text);
  if (repetition) warnings.push({
    code: "repeated_han_text",
    reason: "连续重复汉字或短语，需复核；数字型号等专名可能合理。",
    excerpt: excerpt(repetition[0]),
  });
  if (/\uFFFD|[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(text)) warnings.push({
    code: "encoding_artifact",
    reason: "正文包含替换字符或不可见控制字符。",
    excerpt: excerpt(text),
  });

  // A Latin name alone is not untranslated prose. Require a long passage with
  // English grammar words; even then emit a warning, never a missing-text error.
  const passages = text.match(/[\p{Script=Latin}][\p{Script=Latin}\p{M}\d'’.,:;()\-\s]{60,}/gu) ?? [];
  const grammar = new Set(["a", "an", "the", "is", "was", "were", "are", "of", "by", "to", "with", "and", "for", "in", "on", "that", "as", "his", "her", "its", "from", "at"]);
  for (const passage of passages) {
    const words = passage.toLowerCase().match(/[a-z]+(?:['’][a-z]+)?/g) ?? [];
    if (words.length >= 10 && words.filter((word) => grammar.has(word)).length >= 3) {
      warnings.push({ code: "long_english_residue", reason: "中文字段保留较长的疑似英文叙述；书名、引文或专名需人工判断。", excerpt: excerpt(passage.trim()) });
      break;
    }
  }
  return warnings;
}

async function readShards(dataDirectory, kind, errors) {
  const directory = join(dataDirectory, kind);
  let files;
  try {
    files = (await readdir(directory)).filter((file) => file.endsWith(".json")).sort();
  } catch (error) {
    errors.push({ code: "missing_shard_directory", shard: kind, reason: error.message });
    return { files: [], records: new Map(), rowCount: 0 };
  }
  const records = new Map();
  let rowCount = 0;
  for (const file of files) {
    const shard = `${kind}/${file}`;
    let rows;
    try {
      rows = JSON.parse(await readFile(join(directory, file), "utf8"));
      if (!Array.isArray(rows)) throw new Error("Expected an array of event records");
    } catch (error) {
      errors.push({ code: "invalid_shard", shard, reason: error.message });
      continue;
    }
    rowCount += rows.length;
    for (const row of rows) {
      if (!row || typeof row.id !== "string" || !row.id) {
        errors.push({ code: "missing_event_id", shard, reason: "事件缺少有效 ID。" });
        continue;
      }
      const expected = kind === "year" ? String(row.y) : `${String(row.m).padStart(2, "0")}-${String(row.day).padStart(2, "0")}`;
      if (file !== `${expected}.json`) errors.push({ code: "wrong_shard", id: row.id, shard, reason: `事件日期应属于 ${kind}/${expected}.json。` });
      if (records.has(row.id)) errors.push({ code: "duplicate_event_id", id: row.id, shard, reason: "同一分片集合中出现重复事件 ID。" });
      else records.set(row.id, row);
    }
  }
  return { files, records, rowCount };
}

export async function auditTranslations(dataDirectory = DEFAULT_DATA) {
  const errors = [];
  const warnings = [];
  const year = await readShards(dataDirectory, "year", errors);
  const day = await readShards(dataDirectory, "day", errors);
  if (!year.rowCount) errors.push({ code: "empty_dataset", reason: "年分片中没有事件，不能判为翻译完成。" });
  let withChineseTitle = 0;
  let withChineseDescription = 0;
  let fullyChineseEvents = 0;
  const ids = new Set([...year.records.keys(), ...day.records.keys()]);
  for (const id of ids) {
    const yearRow = year.records.get(id);
    const dayRow = day.records.get(id);
    if (!yearRow || !dayRow) errors.push({ code: "missing_shard_counterpart", id, reason: `事件缺少${yearRow ? "日" : "年"}分片副本。` });
    else if (!isDeepStrictEqual(yearRow, dayRow)) errors.push({ code: "shard_content_mismatch", id, reason: "年分片与日分片中的同一事件内容不同。" });
  }
  for (const row of year.records.values()) {
    const fields = [];
    if (hasChinese(row.t)) withChineseTitle++; else fields.push("t");
    if (hasChinese(row.dz)) withChineseDescription++; else fields.push("dz");
    if (!fields.length) fullyChineseEvents++;
    else errors.push({ code: "missing_chinese_content", id: row.id, year: row.y, fields, reason: "中文标题或正文为空、或未包含中文；英文回退不计入中文覆盖。" });
    for (const [field, text] of [["t", row.t], ["dz", row.dz]]) {
      for (const warning of translationWarnings(text)) warnings.push({ ...warning, id: row.id, year: row.y, field, key: typeof row.de === "string" ? hashText(row.de) : null });
    }
  }
  const errorCodes = {};
  const warningCodes = {};
  for (const issue of errors) errorCodes[issue.code] = (errorCodes[issue.code] ?? 0) + 1;
  for (const issue of warnings) warningCodes[issue.code] = (warningCodes[issue.code] ?? 0) + 1;
  return {
    generatedAt: new Date().toISOString(),
    dataDirectory: resolve(dataDirectory),
    passed: errors.length === 0,
    note: "覆盖与结构校验不等于语义校对通过；warnings 仅供人工复核，专名和引文不自动判错。",
    summary: {
      events: year.records.size,
      yearRows: year.rowCount,
      dayRows: day.rowCount,
      yearShards: year.files.length,
      dayShards: day.files.length,
      withChineseTitle,
      withChineseDescription,
      fullyChineseEvents,
      missingChineseTitle: year.records.size - withChineseTitle,
      missingChineseDescription: year.records.size - withChineseDescription,
      errors: errors.length,
      warnings: warnings.length,
      warningEvents: new Set(warnings.map((issue) => issue.id)).size,
      errorCodes,
      warningCodes,
    },
    errors,
    warnings,
  };
}

async function main() {
  let dataDirectory = DEFAULT_DATA;
  let output;
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    if (name === "--help") {
      process.stdout.write("Usage: node scripts/audit-translations.mjs [--data-dir <directory>] [--output <file>]\n");
      return;
    }
    if (!["--data-dir", "--output"].includes(name) || !args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`Invalid argument: ${name}`);
    const value = args[++index];
    if (name === "--data-dir") dataDirectory = resolve(value); else output = resolve(value);
  }
  const report = await auditTranslations(dataDirectory);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (output) {
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, json);
    process.stderr.write(`Translation audit: ${report.summary.errors} errors, ${report.summary.warnings} warnings; ${output}\n`);
  } else process.stdout.write(json);
  process.exitCode = report.passed ? 0 : 1;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
