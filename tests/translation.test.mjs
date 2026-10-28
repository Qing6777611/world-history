import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hashText } from "../scripts/event-records.mjs";
import { markedInput, packBatches, parseMarkedOutput, translationQueue, validateTranslation } from "../scripts/translation-utils.mjs";
import { createTranslator, parseOptions, readCache, runTranslations } from "../scripts/translate-events.mjs";

const entry = source => ({ key: hashText(source), source, year: 2000 });
const response = text => new Response(JSON.stringify([[[text, null, null, null]]]), { status: 200, headers: { "Content-Type": "application/json" } });
const translator = options => createTranslator({ interval: 0, sleepFn: async () => {}, ...options });
const first = entry("The treaty ends the war between the countries.");
const second = entry("The railway opens between the capital and the port.");
const firstZh = "条约结束了这两个国家之间的战争。";
const secondZh = "首都与港口之间的铁路正式开通。";

async function fixture(t, rows, cache = {}, manual = {}) {
  const root = await mkdtemp(join(tmpdir(), "history-translations-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "public/data/events/year"), { recursive: true });
  await mkdir(join(root, ".cache"));
  await writeFile(join(root, "public/data/events/year/2000.json"), JSON.stringify(rows));
  await writeFile(join(root, ".cache/translations.json"), JSON.stringify(cache));
  await writeFile(join(root, ".cache/translations-manual.json"), JSON.stringify(manual));
  return root;
}

const row = (item, extra = {}) => ({ de: item.source, dz: null, dzSrc: null, y: item.year, ...extra });

test("batch IDs map reordered output and reject missing, duplicate, unknown, and empty IDs", () => {
  const entries = [first, second];
  assert.deepEqual(parseMarkedOutput(`[E0002] ${secondZh}\n[E0001] ${firstZh}`, entries), [firstZh, secondZh]);
  for (const text of [`[E0001] ${firstZh}`, `[E0001] ${firstZh}\n[E0001] ${secondZh}`, `[E9999] ${firstZh}\n[E0002] ${secondZh}`, `[E0001]\n[E0002] ${secondZh}`, `译文：[E0001] ${firstZh}\n[E0002] ${secondZh}`]) {
    assert.throws(() => parseMarkedOutput(text, entries));
  }
  const batches = packBatches(Array.from({ length: 50 }, () => entry("x".repeat(480))));
  assert.equal(batches.flat().length, 50);
  assert.ok(batches.every(batch => markedInput(batch).length <= 3500));
});

test("numeric validation accepts Chinese and scaled equivalents, but rejects changed quantities", () => {
  for (const [source, text] of [
    ["The earthquake kills 10,000 people in the city.", "地震在这座城市造成1万人死亡。"],
    ["The city has 2.5 million residents after the census.", "人口普查显示该市有250万居民。"],
    ["The project costs 1 billion dollars to complete.", "该项目完工共花费10亿美元。"],
    ["The deal is valued at 78.7 billion dollars.", "这项交易的价值为787 亿美元。"],
    ["The company pays 34.3 billion dollars for the deal.", "该公司为这笔交易支付343 亿美元。"],
    ["The attack kills 8 people and injures 6 others.", "袭击造成八人死亡，另外六人受伤。"],
    ["The war of 1768–74 ends with a new treaty.", "1768—1774年的战争因一项新条约结束。"],
  ]) {
    const result = validateTranslation(source, text);
    assert.equal(result.valid, true, JSON.stringify(result));
    assert.ok(result.review.length > 0);
  }
  assert.equal(validateTranslation("The earthquake kills 200 people in the city.", "地震造成2000人死亡。").valid, false);
  assert.equal(validateTranslation("The attack kills 8 people and injures 6 others.", "袭击造成9人死亡，另外7人受伤。").valid, false);
  assert.equal(validateTranslation(first.source, first.source).valid, false);
  assert.equal(validateTranslation(first.source, "条约条约条约条约条约条约结束战争。").valid, false);
  assert.equal(validateTranslation(first.source, "中").valid, false);
});

test("real translation failures preserve trillion, currency abbreviations, measured units and leading decimals", () => {
  const examples = [
    ["US President Joe Biden signs the $1.9 trillion American Rescue Plan into law.", "美国总统乔·拜登签署总额为1.9万亿美元的《美国救援计划》，使其成为法律。"],
    ["Almost £53m (about $92.5 million or €78 million) was stolen from a Securitas depot in Tonbridge, Kent.", "肯特郡汤布里奇的Securitas仓库被盗近5300万英镑（约合9250万美元或7800万欧元）。"],
    ["Hurricane Iniki strikes the island of Kauaʻi, Hawaii, killing seven and causing $3.1bn in economic damages.", "飓风“伊尼基”袭击夏威夷考艾岛，造成7人死亡及31亿美元的经济损失。"],
    ["The spill releases 4.2 million m3 (1.1 billion US gal) of coal fly ash slurry.", "泄漏释放出420万立方米（11亿美制加仑）的粉煤灰浆。"],
    ["The fire consumes 250,000 acres (1,000 km2) and destroys 2,200 homes.", "大火烧过25万英亩（1000平方公里）的土地，并摧毁2200座住宅。"],
    ["The agreement covers 180,000 square kilometres (69,000 mi2) of land.", "这份协议涉及18万平方公里（6.9万平方英里）的土地。"],
    ["The Exxon Valdez spills 240,000 barrels (38,000 m3) of crude oil after running aground.", "埃克森·瓦尔迪兹号搁浅后，泄漏24万桶（3.8万立方米）原油。"],
    ["Samuel Colt establishes his first factory to produce the recently patented production-model revolver, the .34-caliber Paterson.", "塞缪尔·柯尔特建立首座工厂，生产刚获专利的量产型0.34口径帕特森左轮手枪。"],
  ];
  for (const [source, text] of examples) assert.equal(validateTranslation(source, text).valid, true, source);
});

test("unit exceptions do not hide ordinary numbers, identifiers, formulas, or ambiguous decimal notation", () => {
  const changed = [
    ["The bridge spans 53m across the river.", "这座桥横跨河流，跨度为5300万米。"],
    ["The company pays £53m for the factory.", "该公司花5300英镑购买这座工厂。"],
    ["The spill releases 38,000 m3 of oil into the sea.", "泄漏使3800立方米石油进入海中。"],
    ["The M3 tank is shown to the public.", "M4坦克向公众展示。"],
    ["The crater releases H2S gas, killing 149 villagers.", "火山口释放H3S气体，造成149名村民死亡。"],
    ["IBM announces its System/360 computer system.", "IBM宣布推出System/370计算机系统。"],
    ["The .34-caliber revolver enters production.", "34口径左轮手枪投入生产。"],
    ["The account describes 40.000 nobles at the gathering.", "这段记述称聚会上有40000名贵族。"],
  ];
  for (const [source, text] of changed) assert.equal(validateTranslation(source, text).valid, false, source);
});

test("queue resumes invalid English cache entries, skips usable cache and protects manual translations", () => {
  const repetitive = entry("The emperor dies and another ruler takes his place.");
  const manual = entry("The queen signs the treaty and ends the conflict.");
  const cache = { [first.key]: first.source, [second.key]: secondZh, [repetitive.key]: "皇帝皇帝皇帝皇帝皇帝去世，新统治者继位。" };
  const rows = [row(first), row(second), row(repetitive, { dz: cache[repetitive.key], dzSrc: "mt" }), row(manual)];
  const queue = translationQueue(rows, cache, { [manual.key]: "女王签署条约，结束冲突。" }, new Set([repetitive.key]));
  assert.deepEqual(new Set(queue.map(item => item.key)), new Set([first.key, repetitive.key]));
  assert.equal(translationQueue(rows, cache, { [manual.key]: "女王签署条约，结束冲突。" }, new Set()).length, 1);
});

test("English output in a correctly marked batch gets a single-item translation fallback", async () => {
  const inputs = [];
  const translate = translator({ fetchFn: async url => {
    const input = url.searchParams.get("q"); inputs.push(input);
    return response(inputs.length === 1 ? `[E0001] ${first.source}\n[E0002] ${secondZh}` : firstZh);
  } });
  const result = await translate([first, second]);
  assert.equal(inputs.length, 2);
  assert.equal(inputs[1], first.source);
  assert.ok(result.every(item => item.valid));
  assert.deepEqual(result.map(item => item.text), [firstZh, secondZh]);
});

test("missing batch IDs trigger bounded splitting, never positional assignment", async () => {
  let calls = 0;
  const translate = translator({ fetchFn: async url => {
    calls++;
    if (calls === 1) return response(`[E0001] ${firstZh}`);
    return response(`[E0001] ${url.searchParams.get("q").includes(first.source) ? firstZh : secondZh}`);
  } });
  const result = await translate([first, second]);
  assert.equal(calls, 3);
  assert.deepEqual(result.map(item => item.text), [firstZh, secondZh]);
});

test("403 is permanent and 429 retries finitely on the same host", async () => {
  let calls = 0;
  const forbidden = translator({ fetchFn: async () => { calls++; return new Response("Forbidden", { status: 403 }); } });
  await assert.rejects(forbidden([first]), error => error.permanent && /403/.test(error.message));
  assert.equal(calls, 1);
  const hosts = [], waits = [];
  const limited = translator({ sleepFn: async ms => waits.push(ms), fetchFn: async url => { hosts.push(url.hostname); return new Response("Limited", { status: 429 }); } });
  await assert.rejects(limited([first]), /429/);
  assert.equal(hosts.length, 3);
  assert.deepEqual(new Set(hosts), new Set(["translate.google.com"]));
  assert.deepEqual(waits, [1000, 2000]);
});

test("only transport failures use the Google fallback, and malformed single responses terminate", async () => {
  const hosts = [];
  const translate = translator({ fetchFn: async url => {
    hosts.push(url.hostname);
    if (hosts.length === 1) throw new TypeError("fetch failed", { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } });
    return response(`[E0001] ${firstZh}`);
  } });
  assert.equal((await translate([first]))[0].valid, true);
  assert.deepEqual(hosts, ["translate.google.com", "translate.googleapis.com"]);
  let calls = 0;
  const malformed = translator({ fetchFn: async () => { calls++; return new Response("{}", { status: 200 }); } });
  assert.equal((await malformed([first]))[0].valid, false);
  assert.equal(calls, 2);
});

test("checkpoints preserve good entries, report failures, and reruns request only unfinished sentences", async t => {
  const root = await fixture(t, [row(first), row(second)], { [first.key]: first.source, legacy: "保留已有译文。" });
  const initial = await runTranslations({ root, output: () => {}, translate: async entries => entries.map(item => ({ ...item, text: item.key === first.key ? firstZh : item.source })) });
  assert.equal(initial.exitCode, 1);
  assert.equal(initial.completed, 1);
  assert.equal(initial.failed.length, 1);
  const cache = await readCache(join(root, ".cache/translations.json"));
  assert.equal(cache[first.key], firstZh);
  assert.equal(cache.legacy, "保留已有译文。");
  assert.equal(JSON.parse(await readFile(initial.reportPath, "utf8")).failed[0].key, second.key);
  const retried = [];
  const resumed = await runTranslations({ root, output: () => {}, translate: async entries => { retried.push(...entries.map(item => item.key)); return entries.map(item => ({ ...item, text: secondZh })); } });
  assert.equal(resumed.exitCode, 0);
  assert.deepEqual(retried, [second.key]);
});

test("permanent provider failure stops subsequent batches and marks them unattempted", async t => {
  const entries = Array.from({ length: 40 }, (_, i) => entry(`Event ${i}: ${"Historical events are documented in this account. ".repeat(6)}`));
  const root = await fixture(t, entries.map(item => row(item)));
  let calls = 0;
  const result = await runTranslations({ root, output: () => {}, translate: async () => { calls++; throw Object.assign(new Error("HTTP 403"), { permanent: true }); } });
  assert.equal(calls, 1);
  assert.equal(result.exitCode, 1);
  assert.equal(result.failed.length, entries.length);
  assert.ok(result.failed.some(item => item.reasons.includes("not-attempted-provider-failure")));
});

test("a corrupt cache is not replaced and limit zero stays zero", async t => {
  const root = await fixture(t, []);
  const path = join(root, ".cache/translations.json");
  await writeFile(path, "{broken");
  await assert.rejects(readCache(path), /refusing to overwrite/);
  assert.equal(await readFile(path, "utf8"), "{broken");
  assert.equal(parseOptions(["--limit", "0"]).limit, 0);
  assert.throws(() => parseOptions(["--limit"]));
  assert.throws(() => parseOptions(["--limit", "-1"]));
  assert.throws(() => parseOptions(["--provider", "unknown"]));
});
