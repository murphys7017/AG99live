# OBS Web 字幕

保留原有桌面字幕窗口；新增独立、透明背景的浏览器字幕页。字幕页由 AstrBot 中的 AG99live Adapter 托管，实际文字和播放状态由当前连接的 TypeScript 或 Native 桌面端上报。字幕订阅采用单向 SSE，与桌面 WebSocket 连接和播放回执完全独立。

## 使用

1. 更新 Adapter，并运行更新后的 TypeScript 桌面端或 Native 桌面端。
2. 重启或重新加载 Adapter。默认字幕地址为 `http://127.0.0.1:18765/subtitle/`。
3. OBS 新建浏览器源，填写字幕地址。建议尺寸 **1200 × 260**，字幕源在画面里约占八成宽。把来源的下边缘对准希望的字幕位置，字幕换行时向上扩展。字幕较长时可增加来源高度，再把下边缘对回所需位置。
4. 打开 `http://127.0.0.1:18765/subtitle/editor` 修改 CSS，输入即时预览，点击“保存并应用”同步到 OBS。无需重新加载 OBS。

`?preview=1` 始终显示设计示例，方便调样式；**OBS 请使用不含此参数的直播地址**。直播页无字幕时完全隐藏，背景透明，不显示预览示例或编辑控件。

默认字幕条只显示正文，宽度随文字伸缩。在 1200 px 宽的浏览器源中，默认正文是 60 px。OBS 浏览器源的自定义 CSS 如果设过 `--subtitle-font-size`，可删去该声明以使用新的默认字号。

平台适配器配置新增 `subtitle_port`，默认 `18765`，监听 `127.0.0.1`。存在多个 Adapter 实例时分别配置端口。角色名沿用平台的 `speaker_name`。

## CSS

CSS 保存于 AstrBot 插件数据目录 `astrbot_plugin_ag99live_adapter/subtitles/<桌面 WebSocket 端口>/custom.css`，编辑页会显示实际绝对路径。重新部署插件不会覆盖它。直接修改文件也会在约 0.5 秒内自动应用；CSS 上限 64 KiB。OBS 自带的自定义 CSS 也可以覆盖样式。

```css
:root {
  --subtitle-font-size: clamp(26px, 5.3vw, 64px);
  --subtitle-card-background: #2c2345;
  --subtitle-border: #8870bb;
  --subtitle-color: #faf8ff;
  --subtitle-muted: #b6acd2;
  --subtitle-accent: #704fa0;
  --subtitle-radius: 16px;
  --subtitle-max-width: 1100px;
}

/* 需要显示角色和播放状态时启用 */
/* .subtitle-speaker-row { display: flex; } */
```

稳定类名包括 `.subtitle-shell`、`.subtitle-header`、`.subtitle-brand`、`.subtitle-wave`、`.subtitle-card`、`.subtitle-speaker-row`、`.subtitle-avatar`、`.subtitle-speaker`、`.subtitle-status`、`.subtitle-text`、`.subtitle-footer`。

## 播放同步

- `system.subtitle_state` / `ag99.subtitle.v1` 是新增的桌面状态上报，不替换原有输出协议，也不承担播放回执。
- 仅在实际音频开始后显示对应片段；支持传统分段和增量 PCM，后续文字更新沿用该片段身份。
- 片段播放完成后保留最后一句，下一片段开始时替换；被打断、失败或桌面断线时清除。
- 纯文字回复同样保留，不自动隐藏。轮次正式结束只更新状态，不清除字幕。
- 通过轮次、片段和递增序号拒绝旧状态覆盖。浏览器刷新或重连恢复当前保留的字幕，不回放历史；桌面断线清除的内容不再恢复。
- OBS 关闭、刷新或慢速读取不会阻塞语音播放。订阅只保留最新快照。

默认样式参考用户提供的紫色字幕卡片。标准图标来自 Tabler Icons，见字幕资源目录中的 MIT 许可证。
