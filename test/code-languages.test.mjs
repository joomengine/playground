import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzePhp, PhpProjectIndex } from '../src/code/languages-php.mjs';
import { completeHtml, htmlDocument } from '../src/code/languages-html.mjs';

const factory = `<?php
namespace Joomla\u005cCMS;
class Factory {
  public static string $version;
  public static function getApplication(): Application {}
  public function run(string $task): void {}
  private function secret() {}
}
`;
function project() {
  const index = new PhpProjectIndex();
  index.update('/libraries/src/Factory.php', factory);
  return index;
}

test('PHP syntax diagnostics have source coordinates and track the selected runtime minor', () => {
  const hooks = '<?php class A { public string $name { get => "name"; } }';
  const previous = analyzePhp(hooks, '/a.php', '8.3');
  assert.match(previous.diagnostics[0].message, /require PHP 8\.4/);
  assert.equal(previous.diagnostics[0].startColumn, hooks.indexOf('{ get') + 1);
  assert.match(previous.diagnostics[0].source, /PHP 8\.3/);
  assert.deepEqual(analyzePhp(hooks, '/a.php', '8.4').diagnostics, []);
  assert.deepEqual(analyzePhp(hooks, '/a.php', '8.5').diagnostics, []);
  assert.throws(() => analyzePhp(hooks, '/a.php', '7.4'), /Unsupported/);
  const invalid = analyzePhp('<?php function bad( {', '/bad.php');
  assert.ok(invalid.diagnostics.length);
  for (const diagnostic of invalid.diagnostics) assert.ok(diagnostic.endColumn > diagnostic.startColumn);
});

test('mixed PHP templates retain HTML positions and complete real HTML attributes/tags', () => {
  const source = '<div><?php echo "<ignored>"; ?>\n<span cla';
  const analysis = analyzePhp(source, '/template.php');
  assert.deepEqual(analysis.diagnostics, []);
  const html = htmlDocument(source, analysis.inline).getText();
  assert.equal(html.length, source.length);
  assert.ok(!html.includes('<ignored>'));
  assert.equal(html.indexOf('<span'), source.indexOf('<span'));
  const items = completeHtml(source, analysis.inline, source.length, '/template.php');
  const attribute = items.find(item => item.label === 'class');
  assert.ok(attribute);
  assert.equal(attribute.editRange.start.line, 1);
  assert.equal(attribute.editRange.start.character, 6);
  assert.equal(completeHtml(source, analysis.inline, source.indexOf('echo') + 2, '/template.php'), null);
});

test('Joomla aliases resolve cross-file static completion and precise definitions', () => {
  const index = project();
  const source = '<?php namespace My\u005cModule; use Joomla\u005cCMS\u005cFactory as Site; Site::getApplication();';
  index.update('/module.php', source);
  const offset = source.indexOf('getApplication') + 6;
  const items = index.complete('/module.php', source, offset);
  assert.deepEqual(items.map(item => item.label), ['getApplication']);
  const [definition] = index.definition('/module.php', source, offset);
  assert.equal(definition.path, '/libraries/src/Factory.php');
  assert.equal(definition.selectionRange.startLineNumber, 5);
  const aliasOffset = source.lastIndexOf('Site') + 2;
  assert.equal(index.definition('/module.php', source, aliasOffset)[0].qualifiedName, 'Joomla\u005cCMS\u005cFactory');
  const aliasItem = index.complete('/module.php', source, aliasOffset).find(item => item.label === 'Site');
  assert.equal(aliasItem.insertText, 'Site');
});

test('typed parameters, new assignments and namespace-scope variables resolve instance members', () => {
  const index = project();
  for (const source of [
    '<?php use Joomla\u005cCMS\u005cFactory; function go(Factory $f) { $f->run(); }',
    '<?php namespace Demo; use Joomla\u005cCMS\u005cFactory; $f = new Factory(); $f->run();',
  ]) {
    index.update('/module.php', source, 1);
    const offset = source.indexOf('->run') + 4;
    assert.deepEqual(index.complete('/module.php', source, offset).map(item => item.label), ['run']);
    assert.equal(index.definition('/module.php', source, offset)[0].qualifiedName, 'Joomla\u005cCMS\u005cFactory::run');
    assert.ok(!index.complete('/module.php', source, offset - 2).some(item => item.label === 'secret'));
  }
});

test('$this, inherited members and trait methods are indexed without exposing other private methods', () => {
  const index = new PhpProjectIndex();
  index.update('/base.php', '<?php namespace Demo; trait Handy { public function handle() {} } class Base { public function inherited() {} private function hidden() {} }');
  const source = '<?php namespace Demo; class Child extends Base { use Handy; private function own() {} public function go() { $this->inherited(); } }';
  index.update('/child.php', source);
  const offset = source.indexOf('->inherited') + 2;
  const names = index.complete('/child.php', source, offset).map(item => item.label);
  assert.ok(names.includes('inherited'));
  assert.ok(names.includes('handle'));
  assert.ok(names.includes('own'));
  assert.ok(!names.includes('hidden'));
  assert.equal(index.definition('/child.php', source, offset + 3)[0].path, '/base.php');
});

test('static property and fully qualified completions replace the complete PHP token', () => {
  const index = project();
  const source = '<?php \u005cJoomla\u005cCMS\u005cFactory::$ver';
  index.update('/module.php', source);
  const [item] = index.complete('/module.php', source, source.length);
  assert.equal(item.label, '$version');
  assert.equal(source.slice(item.replaceStart, item.replaceEnd), '$ver');
  const classSource = '<?php \u005cJoomla\u005cCMS\u005cFact';
  index.update('/module.php', classSource, 1);
  const completion = index.complete('/module.php', classSource, classSource.length).find(value => value.label === 'Factory');
  assert.equal(completion.insertText, '\u005cJoomla\u005cCMS\u005cFactory');
  assert.equal(completion.replaceStart, 6);
});

test('namespace resolution never jumps to an unrelated same-name class', () => {
  const index = project();
  const source = '<?php namespace Wrong; new Factory();';
  index.update('/module.php', source);
  assert.deepEqual(index.definition('/module.php', source, source.indexOf('Factory') + 2), []);
  const unknown = '<?php $unknown->run();';
  index.update('/module.php', unknown, 1);
  assert.deepEqual(index.definition('/module.php', unknown, unknown.indexOf('run') + 2), []);
  assert.deepEqual(index.complete('/module.php', unknown, unknown.indexOf('run') + 2), []);
  index.update('/global.php', '<?php function run() {} class App { public function run() {} }');
  for (const source of ['<?php make()->run();', '<?php $this->app->run();']) {
    index.update('/module.php', source, 2);
    assert.deepEqual(index.definition('/module.php', source, source.indexOf('run') + 2), []);
  }
});

test('file replacement and deletion remove obsolete declarations and reject stale updates', () => {
  const index = project();
  assert.ok(index.allSymbols().some(item => item.name === 'Factory'));
  index.update('/libraries/src/Factory.php', '<?php class Renamed {}', 2);
  assert.ok(!index.allSymbols().some(item => item.name === 'Factory'));
  assert.deepEqual(index.update('/libraries/src/Factory.php', factory, 1), { stale: true });
  index.remove('/libraries');
  assert.deepEqual(index.status(), { files: 0, bytes: 0, phpVersion: '8.3' });
});

test('project limits bound bytes and files without returning stale declarations for an unanalyzed update', () => {
  const index = new PhpProjectIndex({ limits: { files: 1, bytes: 100, fileBytes: 50 } });
  index.update('/a.php', '<?php class A {}');
  assert.equal(index.update('/b.php', '<?php class B {}').limited, true);
  assert.equal(index.update('/a.php', '<?php '.padEnd(60, ' ')).limited, true);
  assert.equal(index.files.has('/a.php'), false);
  assert.equal(index.status().files, 0);
  for (const path of ['/../bad.php', '/a/./bad.php', '/bad\\path.php', 'relative.php']) assert.throws(() => index.update(path, '<?php'));
});

test('document symbols include namespaces, signatures, properties and constants at their real locations', () => {
  const analysis = analyzePhp('<?php namespace Demo; class A { const KEY = 1; public string $name; public function work(int $count): void {} } function helper() {}', '/a.php');
  const names = analysis.symbols.map(item => item.name);
  assert.deepEqual(names, ['A', 'KEY', 'name', 'work', 'helper']);
  const method = analysis.symbols.find(item => item.name === 'work');
  assert.equal(method.container, 'Demo\u005cA');
  assert.equal(method.signature, 'work(int $count): void');
  assert.ok(method.selectionRange.startColumn > method.range.startColumn);
});

test('constructor-promoted properties appear in the class outline and $this completion', () => {
  const source = '<?php class A { public function __construct(public readonly App $app, private int $count) {} public function go() { $this->app; } }';
  const index = new PhpProjectIndex();
  index.update('/a.php', source);
  const property = index.files.get('/a.php').symbols.find(item => item.name === 'app');
  assert.equal(property.kind, 'property');
  assert.equal(property.container, 'A');
  const offset = source.indexOf('->app') + 4;
  assert.equal(index.complete('/a.php', source, offset)[0].label, 'app');
  assert.equal(index.definition('/a.php', source, offset)[0].selectionRange.startColumn, source.indexOf('$app') + 1);
});

test('definition lookup respects PHP case-sensitive property and constant names', () => {
  const index = new PhpProjectIndex();
  const source = '<?php const FLAG = 1; class A { public $name; function go() { $this->NAME; } } echo flag;';
  index.update('/a.php', source);
  assert.deepEqual(index.definition('/a.php', source, source.indexOf('->NAME') + 4), []);
  assert.deepEqual(index.definition('/a.php', source, source.lastIndexOf('flag') + 2), []);
});
