# VTube Studio 官方 API 能力核对

> 文档状态：外部能力调查。核对来源为
> [DenchiSoft/VTubeStudio](https://github.com/DenchiSoft/VTubeStudio)，该仓库自述为
> `VTube Studio API Development Page`。本次核对基于 `master` 的提交
> `882ba5fc8bf06d7795b28bbbb965464f75403618`。

## 1. 仓库性质

该仓库是 VTube Studio Public API 的官方开发文档和协议示例，不是 VTube Studio 应用源码。
与 AG99live 数据采集直接相关的内容集中在：

- [主 API 文档](https://github.com/DenchiSoft/VTubeStudio#api-details)
- [认证](https://github.com/DenchiSoft/VTubeStudio#authentication)
- [tracking parameter](https://github.com/DenchiSoft/VTubeStudio#requesting-list-of-available-tracking-parameters)
- [Live2D parameter](https://github.com/DenchiSoft/VTubeStudio#get-the-value-for-all-live2d-parameters-in-the-current-model)
- [Event API](https://github.com/DenchiSoft/VTubeStudio/tree/master/Events)

## 2. 连接与认证事实

- Public API 使用 WebSocket，默认地址是 `ws://localhost:8001`。
- 端口允许用户在 VTube Studio 中修改，因此录制器不能写死端口。
- 用户必须在 VTube Studio 中启用 `Allow Plugin API access`。
- 所有消息使用 `apiName: VTubeStudioPublicAPI` 和当前 `apiVersion: 1.0`。
- API 允许在不升级版本的情况下增加字段，客户端反序列化必须容忍未知字段。
- 第一次连接需要发送 `AuthenticationTokenRequest` 并由用户在 VTS 中授权。
- token 可以持久保存；以后每次建立新会话时用同一个 token 发送
  `AuthenticationRequest`。
- 当前参数读取不在额外 permission 列表中，只需要完成普通插件认证。

认证 token 只属于本机连接配置，不进入动作数据库记录，更不进入训练样本。

## 3. 可读取的两层参数

### 3.1 Tracking input

`InputParameterListRequest` 返回当前所有默认和自定义 tracking parameter，例如：

```text
FaceAngleX
FacePositionX
其他 VTS 默认 tracking input
插件创建的 custom parameter
```

每个条目包含：

```text
name
addedBy
value
min
max
defaultValue
```

这一层描述 VTS 收到的跟踪输入，更接近“操作者做了什么”。它还没有完整反映模型映射、
表达式、动画、物理和最终 Live2D 参数状态。

官方明确警告：`InputParameterListRequest` 返回数据较多，不建议以 `60+ FPS` 高频发送，
否则可能在较慢电脑上产生性能问题。

`ParameterValueRequest` 可以读取一个指定的默认或自定义 input parameter，但它不是读取任意
Live2D model parameter 的过滤接口。

### 3.2 Live2D model parameter

`Live2DParameterListRequest` 返回当前加载模型的全部 Live2D 参数。每个条目包含：

```text
name
value
min
max
defaultValue
```

这一层更接近“当前模型最后呈现了什么”，但列表中可能同时包含：

- 头、身、眼、眉和嘴等主动参数。
- VTS 映射后的模型参数。
- 表达式或 motion 影响的参数。
- Physics、动画和模型自定义参数。

因此不能把返回的全部参数直接作为训练目标。录制后仍需根据当前固定模型的
`SemanticAxisProfile` 和实际参数绑定筛选目标参数。

Public API 文档没有提供“按名称批量筛选 Live2D 参数”的读取请求；要取得 Live2D 参数值，
当前公开接口返回的是完整参数列表。

### 3.3 两层数据的用途

| 数据层 | 回答的问题 | 第一轮用途 |
| --- | --- | --- |
| tracking input | 操作者和追踪器输入了什么 | 判断动作方向、幅度、跟踪丢失和输入噪声 |
| Live2D parameter | VTS 最终把当前模型驱动成什么 | 验证语义轴映射和实际可见动作 |

第一轮验证应同时采集两层数据，比较它们与 AG99live 语义轴的对应关系。验证完成后再决定
正式录制是否可以缩减字段，不能在尚未观察真实模型前只保留其中一层。

## 4. Event API 边界

与录制稳定性直接相关的事件包括：

- `ModelLoadedEvent`：模型加载或卸载。
- `TrackingStatusChangedEvent`：面部或手部 tracking 找到/丢失。
- `ModelConfigChangedEvent`：当前模型配置被用户修改。

Event API 当前没有 tracking parameter 或 Live2D parameter 的逐帧数值事件。因此：

- 事件订阅用于监测录制环境是否发生变化。
- 参数时间序列仍需要录制器主动轮询。
- 模型切换、配置变化或 tracking 丢失必须在 take 内形成明确状态，必要时中止本次录制。

不能把 `ModelMovedEvent` 当作模型参数流。该事件只报告 VTS 场景中的模型位置、尺寸和整体
旋转，不报告 Live2D rig 参数。

## 5. 第一轮轮询假设

官方文档没有承诺参数读取请求能够与 VTS 渲染帧严格同步，也没有给出
`Live2DParameterListRequest` 的保证采样率。因此第一轮只能建立待实测假设：

```text
候选采样率：20 Hz 或 30 Hz
同类请求：最多一个 in-flight request
采样时间：本地 monotonic time 为主，同时保存 VTS response timestamp
记录指标：请求 RTT、实际间隔、丢失响应、重复时间戳、CPU/GPU 影响
```

开始时不直接使用 60 Hz。只有 30 Hz 的往返延迟、抖动和 VTS 性能验证通过，并且曲线识别
确实需要更高时间分辨率时，才测试更高频率。

tracking input 与 Live2D parameter 是两个独立请求，响应时间不会天然完全对齐。录制器必须
分别记录时间，后处理按时间轴对齐，不能假定同一轮请求得到的是同一渲染帧。

## 6. 从目标反推的第一轮读取流程

```text
连接 ws://localhost:<port>
-> APIStateRequest
-> AuthenticationTokenRequest（仅首次）
-> AuthenticationRequest（每个连接会话）
-> 确认当前模型身份
-> InputParameterListRequest（发现 tracking input）
-> Live2DParameterListRequest（发现模型参数）
-> 冻结本次验证的参数清单
-> 订阅模型、配置和 tracking 状态事件
-> 开始主动轮询两层参数
-> 停止录制并写入数据库
```

模型 ID、VTS 版本、端口、请求时间和采样诊断属于数据库内部的录制会话信息。它们用于确认
数据来自同一录制环境，但导出训练样本时必须移除。

## 7. 第一轮需要证明的 API 事实

连接真实 VTube Studio 后，需要用观测而不是文档假设确认：

1. 当前固定模型的 `Live2DParameterListResponse` 实际包含哪些参数。
2. 哪些 Live2D 参数与 AG99live `primary/hint` 语义轴对应。
3. VTS mapping、smoothing、expression、motion 和 Physics 分别会怎样影响参数读数。
4. tracking input 与 Live2D parameter 之间的延迟和非线性关系。
5. 20 Hz、30 Hz 轮询的真实间隔、RTT 和性能影响。
6. API response timestamp 是否足以辅助对齐，以及本地 monotonic time 是否稳定。
7. tracking 丢失、模型切换、配置修改和 WebSocket 重连时的录制边界。

这些事实确认后，才能编写正式的 VTS 参数订阅清单和录制动作表。
