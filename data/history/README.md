# 历史疆域数据

生产数据在 `public/data/history/`。`coverage.json` 同时复制到本目录供界面静态读取；完整来源和局限见生产目录的 `ATTRIBUTION.md`。

## 固定来源和离线构建

- Cliopatria **v0.2.0**，固定 commit、下载地址和 SHA-256 位于 `source.json`。
- 原始压缩包保留在 `.cache/history/cliopatria-v0.2.0.geojson.zip`，不发布、不提交。构建会验证校验和。
- Python 构建通过 PEP 723 固定 Python 3.12、Shapely 2.1.2 和 NumPy 2.5.4。安装 [uv](https://docs.astral.sh/uv/) 后执行：

```sh
uv run scripts/build-historical-geography.py
uv run scripts/build-historical-geography.py --offline
```

首个命令只在缺压缩包时下载固定来源；第二个命令禁止数据下载，缺包或校验失败会报错。Python 运行环境需要提前安装或存在于 uv 缓存；要同时禁止 uv 安装依赖时使用 `uv run --offline scripts/build-historical-geography.py --offline`。现有事件年分片和本目录中文名称快照都是必需输入。

## 名称快照

`names-zh.json` 是构建用中文名称，英文源名称保留不变。优先使用 `name-overrides.json` 中经项目检查的名称，再使用 `wikidata-zh.json` 中与英文源名称或别名相符的中文标签，最后使用 `names-mt.json` 中按英文名称保存的机器翻译。RELATION 不能复用某个组成部分的 QID 标签。最终中文统一经 OpenCC 转简体。`reviewed` 含 AI 辅助复核，不表示人工权威考订；`mt` 表示机器翻译。

正常构建不会访问 Wikidata 或翻译服务。显式刷新名称：

```sh
node scripts/build-historical-geography-names.mjs
node scripts/build-historical-geography-names.mjs --offline
uv run scripts/build-historical-geography.py --offline --names-only
```

名称脚本使用几何构建生成的 `.cache/history/polities.json`。网络模式先补缺失 Wikidata 标签，遵循限速和 Retry-After；剩余名称单独翻译并保留来源。离线模式缺标签或译名会失败。已有快照不会自动被远端更新覆盖。`--allow-missing-names` 仅供开发预览，正式构建要求所有实体有中文名称。

## 几何和年份语义

源边界使用经纬度。构建修复无效多边形、处理日界线、将同一源名称/类型的同时存在部分合为一个实体；独立政权和 RELATION 复合关系保持不同 ID。ID 使用类型及源名称的 SHA-256 前 16 位，不依赖现代国家编码。

年份采用历史纪年：-1 为公元前 1 年，没有 0 年，区间两端包含。固定源中 6 个以 0 结束的 BCE 区间裁至 -1，其他年份不平移。几何按时间自适应分片，每片原始 JSON 目标不超过 3 MB，单个年份的必要几何超限时不强行丢弃实体。显示几何使用保拓扑简化（0.06 度）和 0.0001 度坐标精度；相邻且显示完全相同的阶段可合并。多边形外环逆时针，内环顺时针。

事件索引使用事件发生年份与坐标，查询修复后的**未简化**边界。边界点允许多重命中；POLITY 排在 RELATION 前，同类按源面积从小到大。没有坐标、超出年份覆盖、未命中都输出空数组。索引不使用事件的现代国家字段。源数据未覆盖的地区不代表当时没有政权或史事。

源数据包含已知旧称沿用和跨时代混名，例如 2024 仍有 Mali Federation、Serbia-Montenegro、Estado Novo，Later Zhou 同名记录跨公元前及 960 年，Tangier International Zone 从 1912 年开始。本项目保留源时期/几何并公开局限；名称翻译或 Wikidata 标签不构成对每个历史时期的独立验证。

## 验证

`npm test` 包含数据范围与分片完整性、唯一 ID、中英文名称、环方向、年份有效性、事件索引覆盖、无坐标不推断、重叠关系以及中文匹配规则检查。`build-report.json` 记录实测数量、几何体积与修复统计。

几何纯函数另有 Python 测试（年零、日界线孔洞、同期几何合并、微小实体保留）：

```sh
uv run --python 3.12 --with shapely==2.1.2 --with numpy==2.5.4 tests/history-pipeline.py
```

正式产物可重复执行离线构建比较各文件 SHA-256；JSON 输出和 gzip 体积统计均不含运行时间戳。
