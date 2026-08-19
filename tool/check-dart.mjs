#!/usr/bin/env node
/**
 * check-dart — a Flutter app is VISIBLE to the corpus, which it was not.
 *
 * `npm run check:dart` (needs a build). No model, no network: a throwaway Flutter-shaped tree and the
 * real language + walk code run against it.
 *
 * THE FAILURE THIS COMES FROM. `languageFor()` is not only entangle's — the corpus walk
 * (`indulge/discover.ts#walkSources`) uses it to decide which files exist at all, `targetsFor()` uses it
 * for the entities a file declares, and `importEdges` uses it for the reference graph. It knew C# and
 * TypeScript, so on a real repo every domain scoped to a Flutter `lib/` discovered ZERO files — including
 * the scope-seeding fallback that exists precisely to rescue a domain whose words missed. The build said
 * "matched nothing", which reads as "there is no such feature".
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
if (!process.argv.includes('-p')) process.argv.push('-p');

let fails = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) fails++;
};

const { languageFor } = await import(`file://${join(ROOT, 'dist', 'entangle', 'index.js')}`);
const { importEdges, seedsByPathWords } = await import(`file://${join(ROOT, 'dist', 'indulge', 'discover.js')}`);
const { targetsFor } = await import(`file://${join(ROOT, 'dist', 'indulge', 'questions.js')}`);

const repo = mkdtempSync(join(tmpdir(), 'ayin-dart-'));
const write = (rel, body) => {
  const p = join(repo, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
  return rel;
};

write('pubspec.yaml', [
  'name: demo_client',
  'version: 1.2.3+45',
  'dependencies:',
  '  flutter:',
  '    sdk: flutter',
  '  provider: ^6.0.0',
  '  http: ^1.0.0        # a comment',
  'dev_dependencies:',
  '  flutter_test:',
  '    sdk: flutter',
  'flutter:',
  '  uses-material-design: true',
  '',
].join('\n'));

const WIDGET = [
  "import 'dart:async';",
  "import 'package:flutter/material.dart';",
  "import 'package:provider/provider.dart';",
  "import '../services/chat_repo.dart';",
  '',
  'class ChatPane extends StatefulWidget {',
  '  const ChatPane({super.key, required this.sessionId});',
  '  final String sessionId;',
  '  @override',
  '  State<ChatPane> createState() => _ChatPaneState();',
  '}',
  '',
  'class _ChatPaneState extends State<ChatPane> {',
  '  final ScrollController _scroll = ScrollController();',
  '  bool _busy = false;',
  '  late final ChatRepo _repo;',
  '  String get title => "chat";                 // a getter, not a field',
  '  set busy(bool v) => setState(() => _busy = v);',
  '  @override',
  '  void initState() {',
  '    super.initState();',
  '    if (widget.sessionId.isEmpty) { return; }  // must not be read as a member',
  '  }',
  '  Future<List<String>> load({int limit = 20}) async => _repo.recent(limit);',
  '  @override',
  '  Widget build(BuildContext context) => const SizedBox();',
  '}',
  '',
  'mixin Retry {',
  '  int attempts = 0;',
  '}',
  '',
  'enum Phase { idle, sending }',
  '',
].join('\n');
const widget = write('lib/widgets/chat_pane.dart', WIDGET);
write('lib/services/chat_repo.dart', [
  "import 'package:http/http.dart' as http;",
  'class ChatRepo {',
  '  Future<List<String>> recent(int n) async => [];',
  '}',
  '',
].join('\n'));
write('lib/generated/api.g.dart', 'class Generated { int x = 1; }\n');

// ── the language answers at all ───────────────────────────────────────────────────

console.log('\nlanguageFor');
const lang = languageFor(join(repo, widget));
ok(lang?.id === 'dart', 'a .dart file HAS a language now — this is what made a Flutter app invisible', lang?.id ?? 'null');
ok(languageFor(join(repo, 'lib/generated/api.g.dart')) === null,
  'generated output (*.g.dart) is not a surface anyone maintains, so it stays invisible');

// ── the surface ─────────────────────────────────────────────────────────────────

console.log('\nsurfaceOf');
const types = lang.surfaceOf(WIDGET);
const byName = new Map(types.map((t) => [t.name, t]));
ok(byName.has('ChatPane') && byName.has('_ChatPaneState'), 'both classes are found',
  types.map((t) => t.name).join(', '));
ok(byName.get('Retry')?.kind === 'interface', 'a mixin declares a surface, not a unit', byName.get('Retry')?.kind);
ok(byName.get('Phase')?.kind === 'enum', 'an enum is an enum');
const state = byName.get('_ChatPaneState');
const m = new Map((state?.members ?? []).map((x) => [x.name, x]));
ok(m.get('load')?.kind === 'method', 'a method with a generic return type is a method', m.get('load')?.sig);
ok(m.get('build')?.kind === 'method', 'so is build(BuildContext)');
ok(m.get('title')?.kind === 'field', 'a GETTER is a field to a reader — it is read like one', m.get('title')?.sig);
ok(m.get('_scroll')?.kind === 'field' && m.get('_scroll')?.visibility === 'private',
  'a leading underscore IS the access modifier in Dart', m.get('_scroll')?.visibility);
ok(m.get('_busy')?.kind === 'field', 'a plain bool field is a field');
ok(!m.has('if') && !m.has('return') && !m.has('super'),
  'and a statement inside a method body is not a member', [...m.keys()].join(','));

// ── the dependency unit ─────────────────────────────────────────────────────────

console.log('\ndomainOf (pubspec.yaml is the unit)');
const d = lang.domainOf(join(repo, widget));
ok(d?.name === 'demo_client', 'the package name comes from pubspec', d?.name);
ok(d?.allows.includes('provider') && d?.allows.includes('http'), 'so do its dependencies', d?.allows.join(','));
ok(d?.allows.includes('flutter_test'), 'dev_dependencies count too — a test file imports them legitimately');
ok(!d?.allows.includes('uses-material-design'),
  'and the `flutter:` config block at the end is not a dependency list', d?.allows.join(','));
ok(lang.isPlatform('flutter', d) === true, 'flutter is the platform, not a chosen dependency');
ok(lang.isBuiltinType('Widget') && lang.isBuiltinType('BuildContext') && lang.isBuiltinType('Future'),
  'the Flutter furniture is builtin — a false stop on Widget makes the tool unusable');

console.log('\nreferencesOf');
const refs = lang.referencesOf(WIDGET);
ok(refs.includes('provider') && refs.includes('flutter'), 'package: imports are the references', refs.join(','));
ok(!refs.some((r) => r.startsWith('dart:')) && !refs.includes('dart'), 'dart: is the SDK, never a dependency');
ok(!refs.some((r) => r.includes('chat_repo')), 'and a relative import is inside the package — its own business');

// ── the reference WALK, which is what makes a corpus deep instead of flat ────────

console.log('\nimportEdges (the depth-1 hop)');
const edges = importEdges(repo, widget, WIDGET);
ok(edges.includes('lib/services/chat_repo.dart'),
  'a relative `../services/chat_repo.dart` resolves to the file it names', edges.join(', ') || '(none)');
ok(!edges.some((e) => e.includes('package:')), 'a package import is not a file in this repo');

console.log('\ntargetsFor (what questions get asked about)');
const targets = targetsFor(widget, WIDGET, 12);
ok(targets.length > 1, 'the file is no longer the ONLY thing askable about itself', `${targets.length} target(s)`);
ok(targets.some((t) => t?.name === '_ChatPaneState'), 'the state class is a target');
ok(targets.some((t) => t?.kind === 'method'), 'and so are its methods', targets.filter((t) => t?.kind === 'method').length + ' method target(s)');

// ── seeding a SCOPED domain, which is how a Flutter domain ever gets any files ────
//
// Measured on a real app: "chat" scoped to `client/lib` produced ZERO seeds — explore searched the whole
// repo and every candidate was refused for being out of scope, and the path-word helper required the
// whole domain name to appear as one word in the path (`joined.length < 6` returned nothing for "chat").
// Four different domains then fell through to the same eighteen shortest-path files.
console.log('\nseeding a scoped domain by name');
write('lib/widgets/chat_pane.dart', "class ChatPane {}\n");
write('lib/widgets/chat_input.dart', "class ChatInput {}\n");
write('lib/screens/diary_page.dart', "class DiaryPage {}\n");
const chatSeeds = seedsByPathWords(repo, 'chat', 18, [], 'lib');
ok(chatSeeds.length >= 2 && chatSeeds.every((f) => /chat/.test(f)),
  'a one-word domain finds its files inside the scope', chatSeeds.join(', '));
ok(chatSeeds.every((f) => !f.startsWith('/')), 'and the seeds are repo-RELATIVE — an absolute one breaks every later read',
  chatSeeds[0] ?? '(none)');
ok(!chatSeeds.some((f) => /diary/.test(f)), 'a file that matches no word is not a seed');
ok(seedsByPathWords(repo, 'diary', 18, [], 'lib').some((f) => /diary_page/.test(f)),
  'and a different domain gets DIFFERENT files — the whole point');
ok(seedsByPathWords(repo, 'chat', 18, [], 'lib/screens').length === 0,
  'a scope with nothing matching stays empty rather than seeding the shortest paths it can find');
ok(seedsByPathWords(repo, 'chat', 18, []).length === 0,
  'UNSCOPED, the narrow concatenation rule still holds — 67 loose seeds was the measured failure');

rmSync(repo, { recursive: true, force: true });
console.log(fails ? `\ndart check: ${fails} FAILURE(S)\n` : '\ndart check: ok\n');
process.exit(fails ? 1 : 0);
