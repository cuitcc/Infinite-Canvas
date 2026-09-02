export type VideoStatus = "queued" | "in_progress" | "completed" | "failed";
export type GenerationMode = "text" | "image" | "keyframes";
export type AgnesVideoMode = "text" | "keyframe" | "reference";

export interface CreateVideoInput {
  mode: GenerationMode;
  prompt: string;
  image?: string;
  images?: string[];
  audios?: string[];
  /** 新模型使用 seconds + aspect_ratio 替代 height/width/num_frames/frame_rate */
  seconds?: string;
  aspect_ratio?: string;
  /** 旧版 agnes-video-v2.0 字段，保留兼容 */
  height?: number;
  width?: number;
  num_frames?: number;
  frame_rate?: number;
  negative_prompt?: string;
  seed?: number;
}

export interface AgnesCreateVideoBody {
  model: "agnes-video-2.5-flash" | "agnes-video-v2.0";
  prompt: string;
  /** 2.5-flash 必填；2.0 不使用该字段 */
  mode?: AgnesVideoMode;
  image?: string;
  /** 2.5-flash reference 模式最多 5 张 */
  images?: string[];
  audios?: string[];
  /** 2.5-flash 固定 720P，由 aspect_ratio 控制分辨率 */
  size?: "720P";
  seconds?: string;
  aspect_ratio?: string;
  first_frame?: string;
  last_frame?: string;
  height?: number;
  width?: number;
  num_frames?: number;
  frame_rate?: number;
  negative_prompt?: string;
  seed?: number;
  extra_body?: {
    response_format?: "url";
    image?: string[];
    mode?: "keyframes";
  };
}

export interface AgnesVideoTask {
  id: string;
  object: string;
  model: string;
  status: VideoStatus;
  progress: number;
  created_at: number;
  completed_at?: number | null;
  expires_at?: number | null;
  url?: string;
  video_url?: string;
  video_id?: string;
  metadata?: {
    url?: string;
    [key: string]: unknown;
  };
  error?: unknown;
}

export type ImageGenerationMode = "text" | "image";

export interface CreateImageInput {
  mode: ImageGenerationMode;
  prompt: string;
  size?: string;
  ratio?: string;
  negative_prompt?: string;
  imageUrl?: string;
  imageUrls?: string[];
}

export interface AgnesCreateImageBody {
  model: "agnes-image-2.1-flash";
  prompt: string;
  size?: string;
  ratio?: string;
  negative_prompt?: string;
  extra_body?: {
    image?: string[];
    response_format?: "url";
  };
}

export interface AgnesImageResponse {
  data?: Array<{ url?: string; b64_json?: string }>;
  url?: string;
  image_url?: string;
  created?: number;
  model?: string;
  object?: string;
  error?: unknown;
}

export type NodeType = "prompt" | "image" | "video" | "upload" | "audio";

export interface CanvasNodeData {
  kind: NodeType;
  label?: string;
  prompt?: string;
  negativePrompt?: string;
  model?: string;
  quality?: string;
  textModel?: string;
  textBusy?: boolean;
  textError?: string;
  formatAction?: string;
  lockIdentity?: boolean;
  seed?: number;
  imageTier?: string;
  imageRatio?: string;
  voice?: string;
  /** 视频节点：新模型使用 seconds + aspectRatio */
  seconds?: string;
  aspectRatio?: string;
  /** 视频节点：人物台词，生成时注入提示词由模型直生语音并与口型同步 */
  dialogue?: string;
  /** 视频节点：上游参考图 source node id 顺序 */
  referenceOrder?: string[];
  /** 视频节点：参考图节点 id → 角色名映射（短剧 Agent 设置），台词按名字精确绑定参考图 */
  refNames?: Record<string, string>;
  /** 旧字段保留兼容 */
  size?: string;
  width?: number;
  height?: number;
  numFrames?: number;
  frameRate?: number;
  status?: "idle" | "queued" | "generating" | "done" | "failed";
  error?: string;
  mediaId?: string;
  remoteUrl?: string;
  sourceNodeIds?: string[];
  createdAt?: number;
  updatedAt?: number;
}

export interface CanvasEdgeData {
  role?: "first-frame" | "reference" | "audio";
}

export interface TimelineClip {
  id: string;
  nodeId: string;
  mediaId: string;
  order: number;
  trimIn: number;
  trimOut: number | null;
  audioMediaId?: string;
}

export interface MediaRecord {
  id: string;
  type: "image" | "video" | "audio";
  remoteUrl?: string;
  localPath?: string;
  mimeType?: string;
  bytes?: number;
  createdAt: number;
}
