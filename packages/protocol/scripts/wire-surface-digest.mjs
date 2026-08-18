import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import ts from "typescript";

const protocolRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");
const sourceRoot = join(protocolRoot, "src");

export const WIRE_ROOTS = [
  ["src/messages.ts", "WSInboundMessageSchema"],
  ["src/messages.ts", "WSOutboundMessageSchema"],
  ["src/connection-offer.ts", "ConnectionOfferSchema"],
  ["src/host-connection-schema.ts", "DirectTcpHostConnectionSchema"],
  ["src/client-capabilities.ts", "CLIENT_CAPS"],
  ["src/binary-frames/demux.ts", "decodeBinaryFrame"],
  ["src/binary-frames/browser-stream.ts", "encodeBrowserStreamFrame"],
  ["src/binary-frames/browser-stream.ts", "decodeBrowserStreamFrame"],
  ["src/binary-frames/file-transfer.ts", "encodeFileTransferFrame"],
  ["src/binary-frames/file-transfer.ts", "decodeFileTransferFrame"],
  ["src/binary-frames/terminal.ts", "encodeTerminalStreamFrame"],
  ["src/binary-frames/terminal.ts", "decodeTerminalStreamFrame"],
];

function collectSourceFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "generated") continue;
      files.push(...collectSourceFiles(path));
      continue;
    }
    if (
      entry.isFile() &&
      extname(entry.name) === ".ts" &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".d.ts")
    ) {
      files.push(path);
    }
  }
  return files;
}

function normalizedTokens(node, sourceFile) {
  const text = node.getText(sourceFile);
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    text,
  );
  const tokens = [];
  for (;;) {
    const kind = scanner.scan();
    if (kind === ts.SyntaxKind.EndOfFileToken) break;
    if (
      kind === ts.SyntaxKind.WhitespaceTrivia ||
      kind === ts.SyntaxKind.NewLineTrivia ||
      kind === ts.SyntaxKind.SingleLineCommentTrivia ||
      kind === ts.SyntaxKind.MultiLineCommentTrivia ||
      kind === ts.SyntaxKind.ShebangTrivia
    ) {
      continue;
    }
    tokens.push(`${kind}:${scanner.getTokenText()}`);
  }
  return tokens.join("\n");
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function digestTypeScriptDeclaration(source, name) {
  const sourceFile = ts.createSourceFile(
    "wire-mutation.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  return sha256(normalizedTokens(findRootDeclaration(sourceFile, name), sourceFile));
}

function topLevelDeclaration(node) {
  let current = node;
  while (current.parent && !ts.isSourceFile(current.parent)) {
    if (ts.isVariableDeclaration(current) && ts.isVariableDeclarationList(current.parent)) {
      return current;
    }
    current = current.parent;
  }
  return current;
}

function declarationName(node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) return node.name.text;
  if ("name" in node && node.name && ts.isIdentifier(node.name)) return node.name.text;
  return null;
}

function declarationKey(node, sourceFile) {
  const name = declarationName(node);
  if (!name) return null;
  const path = relative(protocolRoot, sourceFile.fileName).split(sep).join("/");
  return `${path}#${name}`;
}

function findRootDeclaration(sourceFile, name) {
  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === name) return declaration;
      }
      continue;
    }
    if ("name" in statement && statement.name && ts.isIdentifier(statement.name)) {
      if (statement.name.text === name) return statement;
    }
  }
  throw new Error(`${relative(protocolRoot, sourceFile.fileName)} no longer declares ${name}`);
}

function isProtocolDeclaration(declaration) {
  const sourceFile = declaration.getSourceFile();
  return sourceFile.fileName.startsWith(`${sourceRoot}${sep}`);
}

function resolveReferencedDeclarations(node, checker) {
  const declarations = [];
  function visit(child) {
    if (ts.isIdentifier(child)) {
      let symbol = checker.getSymbolAtLocation(child);
      if (symbol?.flags & ts.SymbolFlags.Alias) {
        symbol = checker.getAliasedSymbol(symbol);
      }
      for (const declaration of symbol?.declarations ?? []) {
        const top = topLevelDeclaration(declaration);
        if (isProtocolDeclaration(top)) declarations.push(top);
      }
    }
    ts.forEachChild(child, visit);
  }
  ts.forEachChild(node, visit);
  return declarations;
}

export function computeWireSurface(root = protocolRoot) {
  if (resolve(root) !== protocolRoot) {
    throw new Error("wire surface digest currently supports the protocol package root only");
  }
  const files = collectSourceFiles(sourceRoot);
  const program = ts.createProgram(files, {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    skipLibCheck: true,
  });
  const checker = program.getTypeChecker();
  const result = {};

  for (const [file, name] of WIRE_ROOTS) {
    const absolutePath = join(protocolRoot, file);
    const sourceFile = program.getSourceFile(absolutePath);
    if (!sourceFile) throw new Error(`Unable to load ${file}`);
    const queue = [findRootDeclaration(sourceFile, name)];
    const visited = new Map();

    while (queue.length > 0) {
      const declaration = queue.shift();
      const declarationSource = declaration.getSourceFile();
      const key = declarationKey(declaration, declarationSource);
      if (!key || visited.has(key)) continue;
      visited.set(key, sha256(normalizedTokens(declaration, declarationSource)));
      queue.push(...resolveReferencedDeclarations(declaration, checker));
    }

    const members = [...visited.entries()].sort(([left], [right]) => left.localeCompare(right));
    const rootKey = `${file}#${name}`;
    result[rootKey] = {
      digest: sha256(members.map(([key, digest]) => `${key}=${digest}`).join("\n")),
      declarationCount: members.length,
    };
  }

  return result;
}

export function readWireLedger() {
  return JSON.parse(readFileSync(join(protocolRoot, "wire-compat-ledger.json"), "utf8"));
}

export function checkWireLedger(ledger = readWireLedger(), current = computeWireSurface()) {
  const failures = [];
  const knownRoots = new Set(Object.keys(current));
  for (const [root, actual] of Object.entries(current)) {
    const baseline = ledger.roots?.[root];
    const approved = (ledger.compatibleChanges ?? []).find(
      (entry) => entry.root === root && entry.digest === actual.digest,
    );
    if (baseline?.digest !== actual.digest && !approved) {
      failures.push(
        `${root} changed to ${actual.digest} (${actual.declarationCount} declarations) without a digest-scoped compatibility rationale`,
      );
    }
  }
  for (const root of Object.keys(ledger.roots ?? {})) {
    if (!knownRoots.has(root))
      failures.push(`${root} is in the ledger but no longer in WIRE_ROOTS`);
  }
  for (const change of ledger.compatibleChanges ?? []) {
    if (!knownRoots.has(change.root)) failures.push(`stale compatibility entry for ${change.root}`);
    if (typeof change.rationale !== "string" || change.rationale.trim().length < 20) {
      failures.push(`compatibility entry for ${change.root} needs a specific rationale`);
    }
  }
  return failures;
}
