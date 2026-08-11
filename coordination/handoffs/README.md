# 交接 Outbox

Codex完成需要`gcli2api-manager`继续处理的`MGMT-*`任务时，必须基于
`../HANDOFF_TEMPLATE.json`创建一个不可覆盖的新JSON文件，例如：

```text
MGMT-001-G-1.json
MGMT-001-G-2.json
```

文件名必须等于JSON中的`delivery_id`。文件进入`dev7`或默认分支后，Actions会自动投递
并在目标仓库创建或更新Issue；此过程不调用Codex模型。`execution_policy`必须保持
`queue_only`和0次自动运行。禁止在文件中写入Token、密码、真实邮箱或完整凭证。
