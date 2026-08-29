# ListenToMe · AI 朗读/演讲教练

聆听你的朗读与演讲，指出优点与不足：录音 -> 语音转写 -> AI 多维度点评报告。

## 功能

- **🏆 趣味排行榜**：页首按账号平均分排名，最高分由自绘动画 SVG 兔子领跑、最低分乌龟垫底（头像位动画）；右侧趋势也是自绘 SVG 场景动画，**角色跟账号走**——榜首兔子开车、垫底乌龟开车、其他账号小人开车（🚗 全速上升 / 🚴 骑车上升 / 🧍 原地站立 / 🚶 倒退带速度线，快速倒退档更快；评测不足 2 次显示摇摆幼苗）
- **👤 多账号**：左侧账号列表，新建/重命名/删除账号，评测记录按账号隔离（删除账号级联删除其记录）
- **📖 朗读练习**：粘贴参考文本，逐句对照标记 ✅读对 / ❌读错 / ⚠️漏读 / ➕多读
- **🎤 演讲练习**：结构逻辑、口头禅统计、语速停顿、感染力点评
- **💬 泛用点评**：不依赖文本的综合点评
- 报告：总分、五维雷达图、优点/不足清单（带原文证据与时间点跳播）、口头禅 Top N
- 本地历史记录（每个账号最近 50 条，保存在浏览器 IndexedDB；旧数据自动迁移到「默认账号」）

## 快速开始

要求 Node.js >= 18。

1. 安装依赖：

   ```
   npm install
   ```

2. 配置 API Key：复制 `.env.example` 为 `.env`，填入两个 Key：

   - `ASR_API_KEY`：[硅基流动](https://cloud.siliconflow.cn)（注册送额度，SenseVoice 模型免费）
   - `DEEPSEEK_API_KEY`：[DeepSeek 开放平台](https://platform.deepseek.com)

3. 启动：

   ```
   npm start
   ```

4. 打开 http://localhost:3000

## 说明

- 浏览器录音需要 `localhost` 或 `https` 环境，本机访问 `localhost:3000` 即可。
- 录音直接以 16kHz WAV 上传（无需转码）；上传文件支持 mp3/wav/m4a/webm（≤25MB）。
- ASR 接口为 OpenAI 兼容格式（`/audio/transcriptions`），换 Groq / OpenAI 等只需改 `.env` 中的 `ASR_BASE_URL`、`ASR_MODEL`、`ASR_API_KEY`。
- 音频仅在分析时转发给 ASR 服务，服务器不落盘；历史记录只存在你的浏览器里。

## 目录结构

```
server.js            Express 服务：转写代理 + DeepSeek 点评 + 朗读对齐
public/index.html    页面
public/app.js        录音(AudioWorklet→16k WAV)、报告渲染、历史(IndexedDB)
public/pcm-worklet.js AudioWorklet 采集器
public/style.css     样式
docs/REQUIREMENTS.md 需求文档
```
