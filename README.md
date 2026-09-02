# Infinite Canvas — 无限画布 AI 视频创作平台

在无限画布上用节点组织 AI 创作流:提示词 → 生成图片/视频 → 时间线编排 → 一键导出成片。类似 [Pavo AI](https://app.pavo-ai.cn/canvas) 的本地单机版。

## 功能

- **无限画布**:React Flow 节点画布,平移/缩放/多选,图自动保存到本地 SQLite
- **AI 生成**(Agnes API):
  - 文生图 / 图生图(`agnes-image-2.1-flash`)
  - 文生视频 / 图生视频(`agnes-video-v2.0`,异步任务 + 后端轮询)
- **连线即工作流**:提示词节点 → 图片/视频节点传参数;图片 → 视频节点自动作首帧(图生视频);上传图片可作参考图
- **时间线剪辑**:把完成的视频节点加入时间线,排序、裁剪入/出点
- **成片导出**:ffmpeg 转码拼接(统一 1152×768 / 24fps / H.264+AAC),输出 MP4

## 快速开始

```bash
npm install
```

配置 `.env`(参考 `.env` 文件):

```env
AGNES_API_KEY=sk-xxx
AGNES_API_BASE_URL=https://api.agnes-ai.cn/v1
TOS_BUCKET=xxx
TOS_PUBLIC_BASE_URL=https://xxx.tos-cn-beijing.volces.com
TOS_S3_ENDPOINT=tos-cn-beijing.volces.com
TOS_ACCESS_KEY_ID=xxx
TOS_SECRET_ACCESS_KEY=xxx
```

> TOS(火山引擎对象存储)用于"上传图片"节点——Agnes 图生视频需要公网可访问的图片 URL。

```bash
npm run dev
```

打开 http://localhost:3000

## Docker 部署

```bash
docker compose up -d --build
```

- 服务端口:`3001`(宿主机)→ 3000(容器),3000 被占用时可改 `docker-compose.yml`
- 数据持久化:宿主机 `./data` 挂载到容器 `/app/data`(SQLite + 媒体 + 成片)
- 容器以 `user: 1000:1000` 运行,与宿主机目录权限对齐
- ffmpeg 二进制已内置(来自 `@ffmpeg-installer`,位于 `/app/ffmpeg-bin`),无需宿主机安装
- 配置通过 `.env` 注入(compose 自动读取)

## 使用流程

1. **+ 提示词** 添加提示词节点,写画面描述(可点"+ 画质词"追加质感词)
2. **+ 图片节点**,连上提示词节点,点"生成图片"
3. **+ 视频节点**,连上提示词(或再连图片作首帧),点"生成视频"(异步,约 1-2 分钟)
4. 完成的视频片段在底部时间线面板点 **+** 加入时间线,可排序/裁剪
5. 点 **导出成片**,完成后右下角预览并下载 MP4

## 架构

```
app/
  page.tsx                    # 画布主页面(React Flow)
  api/
    projects/                 # 项目 + 图读写
    generate/{image,video}/   # Agnes 生成
    tasks/                    # 生成任务状态(前端 2s 轮询)
    upload/                   # TOS 图片上传
    media/[id]/               # 本地媒体访问(支持 Range)
    export/                   # ffmpeg 合成导出
    exports/[name]/           # 成片下载
components/                   # 四种节点 + 时间线面板
lib/
  agnes-image.ts / agnes-video.ts  # Agnes API(复用自 Agnes-Video 项目)
  tos.ts                      # TOS 上传
  db.ts                       # SQLite(better-sqlite3, WAL)
  poll.ts                     # 后端视频任务轮询器
  store.ts                    # Zustand 画布状态 + 生成触发
types/agnes.ts                # 共享类型
data/                         # SQLite 库 + 媒体文件 + 导出成片(gitignore)
```

- 数据全部本地:`data/canvas.db` + `data/media/` + `data/exports/`
- ffmpeg 通过 `@ffmpeg-installer/ffmpeg` 提供,无需系统安装

## 技术栈

Next.js 16 (App Router) · React 19 · React Flow (@xyflow/react) · Zustand · better-sqlite3 · Tailwind CSS 4 · @volcengine/tos-sdk · ffmpeg
