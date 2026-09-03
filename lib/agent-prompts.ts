import { jsonrepair } from "jsonrepair";

export const PLAN_SYSTEMS: Record<string, string> = {
  outline: `你是短剧编剧。根据用户给的主题创作单集短剧大纲。只输出 JSON,不要任何解释或代码块标记,格式:
{"title":"片名","genre":"类型","synopsis":"100字内剧情梗概","characters":[{"name":"角色名","appearance":"外貌/年龄/服装细节,40字内,用于生成角色立绘"}],"scenes":[{"name":"场景名","description":"场景视觉描述,30字内"}],"script":"分场剧情与对白全文,每行格式 角色名：台词,600字内"}
要求:2-3个角色,其中必须有对立面(反派/竞争者/制造冲突的角色),2-3个场景;剧情必须有明确的矛盾冲突和转折,开头即抛出悬念钩子,结尾留钩子;对白短促、有攻防和潜台词,一方施压一方应对,禁止长篇独白、禁止旁白解说;每个有名字的角色至少2句台词。`,
  assets: `你是美术指导。根据输入的剧本大纲 JSON,列出需要生成的视觉资产。只输出 JSON,格式:
{"assets":[{"kind":"character","name":"与大纲角色名一致","prompt":"白底全身立绘提示词:外貌+发型+服装+表情,60字内"},{"kind":"scene","name":"场景名","prompt":"场景概念图提示词,无人物,60字内"}]}
要求:角色 2-3 个、场景 2-3 个;道具仅在剧情必需时加(kind:"prop"),最多 2 个。`,
  storyboard: `你是短剧分镜师。根据输入的剧本大纲 JSON 与资产列表,输出分镜脚本。只输出 JSON,格式:
{"shots":[{"index":1,"scene":"本镜发生的场景名,必须是可用场景之一","description":"画面描述:运镜+出场人物(用'参考图N人物'指代,N 按 characters 数组顺序从1编号)+动作+表情+人物朝向,150字内","characters":["按出场顺序的角色名"],"dialogue":["角色名：台词"]}]}
要求:
1.分镜数严格等于用户指定的数量;首镜交代开场,末镜收束;
2.运镜为硬性要求:每镜 description 必须写明运镜三段式"起幅→运动方式→落幅"(例:中景起幅,镜头侧面跟拍人物穿过人群,落幅缓推至半身),相邻分镜运镜不得重复,全片至少用到推、拉、摇、移、跟中的三种;禁止全片固定机位;
3.空间调度:禁止所有人物正面朝向镜头;每镜必须写明人物朝向与视线方向,至少安排侧面、四分之三侧、过肩或前后景层次之一;两人对话镜头用正反打或过肩机位;
4.description 中的'参考图N'编号必须与 characters 数组顺序一致;dialogue 每行说话人必须是 characters 数组中的人物,每镜 dialogue 最多2句且说话人不同,可空数组;道具出镜时 description 必须写出道具名称(与可用道具资产名一致);
5.scene 必须与剧情地点一致,场景切换要有剧情动机,不要全程只用一个场景;
6.转场衔接:第2镜起每镜 description 必须以一句"承接上镜"开头,说明从上一镜末画面如何过渡(动作自然延续/镜头摇向/视线转移/同场景走位衔接等),确保相邻两镜画面不跳变;全片人物服装发型、场景光线保持连续统一。`,
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
      if (depth === 0) {
        // 配对成功但内容仍可能非法(如闭合符错序):抛错则落到下方 jsonrepair 兜底
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          break;
        }
      }
    }
  }

  // 兜底:模型会漏写末尾闭合符或闭合符错序(实测 agnes-2.5-flash 分镜输出丢失末镜对象的 },
  // 尾部变成 "]]}} ),jsonrepair 修复后再 parse
  try {
    return JSON.parse(jsonrepair(text.slice(start)));
  } catch {
    throw new Error("JSON 不完整");
  }
}
