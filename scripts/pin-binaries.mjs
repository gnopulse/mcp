// Adds the platform gnotx packages built into npm/ to package.json as exact optionalDependencies.
// Runs only in the release job: the packages do not exist on the registry before that release,
// so they cannot be in the development lockfile.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const pkgPath = join(root, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));

const deps = {};
for (const dir of readdirSync(join(root, "npm")).sort()) {
  const { name, version } = JSON.parse(readFileSync(join(root, "npm", dir, "package.json"), "utf8"));
  if (version !== pkg.version) throw new Error(`${name} is ${version}, expected ${pkg.version}`);
  deps[name] = version;
}
if (Object.keys(deps).length === 0) throw new Error("no packages in npm/; run scripts/build-binaries.sh first");

pkg.optionalDependencies = deps;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
console.log(Object.entries(deps).map(([n, v]) => `${n}@${v}`).join("\n"));
