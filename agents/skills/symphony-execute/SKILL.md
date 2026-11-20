---
name: symphony-execute
description: 明確指定 Symphony 時，以 Lead 執行指定 Linear tickets，支援 direct 與模型 override；明確啟用，不自動接管一般 app 開發。
---

# Symphony execute

讀取相對於此 `SKILL.md` 的 `../../workflows/WORKFLOW.md`。這是 Symphony Machine checkout 與已安裝 skill 共用的路徑；每個 skill 目錄獨立連結到使用者的 `.agents/skills/`，已安裝時對應使用者 home 下的 `.agents/workflows/WORKFLOW.md`，不依賴 `CODEX_HOME`。

以 Lead 角色依 workflow 的 `setup` 與目前 issue state 接手或續做指定 ticket(s)。讀取 Linear ticket 上的 Direct、Lead model／reasoning 與 Implementation model／reasoning labels，再與本次 prompt 的明確指示依 workflow 優先序解析；未指定 mode 時 delegated。派工時實際傳入有效的 Implementation model／reasoning，並如實記錄目前 Lead session，而不宣稱 ticket label 已切換 session。Process、ownership、project override 與交付邊界均以 workflow 定義為準。

手動 Execute 進 In Review 後，依 workflow 的「手動 Execute 的審查交接」在同一流程派獨立 Reviewer，按當前 PR head 的審查結論完成交接。Runner 派工時，獨立 review turn 由 runner 啟動。

依 workflow 的 `setup` 確認 Linear 工具可用。手動 Codex／Antigravity 使用目前 session 的 Linear plugin；headless runner 使用 launcher 指定的官方 Linear MCP。連線或授權缺失時回報，禁止改用瀏覽器或直接呼叫 API。
