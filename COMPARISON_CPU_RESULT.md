CPU test result, 2026-10-01. This is the container CPU experiment, not the user's RTX 4070 result.

Initial checkpoint SHA256: 5b4076701c16e10f6c4781d036c0878a30889b70fbf9882b4e9e49e20760af16

Reviewed GPT source SHA256: 7186eb351608ca61199785565115f5ffb0509b96bebbebe0a358e2b1aff5479e

Starting held-out accuracy: 53.8384%. The user's prior GPU checkpoint started at 55.96%, so this does not predict their result.

The service is the actual TypeScript TrainingLabSync / TrainingLabRepository hosted by the test-only Node filesystem adapter. Live Obsidian, Windows PowerShell and CUDA are not exercised here.

# Lain Brain：同起点、同训练步数对照

两组都从同一份冻结权重、全新的 AdamW 状态开始。验证集、学习率、批量和每组更新次数相同。
第一轮参数逐位一致检查通过；第二轮比较完整 Brain 策略（错误任务优先抽样 + 接纳定义生成样本）与均匀抽样。

| 种子 | 普通训练 | Brain 反馈 | 差值（百分点） |
|---:|---:|---:|---:|
| 1337 | 68.08% | 67.78% | -0.30 |
| 2027 | 68.08% | 66.57% | -1.52 |
| 4099 | 66.77% | 65.45% | -1.31 |

平均差值：-1.04 个百分点。
Brain 胜 / 平 / 负：[0, 0, 3]。

## 实际成本

| 种子 | 组 | 更新秒数 | 总耗时秒数 | 审阅模型准备秒数 | 对象样本抽样次数 |
|---:|---|---:|---:|---:|---:|
| 1337 | baseline | 8.91 | 11.41 | 0.00 | 0 |
| 1337 | brain_objects | 10.68 | 27.30 | 13.38 | 4800 |
| 2027 | brain_objects | 15.09 | 18.69 | 0.01 | 4800 |
| 2027 | baseline | 9.49 | 12.21 | 0.00 | 0 |
| 4099 | baseline | 9.40 | 12.03 | 0.00 | 0 |
| 4099 | brain_objects | 9.35 | 12.04 | 0.01 | 4800 |

## 解释边界

这是固定起点的少量种子重复，不是多个独立预训练模型。验证的是同一组 15 个函数在未训练输入组合上的预测，不能说明未见函数或组合推理能力。
990 个验证上下文含同一三元组的六种排列，彼此相关；本报告不把它们当作独立样本计算显著性。此前已查看过该验证集，结论属于探索性结果。
对象生成样本在这个小任务上与对应原训练样本相同，因此本实验检验整个反馈抽样策略，不能单独证明符号表示带来收益。
训练步数相等，不代表总算力相等。审阅模型准备、评估、验证与文件交换都计入每组总耗时；缓存审阅模型的历史训练成本不包含在本次耗时内。
为检查配对，使用确定性算法和 math attention；与之前自动训练的运行设置不同。没有挑选表现最好的种子，正负结果都保留。
