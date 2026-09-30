/**
 * Where a BILL cursor may be followed (issue #60).
 *
 * `DIVVY_LIST_TOOLS` pins which listings page and `PAGING_SPECS` pins how each
 * knob is witnessed — but nothing pinned *where the walk happens*. So a module
 * that wanted to page wrote its own loop: the budget assembler had one, and so
 * did `listPendingAction`. Both stopped on `next === cursor` until #33's witness
 * was pasted into each by hand, because the rule lived in src/divvy-paging.ts
 * and the loops lived elsewhere. The next improvement to the walker would have
 * missed them the same way.
 *
 * Following a cursor means reading the `nextPage` BILL put on a page. So this
 * asks the TypeScript checker, for every non-test source file, what each
 * `nextPage` read resolves to — and outside src/divvy-paging.ts it may only be
 * the cursor `walkBillPages` hands back (`Walked.nextPage`) or the one a result
 * builder is given to hand on (`CursorListInput.nextPage`). A read of
 * `BillPage.nextPage`, or of a `nextPage` on a type cast in place (which is how
 * `listPendingAction` read it), is a second walker and fails here by name.
 * `PagingCheck` — the witness a walker needs — may likewise only be built there.
 *
 * It is a checker walk rather than a grep because the names are ordinary:
 * `walked.nextPage` is a sanctioned read and `resp.nextPage` is not, and only
 * the types can tell them apart.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const SRC = path.dirname(fileURLToPath(import.meta.url));
const PAGING_MODULE = path.join(SRC, "divvy-paging.ts");

/** The `nextPage` declarations a module other than the walker may read. */
const SANCTIONED = new Set([
  "divvy-paging.ts:Walked.nextPage",
  "divvy-rows.ts:CursorListInput.nextPage",
]);

function program(): ts.Program {
  const configPath = path.join(SRC, "..", "tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));
  return ts.createProgram(parsed.fileNames, parsed.options);
}

/** `file:Owner.nextPage` for a declaration, or `file:<type literal>` when anonymous. */
function describeDecl(decl: ts.Declaration): string {
  const file = path.relative(SRC, decl.getSourceFile().fileName);
  const owner = decl.parent;
  const name =
    (ts.isInterfaceDeclaration(owner) || ts.isClassDeclaration(owner)) && owner.name
      ? owner.name.text
      : "<type literal>";
  return `${file}:${name}.nextPage`;
}

function where(node: ts.Node): string {
  const sf = node.getSourceFile();
  const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
  return `${path.relative(SRC, sf.fileName)}:${line + 1}`;
}

/** Every read of a `nextPage` outside the walker, and every `new PagingCheck`. */
function offences(prog: ts.Program): string[] {
  const checker = prog.getTypeChecker();
  const found: string[] = [];

  const judge = (at: ts.Node, symbol: ts.Symbol | undefined) => {
    const decls = symbol?.declarations ?? [];
    const named = decls.map(describeDecl);
    if (named.length === 0) {
      found.push(`${where(at)} reads a \`nextPage\` the checker cannot place`);
    } else if (!named.some((d) => SANCTIONED.has(d))) {
      found.push(`${where(at)} follows BILL's cursor itself (reads ${named.join(" / ")})`);
    }
  };

  for (const sf of prog.getSourceFiles()) {
    if (sf.isDeclarationFile || !sf.fileName.startsWith(SRC)) continue;
    if (sf.fileName.endsWith(".test.ts") || sf.fileName === PAGING_MODULE) continue;

    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node) && node.name.text === "nextPage") {
        judge(node, checker.getSymbolAtLocation(node.name));
      } else if (
        ts.isElementAccessExpression(node) &&
        ts.isStringLiteralLike(node.argumentExpression) &&
        node.argumentExpression.text === "nextPage"
      ) {
        judge(node, checker.getSymbolAtLocation(node.argumentExpression));
      } else if (
        ts.isBindingElement(node) &&
        ts.isObjectBindingPattern(node.parent) &&
        (node.propertyName ?? node.name).getText() === "nextPage"
      ) {
        const type = checker.getTypeAtLocation(node.parent);
        judge(node, type.getProperty("nextPage"));
      } else if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "PagingCheck"
      ) {
        found.push(`${where(node)} builds its own \`PagingCheck\` — a walker outside walkBillPages`);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return found;
}

test("a BILL cursor is followed only by walkBillPages", () => {
  const found = offences(program());
  assert.deepEqual(
    found,
    [],
    "BILL pages are walked in src/divvy-paging.ts (`walkBillPages`, which takes `maxPages` when a " +
      "walk needs its own bound), so a paging rule added there reaches every listing:\n  " +
      found.join("\n  "),
  );
});

test("the pin sees a hand-rolled walk — the shape the budget assembler used to have", () => {
  // The same check, pointed at a file holding the loop #60 removed.
  const dir = path.join(SRC, "__walker_fixture__");
  const file = path.join(dir, "hand-rolled.ts");
  const source = `
    import { PagingCheck, type BillPage } from "../divvy-paging.js";
    export async function walk(fetchPage: (c?: string) => Promise<BillPage<unknown>>) {
      const paging = new PagingCheck();
      const page = await fetchPage(paging.page);
      paging.observe(page.results, page.nextPage);
      const cast = (await fetchPage()) as { results?: unknown[]; nextPage?: string };
      const { nextPage } = cast;
      return nextPage;
    }
  `;
  const base = program();
  const host = ts.createCompilerHost(base.getCompilerOptions());
  const read = host.readFile.bind(host);
  host.readFile = (f) => (path.resolve(f) === file ? source : read(f));
  const exists = host.fileExists.bind(host);
  host.fileExists = (f) => path.resolve(f) === file || exists(f);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (f, lang, ...rest) =>
    path.resolve(f) === file
      ? ts.createSourceFile(f, source, lang)
      : getSourceFile(f, lang, ...rest);

  const prog = ts.createProgram([...base.getRootFileNames(), file], base.getCompilerOptions(), host);
  const found = offences(prog).filter((o) => o.startsWith("__walker_fixture__"));
  assert.equal(found.length, 3, found.join("\n"));
  assert.match(found[0], /builds its own `PagingCheck`/);
  assert.match(found[1], /reads divvy-paging\.ts:BillPage\.nextPage/);
  assert.match(found[2], /<type literal>\.nextPage/);
});
