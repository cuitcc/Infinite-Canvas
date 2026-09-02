import { NextRequest, NextResponse } from "next/server";
import { createAgnesChatCompletion } from "@/lib/agnes-chat";
import { genericTextGenerate } from "@/lib/generic-provider";
import { resolveModel } from "@/lib/model-registry";

const FORMAT_ACTIONS: Record<string, { label: string; system: string }> = {
  "expand": {
    label: "扩写为画面提示词",
    system: "你是 AI 绘画/视频提示词专家。把用户的简短想法扩写成一段具体、可视化的画面提示词,包含主体、动作、环境、光线、色调、镜头语言。直接输出提示词本身,不要任何解释或前后缀,中文,控制在 120 字内。",
  },
  "polish": {
    label: "润色",
    system: "你是文本润色助手。优化用户的文字表达,使其更流畅精准,保持原意和原有语言。直接输出润色后的文本,不要解释。",
  },
  "translate-en": {
    label: "译为英文提示词",
    system: "你是翻译专家。把用户的中文内容翻译成高质量英文画面提示词(AI 生成用途),保留关键视觉元素,可补充常用画质词。直接输出译文,不要解释。",
  },
  "storyboard": {
    label: "拆成分镜脚本",
    system: "你是分镜师。把用户的想法拆成 3-6 个连续分镜,每个分镜一行,格式:镜号|画面描述(主体+动作+景别)|时长建议。直接输出列表,不要额外解释。",
  },
  "optimize-image": {
    label: "优化图片提示词",
    system: "你是顶级 AI 绘画提示词专家。把用户的提示词改写为高质量中文绘画提示词,按以下结构组织:主体(具体细节,重要内容前置)→环境场景→构图与镜头(景别、角度、焦段)→光线→色调氛围→风格/媒介→画质词(masterpiece, best quality, ultra-detailed, 8k uhd)。要求:全部用正面描述,表达空场景用\"空无一人\",禁止出现\"没有/无人/不要\"等否定词,排除项不写入正面提示词;保留用户原意;直接输出提示词本身,不要任何解释或前后缀;中文,120 字以内。",
  },
  "optimize-video": {
    label: "优化视频提示词",
    system: "你是顶级 AI 视频提示词专家。把用户的提示词改写为高质量中文视频生成提示词,严格按时间顺序组织,且每个阶段都必须写出对应的镜头运动:开场(镜头对准谁,景别+机位+人物在画面何处、做什么)→人物出场(何时、从哪个方向入画;新人物入画时镜头必须同步运动——摇镜转向/跟拍/推近或焦点转移,让镜头引导视线转向新人物,禁止固定机位干等人物走进画面)→动作与对白(谁先开口谁后回应,说话人切换时镜头随之缓慢转移,如摇镜或焦点在两人间切换)→场景环境→光线→风格→节奏。要求:单镜头单场景,不写剪辑切换,但运镜必须连贯流畅(摇移、跟拍、推拉、升降、焦点转移等);用\"开场\"\"随后\"\"接着\"等时间词标明先后;出场顺序不得打乱、不得省略、不得合并,尚未出场的参考图人物不得提前出现在画面中;细节宁多勿少,把镜头运动、人物位置、动作、表情展开写清楚,长度按细节需要放开,不要为压字数删减时序和运镜信息;原文中的\"镜头固定\"\"固定机位\"等静止描述若与人物入画、说话人切换并存,一律改写为相应运镜(开场可短暂固定,人物入画和对话阶段镜头必须运动);用户提示词中\"第N张参考图\"\"参考图N\"等图片引用表述必须原样保留,不得改写、删除或合并;保留用户原意;直接输出提示词本身,不要任何解释或前后缀;中文,400 字以内。",
  },
  "extract-dialogue": {
    label: "提取台词",
    system: "你是影视台词提取专家。从用户的视频提示词或故事文本中提取人物说的话,整理成可直接口播的中文对白。要求:只保留人物说出的内容,去掉叙述、动作、场景描写;格式为\"角色:台词内容\",多个角色分行;台词自然口语化,可直接朗读;直接输出台词本身,不要任何解释、引号或前后缀;中文,80 字以内。",
  },
};

interface FormatContext {
  ratio?: string;
  tier?: string;
  seconds?: string;
  referenceCount?: number;
}

/** 把节点上下文拼成追加给模型的提示后缀;空 context 返回空串 */
function formatContextSuffix(context?: FormatContext): string {
  if (!context) return "";
  const parts: string[] = [];
  if (context.ratio) parts.push(`比例 ${context.ratio}`);
  if (context.tier) parts.push(`档位 ${context.tier}`);
  if (context.seconds) parts.push(`时长 ${context.seconds} 秒`);
  if (typeof context.referenceCount === "number" && context.referenceCount > 0) parts.push(`参考图 ${context.referenceCount} 张`);
  return parts.length > 0 ? `\n\n（生成要求：${parts.join("，")}）` : "";
}

export async function POST(req: NextRequest) {
  try {
    const { text, action, model, context } = await req.json() as { text?: string; action?: string; model?: string; context?: FormatContext };
    if (!text || !text.trim()) {
      return NextResponse.json({ error: "文本不能为空" }, { status: 400 });
    }
    const preset = FORMAT_ACTIONS[action ?? "expand"];
    if (!preset) {
      return NextResponse.json({ error: "未知的格式化动作" }, { status: 400 });
    }
    const userMessage = `${text.trim()}${formatContextSuffix(context)}`;

    // 按模型路由:Agnes 专用 / 其他厂商通用 OpenAI 兼容
    const resolved = model ? resolveModel(model) : undefined;
    const result = resolved && resolved.provider.name !== "Agnes"
      ? await genericTextGenerate({ modelName: model!, system: preset.system, user: userMessage })
      : await createAgnesChatCompletion({
          messages: [
            { role: "system", content: preset.system },
            { role: "user", content: userMessage },
          ],
          model: resolved?.model.modelId,
        });

    return NextResponse.json({ ok: true, result, action: preset.label });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({
    actions: Object.entries(FORMAT_ACTIONS).map(([key, v]) => ({ key, label: v.label })),
  });
}
