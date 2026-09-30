const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (m, file) => m._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, file);
const { completeScriptCast, expandCastGroups } = require('../lib/script-cast.ts');

test('two-person supporting groups in the script become distinct reusable assets', () => {
  const outline = { characters: [{ name: '林远' }, { name: '陈锋' }, { name: '艾娃' }], scenes: [], script:
    '[两名身穿制服的安保人员从门口出现，礼貌但坚定地请陈锋离开会议室。]\n林远：锁定航向。' };
  const repaired = completeScriptCast(outline);
  assert.deepEqual(repaired.characters.slice(-2).map(c => c.name), ['安保人员甲', '安保人员乙']);
  assert.ok(repaired.characters.slice(-2).every(c => c.gender === '未知' && /独立单人设定/.test(c.appearance)));
  assert.deepEqual(expandCastGroups(['安保人员'], repaired.characters.map(c => c.name)), ['安保人员甲', '安保人员乙']);
});

test('a model-only role is not accepted when the source provides no such person', () => {
  const outline = { characters: [{ name: '林远' }], scenes: [], script: '林远：继续前进。' };
  const repaired = completeScriptCast(outline, ['安保人员']);
  assert.deepEqual(repaired.characters.map(c => c.name), ['林远']);
});
