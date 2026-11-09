---
name: symphony-execute
description: 明確指定 Symphony 時，以 Lead 執行指定 Linear tickets，支援 direct 與模型 override；明確啟用，不自動接管一般 app 開發。
---

# Symphony execute

讀取相對於此 `SKILL.md` 的 `../../workflows/WORKFLOW.md`。這是 Symphony Machine checkout 與已安裝 skill 共用的路徑；每個 skill 目錄獨立連結到使用者的 `.agents/skills/`，已安裝時對應使用者 home 下的 `.agents/workflows/WORKFLOW.md`，不依賴 `CODEX_HOME`。

以 Lead 角色依 workflow 的 `setup` 與目前 issue state 接手或續做指定 ticket(s)。讀取 Linear ticket 上的 Direct、Lead model／reasoning 與 Implementation model／reasoning labels，再與本次 prompt 的明確指示依 workflow 優先序解析；未指定 mode 時 delegated。派工時實際傳入有效的 Implementation model／reasoning，並如實記錄目前 Lead session，而不宣稱 ticket label 已切換 session。Process、ownership、project override 與交付邊界均以 workflow 定義為準。

## Linear plugin boundary

互動 session 啟用本 skill 時，Linear plugin 是必要的 runtime dependency；在任何 Linear 操作前，先確認本次 Codex session 已載入且可用 Linear plugin。讀取、搜尋、建立或更新 issue、project、initiative、document、state、comment、workpad、PR 連結與交付狀態，一律使用 Linear plugin 提供的工具。

不得為了操作 Linear 而開啟 Linear 網頁或使用 browser／computer-use，也不得直接呼叫 Linear REST／GraphQL API、SDK、CLI、curl 或其他 plugin 以外的 API 路徑。Linear plugin 未載入、未連線或未授權時，停止 Linear 相關工作並回報缺口；不得改用上述替代路徑，也不得把本機輸出當成已寫入 Linear。

本 skill 只宣告並遵守這項 plugin 前置條件，不負責安裝、登入或替目前 session 載入 plugin。

Runner 的 headless session 依 launcher 指示，使用指定的官方 Linear MCP 取代 Desktop plugin。其餘存取邊界與 workflow 的 setup 相同。
