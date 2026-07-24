import esbuild from "esbuild";
import process from "process";
import { builtinModules } from "node:module";

const banner =
  "/* This file is generated from src/main.ts. Do not edit main.js directly. */";

const prod = process.argv[2] === "production";

const context = await esbuild.context({
  banner: {
    js: banner
  },

  entryPoints: ["src/main.ts"],
  bundle: true,

  external: [
    "obsidian",
    "electron",
    ...builtinModules
  ],

  format: "cjs",
  target: "es2021",
  logLevel: "info",

  sourcemap: prod ? false : "inline",
  treeShaking: true,

  outfile: "main.js",
  minify: prod
});

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}