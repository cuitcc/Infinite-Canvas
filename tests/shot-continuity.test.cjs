const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const compile = (source) => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
require.extensions['.ts'] = (mod, file) => mod._compile(compile(fs.readFileSync(file, 'utf8')), file);
const continuity = require('../lib/shot-continuity.ts');
const dialogue = require('../lib/dialogue-plan.ts');
const { lockChapterIdentity } = require('../lib/agent-story.ts');

test('Chinese, ASCII and unbracketed scene headers retain the exact place', () => {
  for (const text of ['【场景：舰桥】', '[场景:舰桥]', '场景：舰桥', '【场景：舰桥。冷光亮起】']) {
    assert.equal(continuity.parseScriptScene(text), '舰桥');
  }
  const contexts = dialogue.extractScriptDialogueContexts('【场景：舰桥】\n雷诺：保持航向。', ['雷诺']);
  assert.equal(contexts[0].scene, '舰桥');
});

test('a placeholder cannot replace the model scene with the first historical scene', () => {
  const names = ['木星外景', '舰桥'];
  assert.equal(continuity.resolveShotScene(['场景=沿用上一场景；精确台词=雷诺：保持航向'], '舰桥', names), '舰桥');
  assert.equal(continuity.resolveShotScene(['场景=舰桥；精确台词=雷诺：保持航向'], '木星外景', names), '舰桥');
  assert.equal(continuity.resolveShotScene([], '沿用上一场景', names, '舰桥'), '舰桥');
  assert.throws(() => continuity.resolveShotScene([], undefined, names), /缺少明确场景/);
  assert.throws(() => continuity.resolveShotScene([], '木星外景', ['舰桥']), /未匹配/);
  assert.throws(() => continuity.resolveShotScene(['场景=舰桥；', '场景=木星外景；'], '舰桥', names), /多个场景/);
});

test('dialogue grouping splits at scene boundaries and keeps context/line alignment', () => {
  const script = '【场景：舰桥】\n雷诺：保持航向。\n【场景：机库】\n莉亚：已经就位。\n雷诺：准备出发。';
  assert.deepEqual(dialogue.groupDialogueLines(script, ['雷诺', '莉亚']), [
    ['雷诺：保持航向'], ['莉亚：已经就位', '雷诺：准备出发'],
  ]);
  const lines = dialogue.planShotDialogue(script, ['雷诺', '莉亚'], 4);
  const contexts = dialogue.planShotContexts(script, ['雷诺', '莉亚'], 4);
  assert.deepEqual(contexts.map((row) => row.map((s) => s.split('精确台词=')[1])), lines);
  assert.match(contexts[1][0], /^场景=舰桥；/);
  assert.match(contexts[2][0], /^场景=机库；/);
});

test('silent visible Reno remains bound alongside the speaking character', () => {
  assert.deepEqual(continuity.resolveShotCharacters(['雷诺舰长'], ['莉亚：准备好了'], ['雷诺', '莉亚']), ['雷诺', '莉亚']);
  assert.throws(() => continuity.resolveShotCharacters(['陌生人'], [], ['雷诺']), /不在本章/);
  assert.equal(continuity.resolveCharacterName('雷诺舰长', ['雷诺']), '雷诺');
  assert.equal(continuity.resolveCharacterName('小雷诺', ['雷诺']), undefined);
  assert.equal(continuity.resolveCharacterName('雷诺', ['雷诺舰长', '雷诺博士']), undefined);
  assert.equal(continuity.resolveCharacterName('雷诺舰长', ['雷诺舰长', '雷诺博士']), '雷诺舰长');
});

test('chapter aliases reuse established identity without changing spoken words', () => {
  const original = { name: '雷诺', gender: '男', age: '中年', appearance: '左眉疤痕', wardrobe: '蓝色制服', voiceProfile: '低沉', role: '舰长' };
  const next = { title: '第二章', characters: [
    { name: '雷诺舰长', gender: '女', appearance: '新面孔', wardrobe: '红衣', voiceProfile: '尖细', role: '被质疑的指挥者' },
    { name: '莉亚', appearance: '黑发' },
  ], scenes: [], script: '雷诺舰长：去找雷诺博士。\n莉亚：收到。\n【雷诺舰长转身】' };
  const locked = lockChapterIdentity(next, [{ outline: { characters: [original], scenes: [] } }]);
  assert.deepEqual(locked.characters[0], { ...original, role: '被质疑的指挥者' });
  assert.equal(locked.script, '雷诺：去找雷诺博士。\n莉亚：收到。\n【雷诺舰长转身】');
  assert.equal(next.characters[0].name, '雷诺舰长', 'does not mutate the original outline');
  const duplicate = lockChapterIdentity({ ...next, characters: [...next.characters, original] }, [{ outline: { characters: [original], scenes: [] } }]);
  assert.equal(duplicate.characters.filter((p) => p.name === '雷诺').length, 1);
});

test('reference capacity discards props/tail before people or the scene', () => {
  const required = ['雷诺', '莉亚', '舰医', '技师', '场景'].map((name) => ({ name }));
  const refs = [...required, { name: '道具·通讯器' }, { name: '上一镜尾帧' }];
  assert.deepEqual(continuity.fitShotReferences(refs), required);
  assert.equal(refs.length, 7, 'source list is untouched');
  assert.throws(() => continuity.fitShotReferences([...required, { name: '导航员' }]), /不能丢弃/);
  assert.deepEqual(continuity.resolveDialogueSpeakers(['雷诺舰长：原话不能删除。'], ['雷诺']), ['雷诺：原话不能删除。']);
  assert.throws(() => continuity.resolveDialogueSpeakers(['未知：不要漏掉此句'], ['雷诺']), /无法匹配/);
});

// Exercise the real route with mocked chat/HTTP, without exporting test hooks from Next's route.
function loadRoute(respond) {
  const mod = { exports: {} };
  const source = fs.readFileSync(path.join(root, 'app/api/agent/plan/route.ts'), 'utf8');
  const mockRequire = (id) => {
    if (id === 'next/server') return { NextResponse: { json: (body, init) => new Response(JSON.stringify(body), init) } };
    if (id === '@/lib/agnes-chat') return { createAgnesChatCompletion: respond };
    if (id.startsWith('@/')) return require(path.join(root, id.slice(2) + '.ts'));
    return require(id);
  };
  new Function('require', 'module', 'exports', compile(source + '\nexport { buildUser, normalizeStoryboardData, validateStoryboard };'))(mockRequire, mod, mod.exports);
  return mod.exports;
}

test('later batches forward chapter, global numbering, contexts and prior shots', () => {
  const route = loadRoute(() => { throw new Error('no chat expected'); });
  const prompt = route.buildUser('storyboard', JSON.stringify({ outline: {}, assetNames: ['雷诺'], sceneNames: ['舰桥'], count: 1,
    shotOffset: 8, totalShots: 12, chapterNumber: 2, dialoguePlan: [['雷诺：保持航向']],
    dialogueContexts: [['场景=舰桥；对白前置动作=警报亮起']], previousShots: [{ index: 8, description: '雷诺关闭通讯器' }],
  }));
  for (const expected of ['当前章节:2', '第9至9镜', '全章12镜', '第9镜:雷诺：保持航向', '场景=舰桥', '警报亮起', '雷诺关闭通讯器']) {
    assert.ok(prompt.includes(expected), expected);
  }
  const normalized = route.normalizeStoryboardData({ shots: [{}] }, 1, [[]], 8);
  assert.equal(normalized.shots[0].index, 9);
  assert.equal(normalized.shots[0].shotType, 'transition');
  assert.ok(!normalized.shots[0].purpose.includes('建立地点'));
  assert.ok(!route.validateStoryboard(normalized, 1, [[]], 8).some((s) => s.includes('第1镜必须')));
});

test('route retries a wrong scene with feedback, then retains the silent cast', async () => {
  const requests = [];
  const route = loadRoute(async (request) => {
    requests.push(request);
    return JSON.stringify({ shots: [{ shotType: 'dialogue', scene: requests.length === 1 ? '木星外景' : '舰桥',
      characters: ['雷诺舰长'], description: '莉亚检查控制台，雷诺沉默地观察她的手势。', transition: 'continue' }] });
  });
  const result = await route.POST({ json: async () => ({ task: 'storyboard', input: JSON.stringify({
    count: 1, shotOffset: 8, chapterNumber: 2, totalShots: 12, assetNames: ['雷诺', '莉亚'], sceneNames: ['舰桥', '木星外景'],
    dialoguePlan: [['莉亚：保持航向']], dialogueContexts: [['场景=舰桥；精确台词=莉亚：保持航向']], previousShots: [{ scene: '木星外景' }],
  }) }) });
  assert.equal(result.status, 200);
  assert.equal(requests.length, 2);
  assert.match(requests[1].messages[1].content, /必须发生在“舰桥”/);
  const { data } = await result.json();
  assert.equal(data.shots[0].scene, '舰桥');
  assert.equal(data.shots[0].transition, 'cut');
  assert.deepEqual(data.shots[0].characters, ['雷诺', '莉亚']);
  assert.deepEqual(data.shots[0].dialogue, ['莉亚：保持航向']);
});

test('route repairs replacement characters from the locked dialogue and scene', async () => {
  let calls = 0;
  const route = loadRoute(async () => { calls++; return JSON.stringify({ shots: [{ shotType: 'dialogue', scene: '舰桥', characters: ['替身'] }] }); });
  const result = await route.POST({ json: async () => ({ task: 'storyboard', input: JSON.stringify({
    count: 1, shotOffset: 8, assetNames: ['雷诺'], sceneNames: ['舰桥'], dialoguePlan: [['雷诺：准备出发']],
  }) }) });
  assert.equal(result.status, 200);
  assert.equal(calls, 3, 'bounded model repair attempts precede deterministic source repair');
  const { data } = await result.json();
  assert.deepEqual(data.shots[0].characters, ['雷诺']);
  assert.deepEqual(data.shots[0].dialogue, ['雷诺：准备出发']);
  assert.equal(data.shots[0].scene, '舰桥');
});

test('chapter route repairs omitted speaking cast while preserving the full script', async () => {
  let calls = 0;
  const script = ['【场景：控制中心】', '官员甲：信号来源确认了？', '技术员：目标：奥尔特云边缘。', '林远：马上出发。'];
  const route = loadRoute(async () => { calls++; return JSON.stringify({ title: '深空回响', synopsis: '接收信号后出发',
    characters: [{ name: '林远', gender: '男', appearance: '舰长制服' }], scenes: [{ name: '控制中心', description: '冷光屏幕' }], script }); });
  const result = await route.POST({ json: async () => ({ task: 'chapter', input: JSON.stringify({ mode: 'original', chapter: { number: 1 } }) }) });
  assert.equal(result.status, 200);
  const { data } = await result.json();
  assert.equal(calls, 1, 'cast repair does not require rewriting the dialogue');
  assert.deepEqual(data.script, script);
  assert.deepEqual(data.characters.map(c => c.name), ['林远', '官员甲', '技术员']);
  assert.equal(data.characters[1].gender, '未知');
});
