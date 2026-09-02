export interface StyleEntry {
  id: string;
  name: string;
  category: "2d" | "3d" | "real";
  prompt: string;
  thumb: string;
}

export const STYLE_CATEGORIES = [
  { key: "all", label: "全部" },
  { key: "2d", label: "2D" },
  { key: "3d", label: "3D" },
  { key: "real", label: "真人" },
] as const;

export const STYLE_LIBRARY: StyleEntry[] = [
  { id: "crayon-kids", name: "儿童蜡笔手绘", category: "2d", prompt: "儿童蜡笔手绘画风,粗线条涂鸦质感,色彩鲜艳明快,童趣盎然", thumb: "/styles/crayon-kids.png" },
  { id: "shadow-puppet", name: "皮影戏", category: "2d", prompt: "中国传统皮影戏风格,平面剪影效果,质朴厚重的民间艺术质感", thumb: "/styles/shadow-puppet.png" },
  { id: "showa-anime", name: "90年代日式动画", category: "2d", prompt: "90年代日式动画风格,柔和色彩,细腻线条,复古治愈画风", thumb: "/styles/showa-anime.png" },
  { id: "mono-manga", name: "黑白二维漫画", category: "2d", prompt: "黑白日式漫画风格,清晰线条,网点阴影,经典少年漫质感", thumb: "/styles/mono-manga.png" },
  { id: "ink-wash", name: "中国水墨动画", category: "2d", prompt: "中国水墨动画风格,晕染质感,写意山水,东方古典意境", thumb: "/styles/ink-wash.png" },
  { id: "ghibli-pastoral", name: "吉卜力田园水彩", category: "2d", prompt: "吉卜力工作室风格,清新水彩质感,治愈田园场景", thumb: "/styles/ghibli-pastoral.png" },
  { id: "american-comic", name: "美式漫画", category: "2d", prompt: "美式超级英雄漫画风格,粗线条,高对比度,鲜艳色块", thumb: "/styles/american-comic.png" },
  { id: "pixar-family", name: "3D合家欢动画", category: "3d", prompt: "皮克斯3D动画风格,温暖柔和,圆润造型,合家欢画风", thumb: "/styles/pixar-family.png" },
  { id: "cinematic-cg", name: "3D写实电影CG", category: "3d", prompt: "写实3D电影CG风格,高清质感,光影细腻,真实场景还原", thumb: "/styles/cinematic-cg.png" },
  { id: "claymation", name: "黏土定格动画", category: "3d", prompt: "黏土定格动画风格,手工质感,质朴纹理,复古木偶剧效果", thumb: "/styles/claymation.png" },
  { id: "xianxia-cg", name: "国风仙侠CG", category: "3d", prompt: "国风仙侠CG风格,仙气缭绕,东方仙侠意境,细腻国风美术", thumb: "/styles/xianxia-cg.png" },
  { id: "urban-idol", name: "都市偶像真人剧", category: "real", prompt: "都市偶像剧风格,清新明亮,现代都市场景,自然日常画风", thumb: "/styles/urban-idol.png" },
  { id: "wuxia-film", name: "古装武侠真人电影", category: "real", prompt: "古装武侠电影风格,东方古典场景,写意江湖意境,电影质感", thumb: "/styles/wuxia-film.png" },
  { id: "noir-drama", name: "悬疑暗调真人剧", category: "real", prompt: "悬疑剧暗调风格,低对比度光影,冷峻色调,紧张氛围", thumb: "/styles/noir-drama.png" },
  { id: "hk-retro", name: "90年代港片", category: "real", prompt: "90年代香港电影风格,暖色调滤镜,复古胶片质感,市井气息", thumb: "/styles/hk-retro.png" },
];

export function styleThumbSrc(style: StyleEntry): string {
  return style.thumb;
}
