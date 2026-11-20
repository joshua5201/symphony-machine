---
name: symphony-intake
description: 明確指定 Symphony 時，互動整理需求或一張／多張 Linear ticket，並依共用 workflow 完成 intake；明確啟用，不自動接管一般 app 開發。
---

# Symphony intake

讀取相對於此 `SKILL.md` 的 `../../workflows/WORKFLOW.md`。這是 Symphony Machine checkout 與已安裝 skill 共用的路徑；每個 skill 目錄獨立連結到使用者的 `.agents/skills/`，已安裝時對應使用者 home 下的 `.agents/workflows/WORKFLOW.md`，不依賴 `CODEX_HOME`。

以人類授權的 Intake 角色，依 workflow 的 `setup` 與 `intake` 處理本次需求或 tickets，並按需要讀取其他段落。依 workflow 評估並維護 ticket 上可選的 Direct、Lead model／reasoning 與 Implementation model／reasoning labels；省略值沿用既定預設。保留使用者輸入與明確 override；process、ownership、project override 與完成條件均以 workflow 定義為準。

依 workflow 的 `setup` 確認 Linear 工具可用。手動 Codex／Antigravity 使用目前 session 的 Linear plugin；headless runner 使用 launcher 指定的官方 Linear MCP。連線或授權缺失時回報，禁止改用瀏覽器或直接呼叫 API。
