import { createRequire } from "node:module";

/** Package version, read from package.json so it always matches the published release. */
export const VERSION: string = (createRequire(import.meta.url)("../package.json") as { version: string }).version;
