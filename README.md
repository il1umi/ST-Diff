# ST-Diff

一个为 SillyTavern 设计的差异对比扩展，提供世界书条目的可视化对比、条目内容迁移功能。未来会加入预设功能。

![版本](https://img.shields.io/badge/版本-1.3.5-blue.svg)
![许可证](https://img.shields.io/badge/许可证-AGPL--3.0-blue.svg)

## 致谢
感谢类脑discord社区tera佬及折戟沉沙佬的clewd正则、jsrunner代码及思路启发对本扩展的noass功能的不可磨灭的贡献
## 功能概览

ST-Diff 是一个专为 SillyTavern 世界书管理设计的扩展，能够：

- **可视化差异对比** - 提供并列和内联两种对比模式，清晰展示世界书条目间的差异
- **条目详情参数对比** - 支持世界书条目的所有参数（关键字、逻辑、位置、概率等）的并排对比与编辑
- **智能内容迁移** - 支持单向应用和撤销操作，可选择性应用差异块
- **实时编辑预览** - 在对比界面中直接编辑内容，实时查看修改效果
- **暂存模式** - 支持手动保存模式，批量提交修改，避免频繁写盘
- **版本管理** - 支持世界书条目的版本对比和历史追踪
- **世界书提取并传递管线** - 根据世界书深度与顺序自动包裹启用条目，将其迁移到配置目标段落并清理目标标记
- **多组策略** - 通过可分页的策略组配置，实现不同深度集合、白名单与目标位置的并行生效
- **高度可定制** - 支持自定义颜色主题、上下文行数、词级高亮等个性化设置

## 项目结构

```
ST-Diff/
├── index.js                          # 扩展主入口，负责模块化装载
├── manifest.json                     # SillyTavern 扩展清单
├── modules/                          # 核心功能模块
│   ├── noass/                        # 对话压缩、clewd正则、世界书提取与传递
│   │   ├── index.js                  # noass 入口协调器
│   │   ├── runtime/                  # 运行时代码域
│   │   │   ├── completion.js         # 与 SillyTavern completion 流程对接
│   │   │   ├── mergeBlock.js         # 压缩消息与角色映射
│   │   │   ├── capture/              # Dry-Run 捕获与日志
│   │   │   │   └── capture.js
│   │   │   ├── clewd/                # clewd 正则处理
│   │   │   │   ├── constants.js
│   │   │   │   └── processor.js
│   │   │   └── wibridge/             # 世界书桥接处理
│   │   │       ├── cache.js
│   │   │       ├── dispatch.js
│   │   │       ├── index.js
│   │   │       ├── normalize.js
│   │   │       ├── sentinel.js
│   │   │       └── state.js
│   │   ├── state/                    # 设置与运行时状态
│   │   │   ├── defaults.js
│   │   │   └── state.js
│   │   └── ui/                       # 界面交互绑定
│   │       ├── binder.js
│   │       └── wibridgeControls.js
│   ├── worldbook/                    # 世界书对比模块
│   │   ├── actions/
│   │   │   ├── hunks.js
│   │   │   └── sessionPatch.js
│   │   ├── templates/
│   │   │   ├── code_diff.html
│   │   │   └── entry_diff.html
│   │   ├── codeDiff.js
│   │   ├── diff.js
│   │   ├── entryDiff.js
│   │   ├── paramsDiff.js
│   │   ├── repo.js
│   │   ├── worldbook.module.js
│   │   └── panel.html
│   └── presets/                      # 预设对比模块（占位）
├── presentation/                     # UI 表现层
│   ├── styles/
│   │   └── main.css
│   └── templates/
│       └── main.html
└── README.md                         # 项目文档
```

## noass 模块快速总览

新的 noass 架构将复杂的对话压缩与世界书处理拆分为多个协作模块：

- **入口协调器**：[`modules/noass/index.js`](ST-Diff/modules/noass/index.js) 负责注入上下文、注册运行时钩子，并与 SillyTavern 的 `getContext()` 保持低耦合。
- **运行时域**：
  - [`runtime/mergeBlock.js`](ST-Diff/modules/noass/runtime/mergeBlock.js) 负责按照自定义角色前缀压缩消息并输出单条对话。
  - [`runtime/completion.js`](ST-Diff/modules/noass/runtime/completion.js) 与 SillyTavern 的 OpenAI 流程对接，确保压缩后消息按 API 期望格式提交。
  - [`runtime/capture/capture.js`](ST-Diff/modules/noass/runtime/capture/capture.js) 实现 Dry-Run 捕获、日志记录与策略结果预览。
  - [`runtime/clewd/processor.js`](ST-Diff/modules/noass/runtime/clewd/processor.js) 延续 clewd 正则阶段，复用 order-1/2/3 的替换逻辑。
  - [`runtime/wibridge`](ST-Diff/modules/noass/runtime/wibridge/index.js) 子域处理世界书深度分段、哨兵标记与目标插入。
- **状态与设置**：[`state/state.js`](ST-Diff/modules/noass/state/state.js) 与 [`state/defaults.js`](ST-Diff/modules/noass/state/defaults.js) 统一管理策略组、白名单及 UI 同步。
- **UI 绑定**：[`ui/binder.js`](ST-Diff/modules/noass/ui/binder.js) 通过依赖注入方式组装界面事件，支持扩展组分页、白名单编辑器与 Dry-Run 触发。

保留的 [`noass.module.js`](ST-Diff/modules/noass/noass.module.js) 仅负责与旧版入口兼容及托管生命周期，所有实际逻辑均迁移至上述模块。

## 世界书提取与传递配置指南

新版本的世界书管线在保持 clewd 正则处理顺序的前提下，实现以下能力：

1. **深度选择模式**
   - ≥ 模式：选择一个最小深度 `N`，提取所有深度不小于 `N` 的启用条目。
   - 范围模式：指定 `[min..max]`，仅提取区间内的启用条目。
   - 两种模式可在策略组间独立配置，互不干扰。

2. **顺序稳定性与哨兵标记**
   - 针对同一深度，模块会定位启用条目的最小/最大顺序，在两端插入唯一哨兵标记。
   - 被包裹的段落整体移动至目标位置后，会移除哨兵与辅助文本，确保不污染消息上下文。

3. **白名单优先级**
   - 可对整深度或某个标题（comment）进行排除。
   - 白名单判定优先于提取逻辑，满足“只移除未排除的启用条目”的要求。

4. **多组策略并行**
   - 每组策略包含：启用开关、深度模式、目标锚点、白名单集合、Dry-Run 输出。
   - UI 通过分页按钮切换不同组，便于维护大规模策略集合。
   - 策略组顺序即执行顺序，可通过拖动重排（开发中）或配置文件调整索引。

5. **目标锚点**
   - 预置锚点：压缩消息头部、系统提示区、自定义标签等。
   - 支持自由输入锚点名称，通过 noass 内部映射定位插入点。
   - 若锚点未命中，会自动跳过并记录在 Dry-Run 日志中，避免破坏消息链。

6. **Dry-Run 与日志**
   - 在策略保存前可通过 Dry-Run 查看世界书段落的实际包裹、移动与清理过程。
   - 日志同时输出 clewd order 级别的正则命中情况，便于定位冲突。

## 使用方法

### 安装

#### 方法一：通过 Git 克隆安装

1. **进入扩展目录**
   ```bash
   cd SillyTavern/public/scripts/extensions/third-party/
   ```

2. **克隆仓库**
   ```bash
   git clone https://github.com/il1umi/ST-Diff.git
   ```

3. **重启并启用**
   - 重启您的 SillyTavern 实例
   - 打开"扩展"面板，找到"酒馆构筑对比工具"并启用

#### 方法二：通过 URL 在线安装

在 SillyTavern 的扩展管理界面中，使用以下 URL 进行在线安装：
```
https://github.com/il1umi/ST-Diff.git
```

### 基础使用

1. **启用扩展**
   - 在扩展面板中启用"酒馆构筑对比工具"

2. **选择对比目标**
   - 在世界书编辑界面，选择要对比的两个世界书（世界书A和世界书B）
   - 可选择"只读模式"防止误修改世界书B
   - 默认勾选手动模式防止参数页误操作

3. **查看差异**
   - **内容对比**：点击"展开对比"查看条目内容的文本差异，支持并列和内联两种模式
   - **参数对比**：展开任意条目详情，查看世界书B的对应参数（关键字、逻辑、位置、概率等）

4. **编辑与保存**
   - **即时保存**：关闭"暂存模式"，修改世界书B的参数后立即保存
   - **暂存模式**：开启后，修改会暂存在内存中，点击"保存暂存"统一写入磁盘
   - **内容迁移**：在内容对比界面点击"应用"按钮将差异块应用到目标世界书

## 核心功能详解

### 差异对比引擎

#### 多层次对比
- **条目级对比**：识别新增、删除、修改的世界书条目
- **内容级对比**：深入到条目内容的行级和词级差异
- **参数级对比**：支持条目详情中所有参数的并排对比与实时编辑
- **结构化对比**：支持 JSON 格式的规范化对比

#### 可视化展示
- **并列模式**：左右分栏显示两个版本，便于逐行对比
- **内联模式**：在同一视图中标记差异，节省屏幕空间
- **参数对比**：在条目详情中显示世界书B的对应参数，支持实时编辑
- **语法高亮**：支持多种内容格式的语法着色

### 智能编辑系统

#### 编辑策略
- **参数级编辑**：直接在条目详情中编辑世界书B的参数，支持关键字、逻辑、位置、概率等所有字段
- **内容级应用**：将 A 侧的内容更改应用到 B 侧，支持选择性应用差异块
- **暂存机制**：支持暂存模式，批量提交修改，避免频繁磁盘写入
- **撤销机制**：支持单步撤销和批量撤销操作

### 版本管理

#### 会话状态管理
- **实时同步**：修改内容实时反映在对比界面中
- **状态持久化**：会话状态在页面刷新后保持
- **历史追踪**：记录所有应用的修改操作

#### 保存机制
- **即时保存**：关闭暂存模式时，参数修改立即写入世界书文件
- **暂存保存**：开启暂存模式时，修改暂存在内存中，手动触发批量保存
- **验证保存**：保存后自动验证内容是否正确写入
- **回滚支持**：保存失败时提供回滚选项

## 使用指南

### 创建对比会话

1. **选择源世界书**
   - 在世界书编辑器中选择要作为基准的世界书

2. **选择目标世界书**
   - 从下拉列表中选择要对比的另一个世界书

3. **配置对比选项**
   - 设置上下文行数（默认为 3）
   - 选择是否忽略空白字符差异
   - 启用或禁用词级高亮
   - 选择"只读模式"或"暂存模式"

4. **开始对比**
   - **内容对比**：点击"展开对比"按钮启动内容差异分析
   - **参数对比**：直接展开条目详情查看参数对比

### 理解差异显示

#### 颜色高亮
- **绿色背景**：新增的内容（可自定义颜色）
- **红色背景**：删除的内容（可自定义颜色）
- **黄色高亮**：词级差异标记（可自定义颜色）
- **灰色文本**：上下文行（未修改的内容）（可自定义颜色）

#### 操作按钮
- **应用**：将当前差异块应用到目标侧（内容对比界面）
- **保存暂存**：批量保存所有暂存的参数修改（参数对比界面）
- **撤销上一步**：撤销最近的一次应用操作
- **撤销全部**：撤销所有已应用的操作

### 高级配置

#### 显示选项
- **上下文行数**：控制差异块周围显示的上下文行数
- **折叠相同内容**：自动折叠大段相同的内容
- **同步滚动**：在并列模式下同步左右面板的滚动
- **只读模式**：防止误修改世界书B，仅允许查看对比
- **暂存模式**：开启后修改暂存在内存中，需手动保存

#### 颜色主题
- **行级颜色**：自定义新增和删除行的背景色
- **词级颜色**：自定义词级差异的高亮色
- **调色板**：提供预设的颜色方案

#### 参数对比功能
- **支持的参数**：关键字、逻辑、位置、概率、深度、顺序、组权重、扫描深度、递归设置、角色过滤等
- **实时编辑**：在对比界面中直接编辑世界书B的参数
- **同名匹配**：基于条目标题自动匹配对应的世界书B条目

## 高级功能

### 自定义扩展

#### 添加新的对比模块
```javascript
// 注册新的对比模块
const myModule = {
  name: 'my-custom-module',
  displayName: '自定义模块',
  async initialize(ctx) {
    // 模块初始化逻辑
  }
};

// 在主入口中注册
registerModule(myModule);
```

#### 自定义差异算法
```javascript
// 实现自定义差异计算
class CustomDiffAlgorithm {
  computeDiff(textA, textB, options) {
    // 自定义差异计算逻辑
    return diffResult;
  }
}
```


## 贡献指南

欢迎社区贡献！请遵循以下步骤：

1. **Fork 项目**
2. **创建功能分支** (`git checkout -b feature/NewFeature`)
3. **提交更改** (`git commit -m 'Add some NewFeature'`)
4. **推送分支** (`git push origin feature/NewFeature`)
5. **创建 Pull Request**

## 许可证

本项目采用 GNU AGPLv3 许可证 - 查看 [LICENSE](LICENSE) 文件了解详情。

### 版权信息

Copyright (C) 2025 shin/il1umi

## 支持与反馈

- **Issues**：[GitHub Issues](https://github.com/il1umi/ST-Diff/issues)
- **讨论**：[GitHub Discussions](https://github.com/il1umi/ST-Diff/discussions)



