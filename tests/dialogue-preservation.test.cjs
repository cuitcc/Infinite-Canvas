const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (m, file) => m._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, file);
const d = require('../lib/dialogue-plan.ts');
const { buildDialogueInjection } = require('../lib/dialogue.ts');

// Opening lines from the reported production failure: three cast omissions and two inline colons.
const script = `【场景：地球控制中心】
官员甲：信号来源确认了？
技术员：确认。来源坐标与'先驱号'最后消失的位置重合。重复发送的是同一段数据。
官员乙：内容是什么？
技术员：大部分是乱码，但解码组刚刚还原出一张地形图，还有...一组几何图案。
林远：（转身，面无表情）什么样的图案？
技术员：（犹豫）非欧几里得几何。我们的计算机无法构建它的三维模型。
官员甲：林指挥官，这是命令。带'望舒号'去源头看一眼。
林远：（点头）是。
【场景：望舒号舰桥】
林远：曲速引擎预热。目标：奥尔特云边缘。
张远：引擎响应正常。预计进入盲区时间：四小时。`;
const originalNames = ['林远', '艾娃', '张远'];
const additions = d.missingDialogueCharacters(script, originalNames.map(name => ({ name })));
const names = [...originalNames, ...additions.map(c => c.name)];

test('omitted supporting cast are restored, with no guessed gender or script rewrite', () => {
  assert.deepEqual(additions.map(c => c.name), ['官员甲', '技术员', '官员乙']);
  assert.ok(additions.every(c => c.gender === '未知' && c.voiceProfile && c.appearance));
  assert.equal(d.extractDialogue(script, new Set(originalNames)).length, 10, 'unknown speakers are never silently discarded');
  assert.throws(() => d.groupDialogueLines(script, originalNames), /缺少角色设定/);
  assert.deepEqual(d.missingDialogueCharacters(script, names.map(name => ({ name }))), []);
});

test('colons in an existing speakers sentence retain destinations, times and explanatory clauses', () => {
  const lines = d.extractDialogue(script, new Set(names));
  assert.equal(lines[8].text, '曲速引擎预热。目标：奥尔特云边缘');
  assert.equal(lines[9].text, '引擎响应正常。预计进入盲区时间：四小时');
  assert.deepEqual(d.extractDialogue('林远：请记住：目标：奥尔特云。张远：收到。', new Set(names)), [
    { speaker: '林远', text: '请记住：目标：奥尔特云' }, { speaker: '张远', text: '收到' },
  ]);
});

test('the reported incomplete plan fails the coverage gate; repaired plan covers all original words in order', () => {
  assert.throws(() => d.assertDialogueCoverage(script, names, [[], ['林远：什么样的图案', '林远：是'],
    ['林远：曲速引擎预热', '张远：引擎响应正常']]), /不完整或顺序不一致/);
  const plan = d.planShotDialogue(script, names, 3);
  assert.ok(plan.length > 3, 'expand capacity instead of cramming remaining lines into one shot');
  d.assertDialogueCoverage(script, names, plan);
  assert.ok(plan.every(lines => lines.length <= 2));
  const contexts = d.planShotContexts(script, names, 3);
  assert.deepEqual(contexts.map(row => row.map(s => s.split('精确台词=')[1])), plan);
  assert.ok(plan.flat().some(s => s.includes('官员甲：信号来源确认了')));
  assert.ok(plan.flat().some(s => s.includes('预计进入盲区时间：四小时')));
});

test('long speech is split within the model duration while preserving every character and scene context', () => {
  const long = '【场景：舰桥】\n林远：' + '目标坐标已经确认，我们继续保持当前航向，等待下一次信号传输。'.repeat(5);
  const plan = d.planShotDialogue(long, ['林远'], 2);
  assert.ok(plan.length > 2);
  d.assertDialogueCoverage(long, ['林远'], plan);
  const contexts = d.planShotContexts(long, ['林远'], 2);
  assert.deepEqual(contexts.map(row => row.map(s => s.split('精确台词=')[1])), plan);
  for (const lines of plan.filter(x => x.length)) {
    assert.ok(lines.reduce((sum, line) => sum + d.estimateSpeechSeconds(line), 0) + 1.25 <= 12);
  }
});

test('parenthetical facts remain spoken; leading stage directions and meta lines are excluded', () => {
  const source = '场景：舰桥\n音效：低沉嗡鸣\n林远（低声）：（看向屏幕）验证代码（A12）保持原样。';
  assert.deepEqual(d.extractDialogue(source, new Set(['林远'])), [{ speaker: '林远', text: '验证代码（A12）保持原样' }]);
  assert.equal(d.missingDialogueCharacters(source, [{ name: '林远' }]).length, 0);
  const injection = buildDialogueInjection('林远：验证代码（A12）保持原样\n林远：继续前进', 1, ['林远'], 8);
  assert.ok(injection.includes('验证代码（A12）保持原样'));
  assert.ok(injection.includes('继续前进'));
  assert.ok(!injection.includes('一人只说自己名下的一句'));
});

test('coverage detects reordered, missing, duplicated and reassigned dialogue', () => {
  const source = '林远：保持航向。\n张远：收到。';
  for (const plan of [[['张远：收到', '林远：保持航向']], [['林远：保持航向']],
    [['林远：保持航向', '张远：收到', '张远：收到']], [['张远：保持航向', '林远：收到']]]) {
    assert.throws(() => d.assertDialogueCoverage(source, ['林远', '张远'], plan), /不完整或顺序不一致/);
  }
});
