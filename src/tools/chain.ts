/** Chain read tools over ABCI. No indexer or signer involved. */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RpcClient } from "../rpc.js";
import { absentToNull, absentReason, guard, ok, parseAminoAccount } from "./util.js";

export function registerChainTools(server: McpServer, rpc: RpcClient): void {
  server.registerTool(
    "gno_eval",
    {
      title: "Eval (read-only)",
      description:
        "Evaluate a read-only Gno expression against a realm via ABCI vm/qeval, e.g. " +
        "`TotalSupply()` or `BalanceOf(\"g1…\")`. Returns the raw typed result string. Never mutates state.",
      inputSchema: {
        pkgpath: z.string().describe("realm pkgpath, e.g. gno.land/r/gnoswap/gns"),
        expr: z.string().describe("a Go call expression on the realm, e.g. `TotalSupply()` or `BalanceOf(\"g1…\")`"),
      },
    },
    ({ pkgpath, expr }) =>
      guard(async () => {
        const result = await rpc.qeval(`${pkgpath}.${expr}`);
        // A reason means the query itself was invalid, not that the value is empty.
        const reason = absentReason(result);
        return ok({ pkgpath, expr, result: absentToNull(result), ...(reason ? { reason } : {}) });
      }),
  );

  server.registerTool(
    "gno_render",
    {
      title: "Render realm",
      description:
        "Fetch a realm's Render(path) output via ABCI vm/qrender: the markdown page the realm " +
        "serves at gno.land/r/…:path.",
      inputSchema: {
        pkgpath: z.string().describe("realm pkgpath"),
        path: z.string().optional().default("").describe("render sub-path (default empty)"),
      },
    },
    ({ pkgpath, path }) =>
      guard(async () => {
        const result = await rpc.qrender(pkgpath, path ?? "");
        const rendered = absentToNull(result);
        if (rendered !== null) return ok(rendered);
        const reason = absentReason(result);
        return ok(reason ? `(no render output: ${reason})` : "(no render output)");
      }),
  );

  server.registerTool(
    "gno_package_files",
    {
      title: "Package files & functions",
      description: "List a package's source files (vm/qfile) and exported function signatures (vm/qfuncs).",
      inputSchema: { pkgpath: z.string().describe("package pkgpath") },
    },
    ({ pkgpath }) =>
      guard(async () => {
        const [files, funcs] = await Promise.all([rpc.qfile(pkgpath), rpc.qfuncs(pkgpath)]);
        const filesStr = absentToNull(files);
        const funcsStr = absentToNull(funcs);
        let functions: unknown = funcsStr;
        if (funcsStr) {
          try {
            functions = JSON.parse(funcsStr);
          } catch {
            // Not JSON; return the raw string.
          }
        }
        // Both absent with a reason means the pkgpath is invalid.
        const reason = filesStr === null && funcsStr === null ? absentReason(files) : undefined;
        return ok({
          pkgpath,
          files: filesStr ? filesStr.split("\n").filter(Boolean) : [],
          functions,
          ...(reason ? { reason } : {}),
        });
      }),
  );

  server.registerTool(
    "gno_get_balances",
    {
      title: "Get balances",
      description:
        "Native coin balances (ugnot etc.) and account number/sequence for an address, via ABCI auth/accounts.",
      inputSchema: { address: z.string().describe("g1… address") },
    },
    ({ address }) =>
      guard(async () => {
        const result = await rpc.authAccount(address);
        const reason = absentReason(result);
        const raw = absentToNull(result);
        const parsed = raw !== null ? parseAminoAccount(raw) : null;
        // A query error and an address with no account share the same shape.
        if (parsed === null) {
          return ok({
            address,
            account: null,
            balances: [],
            note: reason ?? "no on-chain account for this address (never transacted or not an auth account)",
          });
        }
        return ok({
          address,
          balances: parsed.balances,
          account_number: parsed.account_number,
          sequence: parsed.sequence,
          public_key: parsed.public_key,
          account_raw: raw,
          ...(reason ? { note: reason } : {}),
        });
      }),
  );

  server.registerTool(
    "gno_status",
    {
      title: "Chain status",
      description: "Chain tip: latest height, chain ID, and block time, plus which RPC endpoint answered.",
      inputSchema: {},
    },
    () => guard(async () => ok(await rpc.status())),
  );
}
