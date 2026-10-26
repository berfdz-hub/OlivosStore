import fs from "node:fs";
fs.mkdirSync("dist", { recursive: true });
for (const file of [
  "index.html",
  "operador.html",
  "reportes.html",
  "styles.css",
  "config.js",
  "manifest.json",
])
  fs.copyFileSync(file, "dist/" + file);
for (const dir of ["lib", "icons"])
  fs.cpSync(dir, "dist/" + dir, { recursive: true });
console.log(
  "Built static application in dist (no SQL, test fixtures or development files).",
);
