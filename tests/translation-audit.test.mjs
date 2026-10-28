import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { auditTranslations, translationWarnings } from "../scripts/audit-translations.mjs";

const script = fileURLToPath(new URL("../scripts/audit-translations.mjs", import.meta.url));
const event = { id: "sample", y: 1965, m: 10, day: 23, t: "围城期间发动行动", dz: "围城期间发动了一次行动。", de: "An operation starts during the siege." };

async function withShards(yearRows, dayRows, run) {
  const directory = await mkdtemp(join(tmpdir(), "atlas-translation-audit-"));
  try {
    await mkdir(join(directory, "year"));
    await mkdir(join(directory, "day"));
    await writeFile(join(directory, "year/1965.json"), JSON.stringify(yearRows));
    await writeFile(join(directory, "day/10-23.json"), JSON.stringify(dayRows));
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("translation audit distinguishes missing Chinese from suspicious but present Chinese", async () => {
  const missing = { ...event, id: "missing", t: null, dz: null };
  const suspicious = { ...event, id: "repeat", dz: "事件正文反复反复反复反复出现。" };
  await withShards([missing, suspicious], [missing, suspicious], async (directory) => {
    const report = await auditTranslations(directory);
    assert.equal(report.passed, false);
    assert.equal(report.summary.missingChineseTitle, 1);
    assert.equal(report.summary.missingChineseDescription, 1);
    assert.equal(report.errors.length, 1);
    assert.equal(report.errors[0].code, "missing_chinese_content");
    assert.equal(report.warnings[0].code, "repeated_han_text");
    assert.equal(report.warnings[0].id, "repeat");
  });
});

test("translation audit reports different day/year content and duplicate IDs", async () => {
  await withShards([event, event], [{ ...event, dz: "与年分片不一致的中文。" }], async (directory) => {
    const report = await auditTranslations(directory);
    assert.ok(report.errors.some((issue) => issue.code === "duplicate_event_id"));
    assert.ok(report.errors.some((issue) => issue.code === "shard_content_mismatch"));
  });
});

test("Latin scientific names stay valid; long English narrative is only a warning", () => {
  assert.deepEqual(translationWarnings("研究记录 Homo sapiens 和 Escherichia coli，并由 Institut Pasteur 团队发表。"), []);
  const warnings = translationWarnings("这是一段中文。 The army of the kingdom was sent to the city and the people were forced to leave their homes.");
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, "long_english_residue");
});

test("audit CLI writes JSON only to the requested output and does not change shards", async () => {
  await withShards([event], [event], async (directory) => {
    const path = join(directory, "year/1965.json");
    const before = await readFile(path, "utf8");
    const output = join(directory, "report.json");
    const result = spawnSync(process.execPath, [script, "--data-dir", directory, "--output", output], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    const report = JSON.parse(await readFile(output, "utf8"));
    assert.equal(report.passed, true);
    assert.equal(report.summary.fullyChineseEvents, 1);
    assert.equal(await readFile(path, "utf8"), before);
  });
});
