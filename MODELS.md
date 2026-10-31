# 模型使用指南（下载 → 合并 → 运行）

> 本仓库附带两个**本地运行的编程助教模型**，基于 Qwen3-4B + LoRA 微调，4-bit 量化后仅 2.33 GB。
> 完全离线，不上传任何代码。

| 模型 | 任务 | 输入 | 输出 |
|---|---|---|---|
| **qwen-err-v17** | 报错解释 | 一段报错日志 | `## Why` + `## Fix` |
| **qwen-review-v9** | 代码审查 | 一段源代码 | 五段：审查结论/错误位置/原因分析/修复方案/验证建议 |

支持语言：**C / C++ / Java / Python**，中英双语。

---

## 1. 下载

到本仓库的 **Releases → v1.0-models**：
<https://github.com/Artemis-ingenious/error-explainer/releases/tag/v1.0-models>

| 文件 | 大小 |
|---|---|
| `qwen-err-v17-dist.zip.part01` | 1.30 GB |
| `qwen-err-v17-dist.zip.part02` | 1.20 GB |
| `qwen-review-v9-dist.zip.part01` | 1.30 GB |
| `qwen-review-v9-dist.zip.part02` | 1.20 GB |

**因为 GitHub 单文件上限 2 GiB，包被切成了两段。** 下载后必须先合并。

---

## 2. 合并与校验

### Windows

```powershell
copy /b qwen-err-v17-dist.zip.part01+qwen-err-v17-dist.zip.part02 qwen-err-v17-dist.zip
copy /b qwen-review-v9-dist.zip.part01+qwen-review-v9-dist.zip.part02 qwen-review-v9-dist.zip
```

### Linux / macOS

```bash
cat qwen-err-v17-dist.zip.part* > qwen-err-v17-dist.zip
cat qwen-review-v9-dist.zip.part* > qwen-review-v9-dist.zip
```

### 校验（合并后务必做一次）

| 文件 | 大小 | SHA256 |
|---|---|---|
| `qwen-err-v17-dist.zip` | 2.33 GiB | `2761a0ed351786fa36f6b985ba5187bfd8471ec968788c20d2b0b9af1c114b3d` |
| `qwen-review-v9-dist.zip` | 2.33 GiB | `5b95a21fdab803548847a9e1928bbb9f12258e262e5a24e4ff1865f95e689ceb` |

```powershell
Get-FileHash .\qwen-err-v17-dist.zip -Algorithm SHA256
```

```bash
shasum -a 256 qwen-err-v17-dist.zip
```

不一致说明下载损坏，重新下载那一段。

---

## 3. 安装与创建模型

1. 安装 [Ollama](https://ollama.com/download)
2. 解压并进入目录：

```powershell
Expand-Archive .\qwen-err-v17-dist.zip -DestinationPath .\err-v17
cd .\err-v17
```

3. 创建模型（`Modelfile` 已随包提供，无需修改）：

```powershell
ollama create qwen-err-v17 -f Modelfile-err-v17
ollama create qwen-review-v9 -f Modelfile-review-v9
```

4. 运行：

```powershell
ollama run qwen-err-v17 "Main.java:6: 错误: 找不到符号 total"
```

---

## 4. 怎么问才对

### 报错解释（qwen-err-v17）

**只贴报错原文**，不要加"请分析下面这段报错"，也不要包代码围栏。

```
Main.java:6: 错误: 找不到符号
        System.out.println(total);
                           ^
  符号:   变量 total
1 个错误
```

返回：

```
## Why
报错中给出的位置：`Main.java:6`。
total 在使用前没有声明……

## Fix
int total = 0;
```

### 代码审查（qwen-review-v9）

**必须带语言 + 代码围栏**：

```
请审查下面这段 C 代码：

```c
int a[5]; for (int i = 0; i <= 5; i++) a[i] = i;
```
```

返回五段式结构。

---

## 5. 通过 API 调用

```bash
curl http://127.0.0.1:11434/api/chat -d '{
  "model": "qwen-err-v17",
  "messages": [
    {"role": "system", "content": "你是一名编程报错解释助手。用户会贴一段报错信息，请用两段回答：「## Why」说明原因，「## Fix」给出修复方法和代码。回答语言：中文。"},
    {"role": "user", "content": "Main.java:6: 错误: 找不到符号 total"}
  ],
  "stream": false
}'
```

**system 提示词必须逐字使用**，模型行为高度依赖它：

| 模型 | 中文 system |
|---|---|
| v17 | `你是一名编程报错解释助手。用户会贴一段报错信息，请用两段回答：「## Why」说明原因，「## Fix」给出修复方法和代码。回答语言：中文。` |
| v9 | `你是一名严谨的编程代码审查与教学助手，擅长 Python、C 和 C++。…（五段格式）` |

---

## 6. 硬件与性能

| 项 | 要求 / 实测 |
|---|---|
| 内存 | **≥ 8 GB**（Q4_K_M 约 4.3 GB 权重 + 上下文） |
| 显存 | 有 6 GB 以上会自动走 GPU |
| 速度 | CPU 约 6~11 token/s；GPU 明显更快 |
| 磁盘 | 每个包解压后约 2.4 GB |

---

## 7. 已知限制（请务必知道）

| 限制 | 说明 |
|---|---|
| **未训练语言** | Node/JS、TypeScript、C#、Go、Rust **不可信**，它会硬套已有模式 |
| **修复代码未验证** | 模型给的代码没有经过编译，请自行运行 |
| **个别误判** | `error C4996` 这类"error 但文案像 warning"可能被判为不是错误 |
| **正常输出会被拒** | 贴 warning、构建成功日志、源码，它会回"这不是报错"——这是**预期行为** |
| 评测样本量 | 12 条留出样本上定位 12/12，样本量仍小 |

---

## 8. 常见问题

| 现象 | 处理 |
|---|---|
| `ollama create` 找不到文件 | 在 `Modelfile` 所在目录执行，或把 `FROM ./xxx.gguf` 改成绝对路径 |
| 回答被截断 | 改 `Modelfile` 里 `num_predict 350` 为 500，重新 `ollama create` |
| 中文乱码 | 终端 `chcp 65001`，或改用 API 调用 |
| 回答"这不是报错" | 你贴的内容确实不是 error（warning/日志/源码） |
| 内存不足 | 换 16 GB 机器，或关闭其他程序 |

---

## 9. 版本信息

| 项 | 值 |
|---|---|
| 基座 | Qwen3-4B-Instruct-2507（Apache-2.0） |
| 微调 | QLoRA，r=16 / alpha=32 |
| 数据 | 报错解释 188 条；代码审查 1140 条（全部真实编译器产出） |
| 量化 | GGUF Q4_K_M（2.33 GiB） |
| 训练资源 | 8 GB 显存笔记本，188 条约 7.5 分钟 |

> 基座许可为 Apache-2.0，可商用与再分发；再分发时请保留原许可声明。
