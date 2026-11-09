---
name: symphony-intake
description: 明確指定 Symphony 時，互動整理需求或一張／多張 Linear ticket，並依共用 workflow 完成 intake；明確啟用，不自動接管一般 app 開發。
---

# Symphony intake

讀取相對於此 `SKILL.md` 的 `../../workflows/WORKFLOW.md`。這是 Symphony Machine checkout 與已安裝 skill 共用的路徑；每個 skill 目錄獨立連結到使用者的 `.agents/skills/`，已安裝時對應使用者 home 下的 `.agents/workflows/WORKFLOW.md`，不依賴 `CODEX_HOME`。

以人類授權的 Intake 角色，依 workflow 的 `setup` 與 `intake` 處理本次需求或 tickets，並按需要讀取其他段落。依 workflow 評估並維護 ticket 上可選的 Direct、Lead model／reasoning 與 Implementation model／reasoning labels；省略值沿用既定預設。保留使用者輸入與明確 override；process、ownership、project override 與完成條件均以 workflow 定義為準。

## Linear plugin boundary

互動 session 啟用本 skill 時，Linear plugin 是必要的 runtime dependency；在任何 Linear 操作前，先確認本次 Codex session 已載入且可用 Linear plugin。讀取、搜尋、建立或更新 issue、project、initiative、document、state、comment、workpad 與相關交接內容，一律使用 Linear plugin 提供的工具。

不得為了操作 Linear 而開啟 Linear 網頁或使用 browser／computer-use，也不得直接呼叫 Linear REST／GraphQL API、SDK、CLI、curl 或其他 plugin 以外的 API 路徑。Linear plugin 未載入、未連線或未授權時，停止 Linear 相關工作並回報缺口；不得改用上述替代路徑，也不得把本機輸出當成已寫入 Linear。

本 skill 只宣告並遵守這項 plugin 前置條件，不負責安裝、登入或替目前 session 載入 plugin。

Runner 的 headless session 依 launcher 指示，使用指定的官方 Linear MCP 取代 Desktop plugin。其餘存取邊界與 workflow 的 setup 相同。
