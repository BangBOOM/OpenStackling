import { existsSync, statSync, readFileSync, readdirSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import path from 'node:path';
import { parseSync, Visitor, type ESTree } from 'rolldown/utils';

// Keys are source owners. Entries are their permitted imports, including type imports.
const dependencies: Record<string, string[]> = {
  validation: [],
  world: ['validation'],
  scene: ['world', 'validation'],
  sensors: ['world', 'validation'],
  tasks: ['world', 'validation'],
  control: ['world', 'tasks', 'validation'],
  'theme-catalog': [],
  appearance: ['theme-catalog'],
  config: ['theme-catalog', 'world', 'sensors', 'tasks', 'control', 'validation'],
  presets: ['config', 'scene', 'world'],
  plan: ['config', 'scene', 'world', 'tasks', 'sensors', 'appearance'],
  'episode-types': ['control', 'world', 'tasks'],
  episode: [
    'theme-catalog',
    'episode-types',
    'plan',
    'config',
    'world',
    'sensors',
    'tasks',
    'appearance',
  ],
  'host-protocol': ['episode-types', 'config', 'plan', 'world', 'tasks', 'control'],
  provenance: ['world'],
  'host-wire': ['host-protocol', 'world'],
  client: [
    'host-wire',
    'theme-catalog',
    'config',
    'plan',
    'world',
    'appearance',
    'host-protocol',
    'episode-types',
  ],
  host: [
    'recording',
    'host-wire',
    'theme-catalog',
    'config',
    'plan',
    'world',
    'control',
    'appearance',
    'host-protocol',
    'episode',
    'episode-types',
  ],
  policy: ['config', 'appearance', 'episode-types', 'world', 'tasks', 'sensors'],
  recording: [
    'config',
    'appearance',
    'episode',
    'episode-types',
    'plan',
    'policy',
    'provenance',
    'control',
    'sensors',
    'scene',
    'tasks',
    'validation',
    'world',
  ],
  browser: [
    'client',
    'config',
    'plan',
    'appearance',
    'theme-catalog',
    'episode-types',
    'policy',
    'recording',
    'world',
    'sensors',
  ],
  runs: [
    'config',
    'plan',
    'appearance',
    'host',
    'host-protocol',
    'episode',
    'episode-types',
    'recording',
    'provenance',
    'policy',
    'control',
    'scene',
    'tasks',
    'world',
  ],
};
const owner = (file: string) => file.split('/')[2]?.replace(/\.tsx?$/, '');
type Edge = { file: string; kind: 'type' | 'code' | 'worker' | 'resource' };
const graph = new Map<string, Edge[]>();
const errors = new Set<string>();
const htmlEntries = ['index.html', 'worker.html'].flatMap((file) =>
  Array.from(
    readFileSync(file, 'utf8').matchAll(/<script[^>]+src="\/(.*?)"/g),
    (match) => match[1],
  ),
);
function allowed(from: string, to: string) {
  if (from.startsWith('src/simulation/') && !to.startsWith('src/simulation/')) return false;
  if (from === 'src/vite-env.d.ts') return to === 'src/runtime/config.ts';
  if (from.startsWith('src/app/')) return !to.startsWith('src/app/') || owner(from) === owner(to);
  return (
    !to.startsWith('src/app/') &&
    (owner(from) === owner(to) || dependencies[owner(from)]?.includes(owner(to)))
  );
}
function literal(
  node: ESTree.Node | null,
  constants: ReadonlyMap<string, string>,
): string | undefined {
  if (!node) return;
  if (node.type === 'Identifier') return constants.get(node.name);
  if (
    node.type === 'TSAsExpression' ||
    node.type === 'TSSatisfiesExpression' ||
    node.type === 'TSNonNullExpression'
  )
    return literal(node.expression, constants);
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral') {
    let value = node.quasis[0].value.cooked ?? '';
    for (const [index, expr] of node.expressions.entries()) {
      const part = literal(expr, constants);
      if (part === undefined) return;
      value += part + node.quasis[index + 1].value.cooked;
    }
    return value;
  }
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const left = literal(node.left, constants),
      right = literal(node.right, constants);
    if (left !== undefined && right !== undefined) return left + right;
  }
}
function inspect(file: string) {
  const source = readFileSync(file, 'utf8');
  const ast = parseSync(file, source);
  if (ast.errors.length) throw new Error(`Cannot parse ${file}: ${ast.errors[0].message}`);
  const edges: Edge[] = [];
  graph.set(file, edges);
  function add(spec: string, kind: Edge['kind']) {
    if (!spec.startsWith('.') && !spec.startsWith('@/') && !spec.startsWith('/')) {
      edges.push({ file: spec, kind });
      return;
    }
    const [name, query] = spec.split('?');
    const target = name.startsWith('@/')
      ? path.join('src', name.slice(2))
      : name.startsWith('/')
        ? name.slice(1)
        : path.join(path.dirname(file), name);
    const stem = target.replace(/\.js$/, '');
    const resolved = [
      target,
      stem + '.ts',
      stem + '.tsx',
      path.join(stem, 'index.ts'),
      path.join(stem, 'index.tsx'),
    ].find((name) => existsSync(name) && statSync(name).isFile());
    if (!resolved) {
      errors.add(`${file}: unresolved ${spec}`);
      return;
    }
    if (query === 'raw' || resolved.endsWith('.json')) kind = 'resource';
    if (kind === 'resource') {
      if (query === 'raw' && !/^src\/runtime\/browser\/render\/themes\/[^/]+\.ts$/.test(resolved))
        errors.add(`${file}: unexpected raw resource ${spec}`);
      if (
        resolved.startsWith('src/') &&
        !allowed(file, resolved) &&
        !(file === 'src/runtime/appearance.ts' && query === 'raw')
      )
        errors.add(`${file} -> ${resolved} (resource)`);
      if (resolved.endsWith('.json')) JSON.parse(readFileSync(resolved, 'utf8'));
    } else if (!allowed(file, resolved)) errors.add(`${file} -> ${resolved} (${kind})`);
    edges.push({ file: resolved, kind });
  }
  const scopes: Map<string, string>[] = [];
  function enterScope(statements: ESTree.Statement[] = [], params: ESTree.Node[] = []) {
    const constants = new Map(scopes.at(-1));
    // A destructuring pattern can shadow several outer names. Only substitute known strings.
    function hide(binding: ESTree.Node) {
      if (binding.type === 'Identifier') constants.delete(binding.name);
      else if (binding.type === 'AssignmentPattern') hide(binding.left);
      else if (binding.type === 'RestElement') hide(binding.argument);
      else if (binding.type === 'ObjectPattern')
        for (const property of binding.properties)
          hide(property.type === 'RestElement' ? property.argument : property.value);
      else if (binding.type === 'ArrayPattern')
        for (const element of binding.elements) if (element) hide(element);
    }
    params.forEach(hide);
    const declarations = statements.map((entry) =>
      entry.type === 'ExportNamedDeclaration' ? entry.declaration : entry,
    );
    for (const declaration of declarations) {
      if (declaration?.type === 'VariableDeclaration')
        for (const binding of declaration.declarations) hide(binding.id);
      if (
        (declaration?.type === 'ClassDeclaration' || declaration?.type === 'FunctionDeclaration') &&
        declaration.id
      )
        hide(declaration.id);
    }
    for (const declaration of declarations) {
      if (declaration?.type !== 'VariableDeclaration' || declaration.kind !== 'const') continue;
      for (const binding of declaration.declarations) {
        if (binding.id.type !== 'Identifier') continue;
        const value = literal(binding.init, constants);
        if (value !== undefined) constants.set(binding.id.name, value);
      }
    }
    scopes.push(constants);
  }
  const leaveScope = () => {
    scopes.pop();
  };
  const workerUrls = new Set<number>();
  new Visitor({
    Program(n) {
      enterScope(n.body);
    },
    'Program:exit': leaveScope,
    BlockStatement(n) {
      enterScope(n.body);
    },
    'BlockStatement:exit': leaveScope,
    FunctionDeclaration(n) {
      enterScope([], n.params);
    },
    'FunctionDeclaration:exit': leaveScope,
    FunctionExpression(n) {
      enterScope([], n.params);
    },
    'FunctionExpression:exit': leaveScope,
    ArrowFunctionExpression(n) {
      enterScope([], n.params);
    },
    'ArrowFunctionExpression:exit': leaveScope,
    CatchClause(n) {
      enterScope([], n.param ? [n.param] : []);
    },
    'CatchClause:exit': leaveScope,
    ImportDeclaration(n) {
      add(
        n.source.value,
        n.importKind === 'type' ||
          (n.specifiers.length > 0 &&
            n.specifiers.every((s) => s.type === 'ImportSpecifier' && s.importKind === 'type'))
          ? 'type'
          : 'code',
      );
    },
    ExportNamedDeclaration(n) {
      if (n.source)
        add(
          n.source.value,
          n.exportKind === 'type' ||
            (n.specifiers.length > 0 && n.specifiers.every((s) => s.exportKind === 'type'))
            ? 'type'
            : 'code',
        );
    },
    ExportAllDeclaration(n) {
      add(n.source.value, n.exportKind === 'type' ? 'type' : 'code');
    },
    TSImportType(n) {
      add(n.source.value, 'type');
    },
    ImportExpression(n) {
      const spec = literal(n.source, scopes.at(-1)!);
      if (spec !== undefined) add(spec, 'code');
    },
    NewExpression(n) {
      if (n.callee.type !== 'Identifier') return;
      if (n.callee.name === 'Worker' && n.arguments[0]) workerUrls.add(n.arguments[0].start);
      if (n.callee.name !== 'URL' || n.arguments.length !== 2) return;
      if (source.slice(n.arguments[1].start, n.arguments[1].end) !== 'import.meta.url') return;
      const target = literal(n.arguments[0], scopes.at(-1)!);
      if (target?.endsWith('.ts')) add(target, workerUrls.has(n.start) ? 'worker' : 'code');
    },
  }).visit(ast.program);
}
for (const file of readdirSync('src', { recursive: true, encoding: 'utf8' })) {
  if (/\.tsx?$/.test(file)) inspect(path.join('src', file));
}
const visited = new Set<string>(),
  active = new Set<string>();
function cycles(file: string, chain: string[]) {
  if (active.has(file)) {
    errors.add(`Import cycle: ${[...chain.slice(chain.indexOf(file)), file].join(' -> ')}`);
    return;
  }
  if (visited.has(file)) return;
  visited.add(file);
  active.add(file);
  for (const edge of graph.get(file) ?? [])
    if (edge.kind === 'code' && graph.has(edge.file)) cycles(edge.file, [...chain, file]);
  active.delete(file);
}
for (const file of graph.keys()) cycles(file, []);
const browserSeen = new Set<string>();
function browser(file: string, chain: string[]) {
  if (browserSeen.has(file)) return;
  browserSeen.add(file);
  if (
    isBuiltin(file) ||
    file === 'playwright' ||
    file.endsWith('.node') ||
    /^src\/(?:app\/cli\/|runtime\/(?:host\/|runs\/|provenance\.ts)|simulation\/world\/(?:binding|physics-build|simulation)\.ts)/.test(
      file,
    )
  )
    errors.add(`Browser reaches host: ${[...chain, file].join(' -> ')}`);
  for (const edge of graph.get(file) ?? [])
    if (edge.kind === 'code' || edge.kind === 'worker') browser(edge.file, [...chain, file]);
}
for (const entry of htmlEntries) {
  if (!graph.has(entry)) errors.add(`Missing browser entry: ${entry}`);
  browser(entry, []);
}
if (errors.size) throw new Error([...errors].join('\n'));
console.log(
  `Architecture verified for ${graph.size} modules and ${htmlEntries.length} browser entries.`,
);
