# AG99live

你的桌面 AI 宠物——一个会听、会说、会动的 Live2D 虚拟形象。

输入文字，它会开口说话、做出动作、表达情绪，一切同步进行，就像一个真实的小助手在陪伴你。

![AG99live 预览](./docs/images/image.png)

## 能做什么

**对话交互**
输入文字，桌宠会用语音回应，同时配合对应的表情和动作（点头、摇头、挥手、歪头等）。支持文本和语音两种输入方式。

**动作实验室**
在动作实验室里预览 AI 生成的动作效果，你可以手动调整动作参数（开心程度、头部倾斜角度等），保存你喜欢的调参样本，让 AI 后续生成更符合你偏好的动作。

**主轴配置**
配置桌宠的"情绪主轴"——定义哪些维度影响动作表现。绑定语义参数到 Live2D 模型的实际参数，塑造独特的桌宠性格。

**设置与历史**
配置后端连接、调节动作强度、开关待机自动动作、查看对话历史。

## 技术特点

| 特点 | 说明 |
|------|------|
| 语义驱动的动作合成 | AI 理解"开心/惊讶/难过"等情绪，实时转换为具体的动作参数 |
| 多模态同步 | 语音、文本、动作在同一时刻一起发生 |
| Live2D 动作库 | 自动扫描模型动作库，沉淀可复用的动作知识 |
| 个性化调参 | 手动调整动作风格，样本可同步给 AI 学习 |

## 快速开始

详细开发文档见 [docs/README](./docs/README.md)

```powershell
# 前端开发
cd frontend && npm install && npm run dev

# 后端测试
python -m pytest astrbot_plugin_ag99live_adapter/tests -q

# 部署到 AstrBot
.\deploy_adapter.ps1
```

## 项目结构

```
AG99live/
├─ frontend/                          # Electron + Vue 客户端（桌宠窗口、设置、历史、动作实验室）
├─ astrbot_plugin_ag99live_adapter/   # AstrBot 插件后端
├─ docs/                              # 开发文档
└─ deploy_adapter.ps1
```

