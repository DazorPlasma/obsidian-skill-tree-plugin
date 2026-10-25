import { watch as watchFile } from "node:fs";
import { copyFile, unlink } from "node:fs/promises";
import { build, context } from "esbuild";

const watch = process.argv.includes("--watch");

await unlink("plugin/main.css").catch((error) => {
  if (error?.code !== "ENOENT") throw error;
});

const options = {
  entryPoints: ["plugin/src/main.ts"],
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: "es2020",
  outfile: "plugin/main.js",
  external: ["obsidian"],
  assetNames: "pkg/[name]",
  loader: { ".wasm": "binary" },
  sourcemap: false,
  minify: !watch,
  logOverride: { "empty-import-meta": "silent" },
};

await copyFile("plugin/src/styles.css", "plugin/styles.css");

if (watch) {
  const buildContext = await context(options);
  await buildContext.watch();
  watchFile("plugin/src/styles.css", () => {
    void copyFile("plugin/src/styles.css", "plugin/styles.css").catch((error) => {
      console.error("Stylesheet copy failed:", error);
    });
  });
  console.log("Watching for changes");
} else {
  await build(options);
}
