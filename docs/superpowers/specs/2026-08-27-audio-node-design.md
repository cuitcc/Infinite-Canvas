# 音频节点与视频音频参考设计

## 目标

1. 新增 **音频节点**，基于微软 Edge 免费 TTS 将输入文本合成语音，支持 30+ 预设音色。
2. 视频节点支持把音频节点作为 **生成参考**（传入 Agnes Video 2.5 Flash 的 `audios` 字段）。
3. 时间线导出支持把音频与视频片段 **混音**。

## 范围

- 新增 `audio` 节点类型、UI、API。
- 扩展连线规则，允许 `audio` → `video`。
- 扩展视频生成链路，透传 `audios`。
- 扩展时间线数据结构和导出流程，支持片段级混音。
- 不改动图片/文本/上传节点的现有行为。

## 方案选型

使用 npm 包 `node-edge-tts`（无需 API Key）在 Node.js 中直接调用 Edge TTS。音色列表采用手写预设 + 允许自定义输入，不依赖微软的音色列表接口。

## 数据模型

### `CanvasNodeData`（`lib/store.ts`）

新增字段：

```ts
voice?: string; // 选中的 Edge voice name，如 "zh-CN-XiaoxiaoNeural"
```

音频节点使用现有字段：

- `kind: "audio"`
- `prompt: string`（要合成的文本）
- `mediaId?: string`（生成后的音频媒体 ID）
- `remoteUrl?: string`（生成后的音频 URL）
- `status/error`（生成状态）

### `NodeKind`（`lib/store.ts`）

新增 `"audio"`。

### 连线规则

- 允许 `audio` → `video`，边角色为 `"audio"`。
- 其他现有规则不变。

### `TimelineClipState`（`lib/store.ts`）

新增字段：

```ts
audioMediaId?: string; // 绑定到该视频片段的音频
audioVolume?: number;  // 可选：音频音量，默认 1
```

## API 设计

### `POST /api/generate/audio`

请求：

```json
{
  "projectId": "...",
  "nodeId": "...",
  "text": "你好世界",
  "voice": "zh-CN-XiaoxiaoNeural"
}
```

响应：

```json
{
  "ok": true,
  "mediaId": "...",
  "url": "/api/media/..."
}
```

行为：

1. 校验 `text` 非空。
2. 使用 `node-edge-tts` 合成 mp3。
3. 保存到 `data/media/`。
4. 写入 `media` 表。
5. 更新节点 `status=done`、`mediaId`、`remoteUrl`。

### 视频生成扩展

`POST /api/generate/video` 新增接收 `audioUrls?: string[]`。

`lib/agnes-video.ts` 的 `buildAgnesVideoRequest` 在 2.5-flash 分支下：

```ts
if (input.audios && input.audios.length > 0) {
  body.audios = input.audios;
}
```

`CreateVideoInput` 同步增加 `audios?: string[]`。

## 组件设计

### `components/AudioNode.tsx`（新）

- 显示节点标题“音频”。
- 多行文本输入框绑定 `data.prompt`。
- 音色下拉框：展示 30+ 预设，最后一个选项为“自定义”，选中后显示输入框。
- “生成语音”按钮，调用 `/api/generate/audio`。
- 生成完成后显示 `<audio>` 播放器和下载链接。

### `components/NodeShell.tsx`

- 给 `audio` 增加配色（例如绿色系）。
- `audio` 节点右侧有 source handle，可连线到 video。

### `app/page.tsx`

- `nodeTypes` 增加 `audio: AudioNodeView`。
- 顶部工具栏增加“+ 音频”按钮。
- `spawnNode` 处理 `audio` 默认值。

### `lib/store.ts`

- `onConnect`：允许 `src === "audio" && tgt === "video"`，边角色 `"audio"`。
- `triggerGeneration`：在遍历上游边时，额外收集 `audio` 节点的 `remoteUrl`，加入请求体的 `audioUrls`。

### `components/NodeConfigPanel.tsx`

- 视频节点的“上游参考”区单独显示音频参考项（带播放图标）。
- 音频节点配置区显示文本、音色选择、生成按钮。

### `components/TimelinePanel.tsx`

- 已完成音频节点也显示为可加入时间线的按钮。
- 每个视频片段支持绑定一个音频：显示音频选择下拉框/清除按钮。
- 保存时间线时包含 `audioMediaId`。

### `app/api/export/route.ts`

- 导出每个片段时，如果该片段有 `audioMediaId`，先用 ffmpeg 把音频和视频混音：
  - 若音频比视频长，按视频长度截断（`-shortest` 或 `-t`）。
  - 输出仍为标准 mp4（h264 + aac）。
- 然后按原流程拼接所有片段。

## 错误处理

- TTS 网络失败、超时、无效音色：返回 500 并更新节点 `status=failed`。
- 音频文件保存失败：抛出明确错误。
- 视频生成时 Agnes 拒绝音频：按现有错误映射返回。
- 导出混音失败：导出任务状态置为 `failed`。

## 测试计划

1. `npm run build` 无 TypeScript 错误。
2. 本地调用 `/api/generate/audio`，验证返回 mp3 可播放。
3. 音频节点连到视频节点，生成视频，确认请求日志包含 `audios` 字段。
4. 时间线里给视频片段绑定音频，导出成片，确认有声音。

## 部署

```bash
npm install node-edge-tts
docker compose up -d --build
```

## 预设音色列表（初版）

以中文和英文音色为主，约 30 个。完整列表在实现时写入 `lib/edge-tts-voices.ts`，并保留自定义输入框以使用其他 voice name。

中文示例：

- `zh-CN-XiaoxiaoNeural` 晓晓（女，通用）
- `zh-CN-XiaoyiNeural` 晓伊（男，通用）
- `zh-CN-YunxiNeural` 云希（男，少年）
- `zh-CN-YunjianNeural` 云健（男，新闻/纪录片）
- `zh-CN-XiaochenNeural` 晓晨（女）
- `zh-CN-XiaohanNeural` 晓涵（女）
- `zh-CN-XiaomengNeural` 晓梦（女）
- `zh-CN-XiaoruiNeural` 晓睿（女）
- `zh-CN-XiaoshuangNeural` 晓双（女，卡通）
- `zh-CN-XiaoyanNeural` 晓颜（女）
- `zh-CN-YunfengNeural` 云枫（男）
- `zh-CN-YunhaoNeural` 云浩（男）
- `zh-CN-YunyeNeural` 云野（男）
- `zh-CN-YunzeNeural` 云泽（男）
- `zh-HK-HiuMaanNeural` 晓曼（粤语，女）
- `zh-HK-WanLungNeural` 云龙（粤语，男）
- `zh-TW-HsiaoChenNeural` 晓臻（台湾腔，女）
- `zh-TW-YunJheNeural` 云哲（台湾腔，男）

英文示例：

- `en-US-AriaNeural` Aria（女，通用）
- `en-US-AnaNeural` Ana（女，儿童）
- `en-US-ChristopherNeural` Christopher（男）
- `en-US-EricNeural` Eric（男）
- `en-US-GuyNeural` Guy（男，新闻）
- `en-US-JennyNeural` Jenny（女）
- `en-US-MichelleNeural` Michelle（女）
- `en-US-RogerNeural` Roger（男）
- `en-US-SteffanNeural` Steffan（男）
- `en-GB-LibbyNeural` Libby（英式，女）
- `en-GB-RyanNeural` Ryan（英式，男）
- `en-AU-NatashaNeural` Natasha（澳式，女）
- `en-AU-WilliamNeural` William（澳式，男）
- `en-CA-ClaraNeural` Clara（加式，女）
- `en-IN-NeerjaNeural` Neerja（印度式，女）
- ...（其余按需补充）
