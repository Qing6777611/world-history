import { readFile } from "node:fs/promises";
import ts from "typescript";

// Exercise the actual TypeScript modules with Node's test runner, without adding
// a second app bundler or requiring a newer Node version's type stripping.
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (error.code !== "ERR_MODULE_NOT_FOUND" || !/^\.\.?\//.test(specifier) || /\.[a-z]+$/i.test(specifier)) throw error;
    return nextResolve(`${specifier}.ts`, context);
  }
}

export async function load(url, context, nextLoad) {
  if (!url.startsWith("file:") || !url.endsWith(".ts") || url.includes("/node_modules/")) return nextLoad(url, context);
  const source = await readFile(new URL(url), "utf8");
  return {
    format: "module",
    shortCircuit: true,
    source: ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      fileName: new URL(url).pathname,
    }).outputText,
  };
}
