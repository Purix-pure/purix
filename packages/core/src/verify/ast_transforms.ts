// src/verify/ast_transforms.ts
import {
  Project,
  Node,
  SyntaxKind,
  VariableDeclarationKind,
  ts,
  type SourceFile,
  type Statement,
  type Block,
  type FunctionDeclaration,
  type ArrowFunction,
  type FunctionExpression,
} from "ts-morph";

type TransformResult = { ok: true; content: string } | { ok: false; reason: string };

type FnLikeNode = FunctionDeclaration | ArrowFunction | FunctionExpression;

function parseInMemory(content: string, path: string): SourceFile | null {
  try {
    const project = new Project({
      useInMemoryFileSystem: true,
      compilerOptions: { jsx: ts.JsxEmit.Preserve, allowJs: true, target: ts.ScriptTarget.ES2020 },
    });
    return project.createSourceFile(path, content);
  } catch {
    return null;
  }
}

/**
 * Restricted to TOP-LEVEL declarations only (direct children of the source
 * file) — the original test script used `forEachDescendant`, which also
 * matches a same-named function nested inside some other function and
 * would silently rewrite the wrong (shadowed) one. Also skips bodyless
 * function declarations (TS overload signatures), which previously caused
 * a real function with legitimate overloads to always be reported as
 * "ambiguous" even though there's exactly one real implementation.
 */
function findTopLevelFunctionsByName(sourceFile: SourceFile, name: string): { node: FnLikeNode }[] {
  const matches: { node: FnLikeNode }[] = [];

  for (const fn of sourceFile.getFunctions()) {
    if (fn.getName() === name && fn.getBody() !== undefined) matches.push({ node: fn });
  }

  for (const varStmt of sourceFile.getVariableStatements()) {
    for (const decl of varStmt.getDeclarationList().getDeclarations()) {
      const nameNode = decl.getNameNode();
      if (!Node.isIdentifier(nameNode) || nameNode.getText() !== name) continue;
      const init = decl.getInitializer();
      if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
        matches.push({ node: init });
      }
    }
  }

  return matches;
}

function getAsyncBlockBody(fnNode: FnLikeNode, functionName: string): { ok: true; body: Block } | { ok: false; reason: string } {
  if (!fnNode.isAsync()) {
    return { ok: false, reason: `"${functionName}" isn't async — this transform only applies to async functions` };
  }
  const body = fnNode.getBody();
  if (!body || !Node.isBlock(body)) {
    return { ok: false, reason: `"${functionName}" has a concise (non-block) arrow body — rewrite it with braces first, then retry` };
  }
  return { ok: true, body };
}

function findTarget(
  content: string,
  path: string,
  functionName: string
): { ok: true; sourceFile: SourceFile; body: Block } | { ok: false; reason: string } {
  const sourceFile = parseInMemory(content, path);
  if (!sourceFile) return { ok: false, reason: `AST parse failed for "${path}"` };

  const matches = findTopLevelFunctionsByName(sourceFile, functionName);
  if (matches.length === 0) {
    return {
      ok: false,
      reason: `no top-level function or const/let-assigned arrow/function expression named "${functionName}" found in ${path}`,
    };
  }
  if (matches.length > 1) {
    return { ok: false, reason: `"${functionName}" matches ${matches.length} separate top-level definitions in ${path} — ambiguous, refusing to guess` };
  }

  const bodyResult = getAsyncBlockBody(matches[0]!.node, functionName);
  if (!bodyResult.ok) return bodyResult;
  return { ok: true, sourceFile, body: bodyResult.body };
}

// ---------------------------------------------------------------------------
// add_error_handling: wraps a whole async function body in a capped retry loop.
// ---------------------------------------------------------------------------

export function applyErrorHandlingTransform(
  content: string,
  path: string,
  functionName: string,
  maxRetries: number
): TransformResult {
  if (!Number.isInteger(maxRetries) || maxRetries < 1 || maxRetries > 10) {
    return { ok: false, reason: `max_retries must be an integer between 1 and 10, got ${maxRetries}` };
  }

  const target = findTarget(content, path, functionName);
  if (!target.ok) return target;
  const { sourceFile, body } = target;

  const statements = body.getStatements();
  if (statements.length === 0) {
    return { ok: false, reason: `"${functionName}" has an empty body — nothing to wrap` };
  }
  if (statements.length === 1 && Node.isTryStatement(statements[0]!)) {
    return { ok: false, reason: `"${functionName}" already has a top-level try/catch — refusing to double-wrap` };
  }
  if (body.getFullText().includes("__purix_lastError")) {
    return { ok: false, reason: `"${functionName}" already has a Purix-generated retry wrapper — refusing to double-wrap` };
  }

  const originalBodyText = statements.map((s) => s.getFullText()).join("");

  const newBodyText = `{
  let __purix_lastError: unknown;
  for (let __purix_attempt = 1; __purix_attempt <= ${maxRetries}; __purix_attempt++) {
    try {
${originalBodyText}
    } catch (__purix_err) {
      __purix_lastError = __purix_err;
      if (__purix_attempt === ${maxRetries}) throw __purix_err;
    }
  }
  throw __purix_lastError;
}`;

  body.replaceWithText(newBodyText);
  return { ok: true, content: sourceFile.getFullText() };
}

// ---------------------------------------------------------------------------
// change_control_flow: merges N adjacent, independent `const x = await f()`
// statements into one `const [x, y] = await Promise.all([f(), g()])`.
// ---------------------------------------------------------------------------

interface AwaitDeclCandidate {
  index: number;
  name: string;
  isConst: boolean;
  initText: string;
  initNode: Node;
}

/** Only matches `const/let <identifier> = await <expr>;` — no destructuring, no multi-declarator statements, so the statement-to-variable mapping stays 1:1 and unambiguous. */
function findAwaitDeclCandidates(statements: Statement[]): Map<string, AwaitDeclCandidate> {
  const map = new Map<string, AwaitDeclCandidate>();
  statements.forEach((stmt, index) => {
    if (!Node.isVariableStatement(stmt)) return;
    const declList = stmt.getDeclarationList();
    const decls = declList.getDeclarations();
    if (decls.length !== 1) return;
    const decl = decls[0]!;
    const nameNode = decl.getNameNode();
    if (!Node.isIdentifier(nameNode)) return;
    const init = decl.getInitializer();
    if (!init || !Node.isAwaitExpression(init)) return;
    const name = nameNode.getText();
    if (map.has(name)) return; // shouldn't happen in valid TS, but don't overwrite silently
    map.set(name, {
      index,
      name,
      isConst: declList.getDeclarationKind() === VariableDeclarationKind.Const,
      initText: init.getExpression().getText(),
      initNode: init.getExpression(),
    });
  });
  return map;
}

export function applyControlFlowTransform(
  content: string,
  path: string,
  functionName: string,
  variableNames: string[]
): TransformResult {
  const uniqueNames = [...new Set(variableNames)];
  if (uniqueNames.length < 2) {
    return { ok: false, reason: `change_control_flow needs at least 2 distinct variable names to parallelize, got ${JSON.stringify(variableNames)}` };
  }

  const target = findTarget(content, path, functionName);
  if (!target.ok) return target;
  const { sourceFile, body } = target;

  const statements = body.getStatements();
  const candidates = findAwaitDeclCandidates(statements);

  const selected: AwaitDeclCandidate[] = [];
  for (const name of uniqueNames) {
    const c = candidates.get(name);
    if (!c) {
      return {
        ok: false,
        reason: `"${name}" isn't a simple top-level "const/let ${name} = await <expr>;" statement in "${functionName}" — refusing to guess how to parallelize it`,
      };
    }
    selected.push(c);
  }

  const indices = selected.map((c) => c.index).sort((a, b) => a - b);
  if (new Set(indices).size !== indices.length) {
    return { ok: false, reason: `duplicate statement matched for the same variable name — refusing to guess` };
  }
  const minIdx = indices[0]!;
  const maxIdx = indices[indices.length - 1]!;
  if (maxIdx - minIdx + 1 !== indices.length) {
    return {
      ok: false,
      reason: `the requested statements in "${functionName}" aren't contiguous — something else sits between them, refusing to reorder around it`,
    };
  }

  // Real dependency check: if statement A's expression references another
  // selected variable, that's a genuine sequential dependency, not
  // something safe to parallelize. Fails closed rather than guessing.
  const selectedNames = new Set(selected.map((c) => c.name));
  for (const c of selected) {
    const identifiers = c.initNode.getDescendantsOfKind(SyntaxKind.Identifier).map((n) => n.getText());
    if (Node.isIdentifier(c.initNode)) identifiers.push(c.initNode.getText());
    for (const id of identifiers) {
      if (id !== c.name && selectedNames.has(id)) {
        return {
          ok: false,
          reason: `"${c.name}"'s expression references "${id}", another statement you're trying to parallelize — that's a real sequential dependency, refusing to parallelize`,
        };
      }
    }
  }

  const ordered = [...selected].sort((a, b) => a.index - b.index);
  const useLet = ordered.some((c) => !c.isConst);
  const declKeyword = useLet ? "let" : "const";
  const namesList = ordered.map((c) => c.name).join(", ");
  const exprsList = ordered.map((c) => c.initText).join(", ");
  const newStatementText = `${declKeyword} [${namesList}] = await Promise.all([${exprsList}]);`;

  const before = statements.slice(0, minIdx).map((s) => s.getFullText()).join("");
  const after = statements.slice(maxIdx + 1).map((s) => s.getFullText()).join("");
  const replacedSpan = statements.slice(minIdx, maxIdx + 1).map((s) => s.getFullText()).join("");
  const leadingTrivia = replacedSpan.match(/^\s*/)?.[0] ?? "\n  ";

  const newBodyText = `{${before}${leadingTrivia}${newStatementText}${after}}`;

  body.replaceWithText(newBodyText);
  return { ok: true, content: sourceFile.getFullText() };
}