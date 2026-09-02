export const PLAN_SYSTEMS: Record<string, string> = {
  outline: `你是短剧编剧。根据用户给的主题创作单集短剧大纲。只输出 JSON,不要任何解释或代码块标记,格式:
{"title":"片名","genre":"类型","synopsis":"100字内剧情梗概","characters":[{"name":"角色名","appearance":"外貌/年龄/服装细节,40字内,用于生成角色立绘"}],"scenes":[{"name":"场景名","description":"场景视觉描述,30字内"}],"script":"分场剧情与对白全文,每行格式 角色名：台词,600字内"}
要求:2-3个角色,2-3个场景,剧情有起承转合,对白自然口语。`,
  assets: `你是美术指导。根据输入的剧本大纲 JSON,列出需要生成的视觉资产。只输出 JSON,格式:
{"assets":[{"kind":"character","name":"与大纲角色名一致","prompt":"白底全身立绘提示词:外貌+发型+服装+表情,60字内"},{"kind":"scene","name":"场景名","prompt":"场景概念图提示词,无人物,60字内"}]}
要求:角色 2-3 个、场景 2-3 个;道具仅在剧情必需时加(kind:"prop"),最多 2 个。`,
  storyboard: `你是短剧分镜师。根据输入的剧本大纲 JSON 与资产列表,输出分镜脚本。只输出 JSON,格式:
{"shots":[{"index":1,"description":"画面描述:出场人物(用'参考图N人物'指代,N 按 characters 数组顺序从1编号)+动作+表情+运镜(摇镜/跟拍/推近/拉远),100字内","characters":["按出场顺序的角色名"],"dialogue":["角色名：台词"]}]}
要求:分镜数严格等于用户指定的数量;首镜交代开场,末镜收束;description 中的'参考图N'编号必须与 characters 数组顺序一致;dialogue 行数不超过 characters 数,可空数组(无对白镜头);相邻镜动作衔接。`,
};

/** 从模型输出中提取第一个完整 JSON 对象(容忍 ```json 围栏与前后缀文本) */
export function extractJson(raw: string): unknown {
  const text = raw.replace(/```(?:json)?/g, "");
  const start = text.indexOf("{");
  if (start === -1) throw new Error("输出中未找到 JSON");

  // 先试整体 parse(首{ 到末 }):天然容忍字符串值内出现花括号
  const lastEnd = text.lastIndexOf("}");
  if (lastEnd > start) {
    try {
      return JSON.parse(text.slice(start, lastEnd + 1));
    } catch {
      // 尾部有杂文本或结构异常,落到逐字扫描
    }
  }

  // 逐字扫描配对,跳过字符串内的花括号(处理尾部多余文本的情况)
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return JSON.parse(text.slice(start, i + 1));
    }
  }
  throw new Error("JSON 不完整");
}
