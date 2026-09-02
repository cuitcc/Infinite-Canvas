# Task 2 实现报告 — `/api/agent/plan` 规划路由

## 实现要点

### 新建文件
- `lib/agent-prompts.ts` — 三个 system 提示词（outline / assets / storyboard）+ `extractJson` 工具函数
- `app/api/agent/plan/route.ts` — POST 路由，按 task 字段分发到对应 prompt，失败时重试一次

### 设计说明
- 三个 system 提示词按简报原文逐字实现，未做改动。
- `extractJson` 按简报原文实现：先剥离 `` ```json `` / `` ``` `` 围栏，再用大括号深度计数找第一个完整 JSON 对象，找不到 / 不完整时分别抛出两种错误信息。
- 路由签名：`POST /api/agent/plan` 接收 `{task, input, shotCount?}`，成功返回 `{ok:true, data:<object>}`，失败返回 `{error:<msg>}` + 对应 HTTP 状态码（400 参数错 / 502 规划失败 / 500 未知错误）。
- 错误处理风格与 `app/api/text/format/route.ts` 保持一致：`try/catch` 包裹整体，用 `NextResponse.json` 返回带 `error` 字段的对象。
- `buildUser` 按简报实现：storyboard 任务从 input JSON 中解构 `outline` / `assetNames` / `count`，拼接成多行用户提示；其他任务直接用 input，附带 `shotCount`（如有）。
- 重试策略：对 `createAgnesChatCompletion` + `extractJson` 的完整调用做 2 次尝试（一次重试），因为 Agnes 底层自身已经有 3 次重试，外层重试主要应对 JSON 解析失败的情况（模型偶尔输出格式异常）。

### 与 `createAgnesChatCompletion` 签名对照
调用时只传了 `messages` 字段（system + user），`model` / `temperature` / `maxTokens` 走默认值（`agnes-2.5-flash` / 0.4 / 4096），与 `app/api/text/format/route.ts` 中的调用方式一致。

## 验证

### 1. TypeScript 类型检查
```bash
npx tsc --noEmit
```
输出：无错误（零输出）。

### 2. 生产构建
```bash
npm run build
```
结果：构建成功。路由清单中出现 `ƒ /api/agent/plan`（动态服务端渲染）。构建过程中的 `turbopack` 关于 `fs.existsSync` 的警告来自既有代码（`lib/image-utils.ts`），与本任务无关。

### 3. extractJson 冒烟测试
```bash
node --experimental-strip-types /tmp/test-extract-json.ts
```
5 个用例全部通过：
- case 1 纯 JSON → 正确解析
- case 2 ```json 围栏包裹 → 正确解析
- case 3 JSON 前后有废话文本 → 正确解析
- case 4 无 JSON → 抛 "输出中未找到 JSON"
- case 5 JSON 不完整 → 抛 "JSON 不完整"

## 遇到的问题
无。按简报直接实现，`createAgnesChatCompletion` 签名与骨架代码兼容（骨架只用到 `messages`，其余参数走默认值），TypeScript 零错误，构建一次通过。
