# Symphony workflow

本檔是 Symphony Machine 維護的正式中文 workflow，定義實際採用的流程、模式與分工。明確呼叫 Symphony skill 或由 runner 派工時啟用。對外的 Linear 狀態與交接語意以 [Linear interface contract](LINEAR-CONTRACT.md) 為準。

## 共通フレーム與分工

本流程依共通フレーム區分需求與設計的層級。システム是共同達成目的的整體，包含人、硬體、作業系統與軟體；app、web client、backend、database 都是其中的軟體。一張 ticket 可以涉及多個軟體的要件，層級依對象與互動邊界判斷，不依 repo 或 ticket 數量。

以下定義工作內容的粗細度與 owner。從輸入已達到的層級接續，已有內容直接引用，不重做已完成的決定；但 Intake 的面向盤點與交接檢查、Execute 的要件可行性檢查、升級處理及追溯是必走流程。即使人類已指定某個 method 如何修改，也須能指出預期結果、適用約束與驗證依據。只展開本次涉及的系統／軟體邊界，其餘面向記錄不適用理由。

| Step | Process／層級與責任 | Ownership |
| --- | --- | --- |
| setup | [載入與選擇流程](#setup) | 目前 agent |
| intake | [システム要件定義〜ソフトウェア要件定義](#intake)：系統要件定義釐清整體需要達成的行為與條件；系統方式設計釐清人、硬體、OS 與各軟體的分工，以及系統之間、人與系統如何溝通；軟體要件定義確定各軟體對外必須提供的行為與互動，例如人與 app、backend 與 database 的互動。 | 人類／額外授權的 Intake agent；人類核准 |
| plan | [ソフトウェア方式設計](#plan)：在已確認要件下，設計軟體內各元件如何協作達成要件，包括元件責任、API／interface、資料與控制流、validation 與邊界值處理。 | Lead |
| design | [必要的 UI／Figma 設計](#design)：將已確認的互動與概念具體化為畫面及實作資訊。 | Lead |
| implement | [ソフトウェア詳細設計、実装、test](#implement)：依 plan 完成元件內部的詳細設計、程式碼、測試與修正。 | Implementation；direct 時為 Lead |
| verify | [驗證與 review](#verify)：Lead 完成自查與驗證證據，獨立 Code Reviewer 正式審查 PR。 | Lead／Code Reviewer |
| publish | [交付](#publish)：交付可審查成果、完成 review 後交給 merge 流程，維護 PR／issue 狀態。 | Lead／Code Reviewer；依政策需要時由人類審查 |
| resume | [阻礙與續做](#resume)：整理待決事項與恢復點，依人類決定續做。 | Lead／人類 |

對外必須滿足的條件屬於要件；為達成條件而選擇的元件與程式介面設計屬於 plan。人類已指定的技術約束仍是輸入，不因層級而刪除。`design` 是本流程的 UI／Figma ownership 分工；軟體方式設計由 `plan` 負責，詳細設計由 `implement` 負責。

定義參考：[IPA 共通フレーム2013](https://www.ipa.go.jp/publish/secbooks20130304.html)、[第3部ガイダンス §2.3.2–2.3.3、§2.4.2–2.4.5](https://www.ipa.go.jp/publish/qv6pgp000000107j-att/000062659.pdf)，分別對應系統要件／方式設計與軟體要件／方式設計／詳細設計／構築。上述階段與 agent owner 的對應是本 workflow 的分工。

## Principles

本流程定義 what：結果、責任與交接邊界；how 留給 Lead 與實作者的 engineering judgement。

- **應**：應達成的結果／責任，具體方法可調整；無法達成時說明缺口。
- **可**：允許的方式或裁量，不是必填 checklist。
- **必須**：必走流程／必備交付條件，不因任務小或節省 token 而略過；已有證據可引用。
- **不應**：原則上避免；有工程理由可在 contract 與授權內調整，不自動增加人工批准。
- **不得**：MUST NOT
- Plan 應在使用者確認的 requirement contract 內，實作依已確認的指示與必要 plan 進行。變更邊界依明確 human steering。
- 應完整交付 contract；planning／review 不應追加未承諾的品質要求。工程嚴謹程度依實際影響決定。
- 要件完整性、明確性與可追溯性優先於 token efficiency。簡單修改仍須完成面向盤點與追溯，可用短句、引用與精簡 plan 表達；不因此要求不適用的設計或全套測試。每個不適用面向都須有理由，可合併相同理由的項目。
- 人類／Lead 可在任何階段加入重要 implementation notes，區分已定約束、建議、未解問題；不因階段名稱把重要決策留給 implementation agent 猜。

## setup

### 共存與載入

人類明確選用 Symphony（例如呼叫 symphony-intake／symphony-execute），或 runner 明確呼叫執行入口時，才啟用本流程；存在本檔或 repo override 不表示自動啟用。

同一次工作使用一套主流程。已選 Symphony 時，不疊加其他完整開發流程；可使用 Figma、平台與工具技能完成專門工作。交給 implementation agent 時明確帶入 `workflow: symphony` 與本檔位置，讓子 agent 沿用同一流程。

互動 session 選用任一 Symphony 入口時，Linear plugin 是必要的 runtime dependency。凡涉及 Linear issue、project、initiative、document、state、comment、workpad、PR 連結或交付狀態的讀寫，必須使用已載入的 Linear plugin 工具；不得開啟 Linear 網頁、使用 browser／computer-use，或直接呼叫 Linear REST／GraphQL API、SDK、CLI、curl 或其他 plugin 以外的 API 路徑。plugin 未載入、未連線或未授權時，停止 Linear 相關工作並回報缺口，不得 fallback。Skill／workflow 只宣告此依賴，不負責安裝、登入或替 session 載入 plugin。

Runner 的 headless session 使用 launcher 指定的官方 Linear MCP 取代 Desktop plugin；同樣不得 fallback 到 REST／GraphQL 或 browser。Runner 提供的 Linear state mapping 對應 [Linear interface contract](LINEAR-CONTRACT.md) 的語意，不以本檔中的顯示名稱硬寫狀態。Runner 已指定 ticket worktree／branch／baseline 時，沿用該工作區，不切換或更新共用 root checkout。執行交付到 In Review 後，由獨立 Code Reviewer 正式審查；完成後進 Ready to merge，由 Merge agent 規劃順序，純 TypeScript coordinator 執行 merge 與清理。Lead 依下述政策判定必要的人類審查，既有明確 gate 仍須滿足。

讀取人類提供的需求／討論、既有 issue（若有）、適用的 AGENTS.md、相關規格與現況，確認目標 repo；Intake 尚未確定 repo 時，隨討論確認後再載入其規則。再讀 repo root 的 `WORKFLOW-OVERRIDE.md`（若存在）。此檔是自訂約定，載入責任在本 workflow，不假定 runner 原生支援。

優先順序：本次人類明確指示 → repo 明確 override → 本共用流程。Override 預設補充，只有明確說明取代的部分才覆蓋；未覆蓋部分繼承。各項說明 step ID、適用條件與補充／取代內容即可。AGENTS.md 提供 repo 工程規則；若有實質衝突，釐清當次影響，不另複製流程。

例如 `verify — 補充` 可要求 VM lifecycle 變更做 QEMU 實測；`publish — 補充` 可要求 milestone 人工驗收；`design — 例外` 可說明無 Figma 工作。沒有 override 就使用共用流程，不需先建立檔案。多 repo 任務按各 repo 的適用規則執行。

### Baseline 與 branch 判斷（Intake／Execute）

除非人類已明確指定 branch、baseline 或不得更新，Intake 與 Execute 在接手 repo 工作時都必須先檢查目前 branch、working tree、upstream／remote、現有 branch 與本次 task／PR 的關係，以及 repo 的 default branch；再由 agent 依任務脈絡判斷應沿用現況，或回到 default branch 並取得其 remote 最新版本。不得只因 session 已位於某個 branch 就默認沿用，也不要求人類替 agent 做一般 branch 判斷。

開發新功能時，若目前 branch 是先前其他 task 留下、與本次工作無關的 branch，預設應保留既有工作後回到 default branch，從 remote 取得最新 baseline（例如在 `main` 上 fast-forward 到最新 `origin/main`），再建立或切換到本次 task 的 branch。若是續做同一 task／PR、stacked PR 有指定 base、repo 規則另有要求，或人類明確指定沿用目前 branch，則依該脈絡選擇 baseline。遇到未提交變更、無法 fast-forward、remote 不可用或 branch ownership 不明時，先保護既有工作並查清狀態；不得覆蓋、丟棄或把其他 task 的變更混入本次成果，必要時依 `resume` 升級。

### 執行模式與模型

| Role | Default model | Reasoning |
| --- | --- | --- |
| Intake | gpt-6-astra | medium |
| Lead | gpt-5.6-sol | high |
| Implementation | gpt-6.1-sol | high |

模型是預設，不是角色限制。由低到高套用：共用預設 → project override → Linear ticket label → 本次 prompt／人類明確指示；只覆蓋指定欄位。Evaluation 指定是有效 override，不需再核准同一選擇。派工時傳入實際解析後的 model／reasoning；組合不受工具支援時回報，不默默換回預設。

Linear ticket 可用下列互斥 label groups 保存 task override；每組都可省略，只在需要覆蓋繼承值時套用：

- `Symphony mode/Direct`
- `Lead model/<model-id>`
- `Lead reasoning/<level>`
- `Implementation model/<model-id>`
- `Implementation reasoning/<level>`

沒有 `Symphony mode/Direct` 時採 delegated；不另設 delegated label。Intake 可依派工成本、Lead ownership／工具需求與可用 Implementation 能力決定是否標記 Direct，但 label 記錄的是解析後的執行指示，不需把判斷理由編入 label 名稱。人類直接將 ticket 放入 Todo 而未經 Intake 時，沒有這些 labels 仍是有效輸入並沿用預設。Ticket scope 實質變更時，Intake／人類應重新評估相關 labels。

第一階段由人類 trigger Intake／Lead，使用人類選定的 session；讀取本檔或 Lead labels 不會切換正在執行的模型。Execute 應核對有效 Lead model／reasoning 與目前 session，在 workpad 簡記實際值、期望值與來源，避免把未生效的設定寫成已生效。若需要精確的 Lead 選擇，應由人類／launcher 以該設定啟動 session。

`symphony-execute` 在規劃前讀取 ticket labels 與本次 prompt，解析有效 mode 與 role settings。Direct 由目前 Lead 完成實作，不派 Implementation worker，也不使用 Implementation model／reasoning；delegated 時 Lead 必須把解析後的 Implementation model／reasoning 實際傳給 implementation agent。未知值、互斥設定衝突或工具不支援的組合應回報，不默默換回預設。模式與模型選擇分開；Execute 不因 task 大小自行改 mode，也不自行覆寫 Intake／人類的 routing 決定。Direct 省略 Implementation worker handoff／等待，沿用相同 scope、驗證、workpad 與授權邊界；正式 code review 仍交給未參與本次實作的獨立 Code Reviewer。

## Linear 狀態與交接

先讀 [Linear interface contract](LINEAR-CONTRACT.md)，取得必要 status、各 status 的意義、control labels、依賴與交付資訊的介面。這裡不另維護狀態表。以下段落使用該文件的語意名稱，實際寫入依目前 project／runner 的 state mapping；找不到必要對應時回報，不自行建立 team states。

## intake

由人類或人類額外授權的 agent 執行；指定 symphony-intake 可授權 agent 協助本次需求整理，但人類核准仍由人類負責。Intake 可從尚無 ticket 的討論開始，也可處理一張或多張既有 ticket。Agent 依人類指示與需求，在適當的 Linear project 建立或更新一張或多張 ticket；拆分依需求邊界與依賴判斷，不預設一次討論只對應一張 ticket。尚未核准的 ticket 留在 Backlog。

確認目標 repo 後，Intake 應依「Baseline 與 branch 判斷」檢查並選定適合本次需求探索與現況查證的 baseline；除非人類已有明確指示，這項判斷由 Intake agent 完成。選擇結果與必要理由應留給 Execute 接續，不把先前無關 task 的 branch 當成本次需求現況。

與人類動態整理需求，依前述層級共同探索本次涉及的系統／軟體要件。Intake agent 可主動提出功能與非功能需求、討論取捨，與人類反覆完善，直到雙方 align 且人類核准。Ticket 記錄要件、必要背景與已定約束，作為 Lead 進行軟體方式設計的依據；提案與已確認需求應可區分，同一條件不重複記錄。人類核准後，寫入 ticket 的需求須符合核准範圍，不得自行補入未核准的要求；新增或變更需求應再與人類討論並取得核准。

可引用既有規格、用例與重要 implementation notes，區分已定約束、建議與未解問題。

驗收條件應描述可觀察結果，預設由 agent 負責實作驗證、介面檢查與必要證據。只有人類明確要求查看介面、預覽或親自驗收時，才將對應範圍列為 owner 待看／驗收項目；未提出時不需逐張詢問是否要看，也不得因涉及 UI、視覺或使用體驗，就自行加入「owner 驗收介面」等 AC、完成條件或人工 gate。必要驗證受工具／環境限制而無法完成時，應記錄具體缺口並依 resume 處理，不把驗證責任預設轉交 owner。

### 必走的要件釐清流程

1. **整理輸入與邊界**：確認問題、目標、利害關係人、現況、資料來源與本次範圍；將明確指示、既有契約、提案與未知事項分開。來源衝突須顯示差異，不能挑一份默認為答案。
2. **逐面向盤點**：下表每一面向都必須檢查，記錄「已確認／待確認／不適用」、結論與來源或理由。已有明確答案直接引用；其餘適用面向必須向人類提問，不能以 agent 假設、使用者沉默或未提及視為已確認。共用規範可引用具體版本與條款，不用重問已定事項。
3. **分輪補問與走查**：先問會影響範圍、責任與可行性的問題，再問行為與品質細節；每輪集中相關問題，提供選項、取捨與建議。依角色走查正常、替代、失敗與恢復情境，檢查跨邊界及多條要件互動；答案引入新情境時繼續補問，直到沒有影響本次 contract 的未決問題。不可只跑一次問題清單就宣告完成。
4. **形成可驗收契約**：依下述格式整理要件、約束、驗收與依賴，檢查矛盾、模糊用語、缺漏與無法驗證之處。Intake 的系統方式設計也須建立對應要件的追溯。
5. **整體回讀與核准**：向人類呈現本次完整契約或可直接查閱的連結，明列範圍、排除項、取捨及尚待處理項目，確認核准的是哪一版內容。核准前完成下述交接檢查；局部回答不自動等於核准整份契約。

### 通用面向清單

盤點紀錄保存在 ticket 本文或其連結的共用契約中，每列包含面向、狀態、結論／來源／不適用理由及相關 REQ／Q ID，不能只留在聊天中。下表是必須檢查的面向，問題是引導而非固定問卷；須按答案展開適用問題，不能把列出的例子一律變成產品要求。

| 面向 | 必須釐清的問題 |
| --- | --- |
| 目的、現況與成功定義 | 誰遇到什麼問題、何時發生、現有替代方式為何？為何需要改變？成功如何觀察、衡量與驗證？ |
| 範圍、優先順序與限制 | 本次包含／排除什麼？哪些不可妥協、哪些可取捨？時程、預算、資源、既有技術或組織限制為何？衝突時由誰決定？ |
| 角色與系統邊界 | 使用者、管理者、維運者與外部系統有哪些？人、硬體、OS、各軟體分別負責什麼？信任與責任在哪裡交接？ |
| 功能與使用情境 | 各角色在什麼前提下，以什麼入口／觸發執行什麼操作？正常、替代、取消、重複與中斷流程的可觀察結果為何？ |
| 業務規則與狀態 | 輸入、輸出、欄位、驗證與邊界值為何？狀態如何轉移，哪些操作允許／禁止？順序、重複請求、並行操作、時間與時區如何影響結果？ |
| 資料生命週期 | 資料來源、權威來源、擁有者與品質要求為何？如何建立、讀寫、匯入匯出、保留、刪除及遷移？一致性、衝突與歷史資料如何處理？ |
| 介面與整合 | 人與系統、系統與系統如何互動？對外契約、協定、格式、版本及相容要求為何？依賴何者提供，是否可用？失敗、逾時與部分成功如何呈現及處理？ |
| 互動與可用性 | 各操作需要哪些資訊、回饋與確認？空白、載入、成功、錯誤及恢復狀態為何？裝置／輸入方式、無障礙、語言與地區需求為何？無 UI 時仍檢查其他操作介面。 |
| 效能、容量與資源 | 在何種資料量、負載、並行量與環境下，延遲、吞吐、容量、CPU／記憶體／儲存或成本須滿足什麼界線？如何測量，是否有尖峰與成長假設？ |
| 可靠性、可用性與恢復 | 可接受的停機、錯誤、資料遺失與恢復時間為何？斷線、重啟、依賴故障或部分完成時須保證什麼？重試、降級、備份與還原有哪些對外要求？ |
| 安全、隱私與合規 | 身分驗證與權限邊界為何？涉及哪些敏感資料、威脅、祕密、同意與稽核需求？保存、刪除、加密與法規／政策約束是否適用，來源與確認責任人是誰？ |
| 環境、相容與交付 | 支援哪些平台、版本、網路與部署環境？安裝、升級、舊資料／客戶端相容、推出及回復要求為何？有何外部授權、存取權或發布條件？ |
| 維運、可觀測性與維護 | 誰負責操作、支援及維護？需要哪些記錄、指標、告警、診斷、稽核或操作文件？設定、擴充及變更有何已定限制？記錄本身是否有敏感資訊限制？ |
| 驗收、依賴與風險 | 每條要件如何證明滿足？Agent 驗證需要哪些測試資料、環境或設備？由誰提供、何時可用？人類已明確要求的驗收範圍為何（若有）？有哪些不可行疑慮、未驗證假設與相依交付，失敗如何處理？ |

非機能要件不得只寫「快速、安全、穩定、易用」。適用時須包含條件、可觀察標準／門檻與驗證方法；定性條件也須有具體判準。數值由需求與人類決定，不由 agent 任意訂 SLA、coverage 或安全標準。無法定義時保持待確認；需要探索才能回答時，提出有明確產出與退出條件的調查工作，經核准後獨立交接，不把探索假設包裝為已承諾的產品行為。

### 要件契約與交接檢查

每條要件必須有 issue 範圍內穩定且唯一的 ID，例如 `REQ-001`；跨 issue 使用 `<issue-id>/REQ-001`。ID 不隨排序改變、不回收；修訂保留原 ID 與變更紀錄，拆分／合併保留新舊對應。共用要件保留單一權威來源，各 ticket 引用並說明自身責任。AC、DES 與 Q ID 沿用相同的穩定性及跨 issue 引用規則。

每條要件記錄：

- ID、層級（系統／軟體）、類型（機能／非機能／約束）、負責邊界與要求內容；一條要件表達一個可獨立判定的義務。
- 來源連結／訊息或既有規格的版本與條款、需求理由，以及確認狀態。由上層要件推導時列出父 ID；工程提案與假設不得標成已核准。
- 適用角色、前提／觸發、可觀察結果與必要的例外／邊界條件；無關欄位可略去，但不得略去判定結果所需資訊。
- 驗收條件與對應 `AC-001` 等穩定 ID、驗證方法及所需環境／資料／責任人；一個 AC 可驗證多條要件，但須逐一列出。
- 優先順序、依賴與已核准取捨；若有未解問題，連到 `Q-001` 等待決項，記錄影響、待誰回答與解除條件。

Intake 宣告完成前必須確認：所有面向都有處置；每條適用要件有來源、明確內容與可判定的驗收條件；跨要件無未解衝突；範圍、責任、必要依賴與可行性風險已交代；系統方式設計能追溯要件；人類核准範圍與契約版本已記錄。影響範圍、行為、非機能標準或驗收的待決問題不得帶進 Todo。可延後的事項須由人類明確同意移出本次範圍或另立調查／後續 ticket，並記錄影響與依賴；不得把本次不可缺的要件改稱後續改善而宣告 ready。可由 Execute 決定的內部設計選擇須明確標為工程裁量，不視為要件缺口。

Intake 應依 setup 的規則評估執行模式及 Lead／Implementation model 與 reasoning。只有需要覆蓋 project／共用預設時才加入相應 Linear label；delegated 與各角色預設值不需額外標記。這些 labels 是 Execute 的 durable task instructions，仍受本次 prompt／人類明確指示覆蓋。

UI 行為、概念方向與已定約束於此整理，簡單修改用文字即可；需要設計素材時可引用 Lead 製作的 Figma temp page、生成 image 或既有畫面加註。是否要求 owner 查看依上述明確要求規則，不把概念稿或後續介面驗收設為預設人工 gate。概念稿不要求像素精確，Placeholder 不自動成為需求。

Intake 完成且人類核准後，Intake agent 應將需求、決定與參考填妥 Linear ticket，並將 ticket 移到 Todo。人類可一次核准多張 ticket；agent 應將該批已完成 Intake 且在核准範圍內的 ticket 一起移到 Todo，未核准的仍留在 Backlog。這是 Intake 的交付責任，不需再等人類另外指示改狀態。Intake 在這裡交接，不因需求核准就自行啟動 Execute。

## plan

Lead 必須先依「Baseline 與 branch 判斷」重新核對 Execute 當下的 repo 狀態，不因 Intake 曾選過 baseline 就假定目前 checkout 仍正確；必要時回到 default branch、取得 remote 最新版本，再建立或切換本次 task branch。接著對照已確認要件與現況完成入口檢查：確認契約版本、scope 與排除項，逐條檢查要件是否明確、一致、可行、可驗證，並以 Intake 面向清單檢查是否有影響本次成果的遺漏。核對必要依賴、環境、權限與驗收資源；未知部分記錄證據缺口，不能當作已驗證可行。既有 ticket 缺 ID 時，可在 workpad 對原文段落建立 ID 對照而不改寫語意；實質缺口依 resume 升級，不為補格式要求人類重新核准。

完成入口檢查後，Lead 判斷尚需哪些軟體方式設計；輸入已足以實作時，可引用原指示作為精簡 plan，仍須留下要件對應與驗證方法。需要規劃時，必要時重現問題，完成軟體方式設計：將要件分配到各軟體內的元件，確定元件間的 API／interface、資料與控制流，以及 validation、邊界值與錯誤處理方式，讓實作者能據此完成詳細設計。重要 implementation notes 可提前決定。

Plan 放在 Linear workpad，依需要交代範圍、必要實作方向、baseline／branch、acceptance cases、適用 checks、交付條件與升級邊界。Lead 依 verify 的人類審查政策判定是否需要 owner code review，記錄理由與 owner 須檢查的內容；實作範圍改變時重新判定。必要的外部 contract test cases 應由 Lead 說清，其餘留給工程判斷；不逐行設計程式碼。

### 端到端追溯（必走）

Intake 負責要件來源、層級推導及系統方式設計的對應；Execute 的 Lead 維護其後的設計、實作與驗證對應。每個方式設計項目使用穩定 ID（例如 `DES-001`），至少記錄設計內容、對應 REQ ID、選擇理由與適用約束。涵蓋責任分配、元件、介面、資料／控制流、狀態、失敗處理與非機能措施；UI 設計及重要詳細設計決策沿用同樣規則。純粹的內部實作細節可透過所屬 DES 間接追溯，不要求每行程式或每個區域變數有 ID。

每個設計決策都必須說明如何滿足所連的要件，不能只列一串 ID。必要的技術支援設計可連到它支援的 DES，再追到 REQ，記錄必要性；任何追不到要件的產品行為或品質承諾都須先釐清，不能以「工程改善」偷渡 scope。設計發現上層要件不足時，依 resume 升級，不自行補出已核准要件。

Workpad 必須維護下列對照，可連到既有契約與成果而不複製內容；每條範圍內要件至少一列，多對多關係明列 ID：

| 要件 ID／來源版本 | 設計 ID／位置與理由 | 實作／成果位置 | AC ID／驗證方法 | 證據／commit | 狀態／缺口 |
| --- | --- | --- | --- | --- | --- |
| `<issue-id>/REQ-001` → 契約條款 | `DES-001` → 設計段落 | 檔案／符號／文件／設計節點 | `AC-001` → 判定方法 | 測試結果／人工驗收紀錄及版本 | 未開始／進行中／通過／失敗／受阻 |

在 plan 完成前補齊要件到設計與驗收的對應；實作與證據尚未產生時標示待完成，交付前補齊。不需要程式修改的要件也須記錄如何由既有能力、設定、操作或文件滿足，以及驗證依據。不得以空欄、全數勾選或「測試全綠」替代逐條判定。

契約變更須記錄版本／日期、受影響 REQ／AC ID、變更前後、原因與人類決定來源；Lead 由對照表找出受影響的設計、實作與測試，更新 plan／handoff 並重驗受影響部分。舊證據保留但標示其適用版本，不得拿變更前的通過結果宣稱新版已滿足。

沿用已有授權；需求內的設計不因 plan 寫完就自動再等人類批准。影響產品結果、scope 或外部 authority 的新選擇交回人類，需等待時進 Blocked。

多 issue 時先看依賴與重疊範圍，Lead 決定適合的順序／PR 切分，不預設每張都可並行。每份可寫 checkout 的責任應清楚，保留人類與其他任務變更。

- **Stacked PR** 用於人類分開審查或分次部署。說明 base、依賴與交付順序；不只因 context 大就拆 PR。中間 PR 可先審，issue 尚有實作時仍為 In progress；真正等待依賴時為 Blocked。
- **Checkpoint** 用於 context 理解與實作正確度。Lead 可定義 step 的輸入、輸出與完成證據；可全在同一 PR，不自動要求人類核准。

## design

需要 Figma 時由 Lead 負責，將已對齊概念細化為適用的正式節點、狀態、版面與實作資訊，再交給實作者。這是 ownership override；不因名稱含「實作」就交給 Implementation。

Implementation 的 Figma 輸入是唯讀，需要修改時回報 Lead。沒有設計變更可略過，既有設計加精確修改說明已足夠時不重建整套 Figma。工具型 skill 依其用途使用，不把它們變成另一套主 workflow。

## implement

派工模式下，Lead 提供可續做的 handoff：`workflow: symphony`、本檔與 repo override 位置、workspace／branch／baseline、當前 plan 摘要與 workpad 連結、契約版本、負責的 REQ／DES／AC ID 與追溯表、必要契約／Figma 輸入、寫入範圍、驗證與交付條件、未解事項與升級觸發條件，以及適用 checkpoint／執行期限。模型解析依 setup。

Implementation 依已確認的指示與必要 plan，補足尚缺的ソフトウェア詳細設計（元件內部邏輯、資料結構與演算法），完成實作、合理測試及失敗修正，回傳成果、版本、驗證結果與未解事項。重要未決事項回 Lead；Lead 可在 contract 內決定，需人類裁決或外部依賴時進 Blocked。

Implementation 回報必須標明受影響的 REQ／DES／AC ID、實作位置與驗證證據，由 Lead 更新追溯表。發現不可行、矛盾、遺漏或無法驗收時立即回報 Lead，停止依賴該未決選擇的實作；不得自行降低標準、改外部行為或用測試略過掩蓋缺口。Direct 的 Lead 適用相同規則。

Lead 在 worker 正常執行時等待完成、checkpoint、阻礙或約定期限，避免重複實作與無必要監工。可用工具支援的事件／分段等待；到期檢查是慢、阻礙或 hang，再決定延長、恢復或升級，不把定時醒來當成全面 review。

Direct mode 由 Lead 執行同樣的實作責任，不派 worker。完成後仍做 verify。

## verify

### Lead 自查與驗證證據

Lead 保留一般開發自查責任，讀取實際 change 與 evidence，確認 plan contract、外部 correctness、本次 code style 與合理 test coverage；Direct 也適用。這不取代下述獨立 Code Reviewer 的正式 review。測試應能辨識必要 contract 被破壞，不要求固定 coverage 百分比或所有測試類型。

Lead 必須雙向核對追溯表：每條範圍內 REQ 都有相符的設計／實作與逐項 AC 證據，每項交付設計／行為也都能回到 REQ 或其必要技術支援理由。逐條核對非機能條件的量測環境與判準、必要失敗／邊界情境，以及證據對應的契約版本和 commit。未驗證、失敗或受阻明列，不以其他測試通過抵銷。發現規格本身不足依 resume 處理；實作未滿足既定要件則修正實作，不反向修改要件讓測試通過。

Lead 負責必要的本機 checks、CI/CD、已授權 dev／per-PR deployment 與 smoke test，並留下對應當前 head 的結果與 artifact 連結。必要檢查以本次要件、repo 規則與具體回歸風險決定；已有足夠證據可沿用，不為完整感重跑不相關全套檢查。正常 CI／deployment pending 時，由程式每 5 分鐘查詢一次，每輪等待期限為 120 分鐘；等待期間維持 In Progress，不只因 pending 就標 Blocked，也不把未完成驗證交給 reviewer。期限內可自行處理的程式、測試、CI/CD、smoke 或證據缺口由原 Lead 接續；必須等待外部依賴、權限或人類決定才依 resume 升級。重查、rerun、修正及更換 agent 均不重置同一輪 deadline；到期停止自動等待，保留 run／head、已耗時間、原因與未完成門檻，依 repo 等待政策交接。不得透過回 Todo 自動開始新一輪來繞過上限；取得人類續做指示或依賴解除證據後才能續做。此期限不改變 runner coordinator 的 polling schedule。

### 人類 code review 政策

已核准範圍內的工作，預設由 Lead 自查、獨立 Code Reviewer 與必要驗證完成交付；一般功能、bug fix、refactor、文件及 CI/CD 修改均適用。技術與專業判斷由 agent 負責。這是此個人專案明確採用的人類審查政策。

介面查看／驗收依 intake 的明確要求規則；Lead 與 Reviewer 不得因涉及 UI、視覺或使用體驗而自行追加 owner 驗收。

Lead 必須在 PR 記錄需要／不需要人類 code review 的理由，並在 workpad 摘要及連結該判定。以下正面列表只決定 owner 是否須檢查已完成的實作或做實機驗收：

- Ticket、repo 規則或既有人類決定已明確要求本次的人類 code review／實機驗收。
- 刪除、覆寫既有資料，或 schema／migration／recovery 變更會造成不可逆或難以還原的資料影響；可逆的新增欄位、索引等變更不自動觸發。
- 新增付費服務、訂閱，或會提高支出的計費／預算／用量設定變更；既有核准預算內的正常使用不自動觸發。
- 新增第三方 API 整合或供應商，或擴大既有整合的 OAuth／存取權限、資料外送範圍或外部操作能力；既有整合在已核准邊界內的一般修正不自動觸發。
- 新增或擴大存取權、敏感資料暴露範圍，或降低 sandbox／trust boundary 的隔離與保護；維持既定安全契約的修正由 agent 審查。
- 移除或降低必要檢查、approval gate、merge／branch protection；一般測試參數、cache、建置或已授權部署腳本修改不自動觸發。
- 必須由人類操作實體設備、且 agent 無法完成的實機驗收；明列設備、操作步驟與驗收標準。

需要人類 code review／實機驗收時，判定必須指出觸發的條款、本次具體影響、owner 須檢查的程式／實機驗收項目、證據入口與完成條件。只有「涉及 CI/CD／資安／資料／API」等分類名稱不足以成立。需求、操作或預算已核准，不等於已完成人類 code review／實機驗收；已完成的審查只依其適用版本與範圍沿用。缺少判定或判定無上述依據時回 Todo 由原 Lead 補齊，不由 reviewer 臨時發明人類 gate。程式、測試或證據不足交回 Lead 處理。

完成的成果只等這類人類 code review／實機驗收時，保持 In Review 並加 `needs-human`，連到 PR 與具體待看項目。人類完成審查／驗收後，將 issue 移到 Ready to merge 即完成交接，不需另外建立 SQLite permission；此時殘留的 `needs-human` 不阻擋 merge 流程，`no-auto-pickup` 仍優先禁止自動接手。其他狀態的 `needs-human` 仍須等待人類處理。

任何階段發現需要人類決策、需求變更或尚缺操作／費用授權，一律依 resume 進 Blocked＋`needs-human`，記錄待決問題與恢復條件；review 中發現也適用，不能留在 In Review 等決策。既有明確核准已涵蓋同一決策或操作時，引用其範圍與來源，不重問。In Review 的 human code review 不承擔待決事項，也不能把未完成實作包裝成待人類 review。

### 獨立 Code Reviewer

每份 PR 都必須由未參與本次實作的 Code Reviewer 正式審查，包括 Direct。Runner 以獨立 review turn 接手；手動 Execute 也須安排獨立 reviewer。Reviewer 不改程式、不 merge；修正與證據補齊交回原 Lead，通常沿用 branch／PR／workpad。

首輪檢查完整 PR diff、已核准要件及直接受影響的既有 context，涵蓋：

- 要件／功能 correctness、設計與 interface 的一致性。
- 錯誤處理、恢復及資料一致性。
- 本次相關的安全、隱私與信任邊界。
- 複雜度、可維護性，以及有意義且適當的測試與文件。

可閱讀 callers／callees 等既有 code 理解行為與 regression；這是 context，不是擴張 ticket 或全面審查 repo 的授權。阻擋 finding 必須有具體位置、觸發條件、影響及證據，並指出違反的要件、既有契約或本次引入／加劇的缺陷。個人偏好、nit、想像中的未來案例及無需求依據的測試矩陣不得阻擋交付。既有且非本次造成的問題，自主建立對應 project 的 Backlog ticket 給人類 triage；已有相同 ticket 可沿用。簡述問題、影響、證據與來源 issue／PR，不順手擴大本次修正。若確實阻擋本次 contract／必要驗證，說明依賴，需人類決定時進 Blocked。

後續 review 只檢查前輪 findings 的處置、前輪後的新修改與其直接影響。同一 head 上新增的 Lead 回覆也可能需要確認處置，不要求為了回應 finding 製造 code commit。只有 timestamp 改變不構成再審理由。不得把首輪漏看、且後來沒有改動或因新修改而受影響的既有問題，追加成本輪新 blocker。Reviewer 在 PR 留下已審 head、範圍與結論，讓下一輪沿用已完成的審查，不每次重新全面 review。

### Finding 處置與交接

詳細 findings、修正回覆與處置一律放 GitHub PR reviews／comments／threads。Lead 可接受並修正，也可用具體理由與證據在 PR 拒絕 finding，例如觸發前提不成立、既有契約允許、證據已涵蓋，或建議超出核准範圍；不能只寫「不同意」或無理由略過。正常 self-check 持續由 Lead 負責，正式獨立 review 不回歸由 Lead 自評取代。

有修正／補證據需求時回 Todo 交原 Lead；重新具備目前 head 的證據後回 In Review，按上述增量範圍再審。Lead 的拒絕處置不得豁免已核准要件、必要人類 approval 或 GitHub protections；涉及改變這些條件的分歧依 resume 交人類決定。

Reviewer 確認目前 head 的要件與必要驗證證據完整、blocking findings 已修正或有上述具體理由與證據的拒絕處置、所需人類 gates 已滿足後，才交接 Ready to merge。Linear 只保留狀態、需求／人類決定、workpad 連結及精簡交接；以 PR 連結指向詳細 review，不另複製一份 finding 清單。

本節的審查面向、證據與非阻擋建議原則參考 [Google review checklist](https://google.github.io/eng-practices/review/reviewer/looking-for.html) 與 [review standard](https://google.github.io/eng-practices/review/reviewer/standard.html)；分工與專業風險參考 [GitLab code review](https://docs.gitlab.com/development/code_review/)。[GitHub agents responsible use](https://docs.github.com/en/copilot/responsible-use/agents) 與 [OWASP secure code review](https://owasp.github.io/DevSecOpsGuideline/2-Process/2-2-Develop/2-2-3-Secure-Code-Review/) 提供 agent 限制及安全審查脈絡。上述來源不決定本 workflow 的狀態、增量審查邊界或人類審查裁量；這些是本專案已採用的政策。

## publish

Execute 的交付範圍包含工作 branch 的 commit、push、開／更新 PR、必要 CI／review feedback 處理，以及指定 issue 的 state／workpad／成果連結更新，仍依 repo gates 與已有授權執行。不是 merge、deploy 或任意外部發布的概括授權。

Lead 準備 open、non-draft 且以 configured branch 為 target 的 PR，提供結果、契約版本、要件／驗收覆蓋摘要、追溯表及當前 head 的必要本機／CI/CD／smoke 證據，移到 In Review。交付前必須確認範圍內要件無漏項、追溯無斷點，且沒有尚待裁決的 contract 缺口；核准移出的項目保留決定與後續連結。人類 code review 只依 verify 的政策要求，不將所有 ticket 一律設為人工審查。

### Merge 規劃與執行

Linear 的 Ready to merge 是 review 完成到 merge 流程的權威交接，包含人類完成必要審查／驗收後直接移入的 issue；不要求另有 SQLite merge-permission 紀錄。Merge agent 只評估候選順序、依賴、修改重疊與整合風險，引用既有 review 結論，不重做完整 code review、不寫程式、不 update branch／rebase／解 conflict，也不 merge。純 TypeScript coordinator 依計畫重新讀取 GitHub／Linear facts，執行 checks、expected-head merge 與清理，不自動更新 PR branch；agent 不取得這些執行責任。Ready to merge 不豁免目前 head 的驗證、CI、依賴或 GitHub protections。

每個 repo 在啟動時及每隔 `merge.group_interval_minutes`（預設 30 分鐘）收集當下符合條件的 Ready PR，建立固定成員的 group；沒有候選不啟動 agent，只有一份也要跑 Merge planning。每組保留一次規劃的順序，個別 PR 合併或退出不重新規劃；新候選等下一組。前一組仍在規劃、執行、等待 CI 或冷卻時，跳過排程且不補跑。SQLite 保存 group、PR head、剩餘順序、排程與觀察進度作為執行／恢復計畫，不授予或取代 Linear 的 merge 交接。中斷或失敗的規劃沿用原 conversation 恢復。

Coordinator 每次依序 merge 一份，下一份 CI pending 時等待，不越過它。合併後等待新 target SHA 的 CI／已納入指定 workflow 的 deployment 成功，再觀察 `merge.cooldown_minutes`（預設 5 分鐘）才處理下一份；最後一份也完成觀察才結束 group。target SHA 改變或健康結果非成功時重算觀察，期限到時重新查證目前 target。兩項時間皆可由 YAML 熱重載；CI 與 PR 檢查頻率仍由 `polling` 設定。觀察窗口保留檢查 production 的時間，不額外引入監控服務。缺失或 pending CI 都不是通過；target CI 失敗依既有 CI repair 流程處理，修復 PR 可使用已規劃的本組位置或獨立規劃的修復 group，不受一般收組排程限制，避免等待中的 group 擋住修復；仍須完成 review、PR checks 與 merge agent 規劃，修復後的 target CI 與觀察窗口完成才續做一般 merge。

遇到 conflict 或必要的 branch update，回 Todo 交原 Lead，說明原因、PR 與受影響範圍，並移除 Ready to merge 已完成的人類交接所殘留的 `needs-human`，讓 Lead 可續做；若有新的待決人類問題，仍依升級流程加上該 label。由 Lead 在原 branch／PR 處理整合，完成受影響修改與必要 CI/CD／smoke 驗證，再回 In Review 增量審查。其他 PR head 更新也須確認受影響部分的新 head 證據，不能沿用不適用的舊證據；CI pending 時不立即啟動完整 review。審查完成後重新交接 Ready to merge；單純 timestamp 改變不使完成的 review 失效。

退回與完成的狀態交接依 Linear interface contract，通常沿用 branch／PR／workpad，不固定全部重開。Runner 情境由 coordinator 負責 merge／清理，Done 由 Linear–GitHub integration 更新；Execute 不自行處理。手動情境也只能執行已有明確授權的 merge／deploy，不因 In Review、Ready to merge 或 Closed 自動取得外部操作權限。

## resume

需求、人類決定、狀態與續做摘要以 Linear issue／comments／workpad 為主；詳細 code-review findings、回覆與處置以 GitHub PR 為主。次要：人類在 Codex／tmux 給指示；影響需求、決策與交付時把必要結論同步回 Linear，不貼完整聊天或複製詳細 review。

### 要件異常與升級處理（所有 Execute 階段適用）

以下情況一經發現，必須記錄並處理，不等到 review 才揭露：要件彼此或與實際環境衝突；在已定技術、資源、成本或時程限制內無法達成；缺少會改變產品行為的規則／例外；非機能條件無法達成或無法判定；必要依賴、權限或驗收資源不可用；新證據推翻 Intake 假設；設計需要新增／改變要件或排除項。潛在風險尚未證實時可先做範圍內、可逆的查證，記錄方法與停止條件，不以無限嘗試延後升級。

1. **定位與保留證據**：建立 `Q-...` 待決項，連到受影響 REQ／DES／AC ID 與契約版本；說明預期、實際發現、重現／證據及影響範圍。Intake 遺漏也照實記錄，不隱藏成一般實作問題。
2. **依決策權分流**：Implementation 先交 Lead。Lead 可自行處理 contract 內的演算法、元件內部安排或等效技術替代，記錄決策與追溯；影響 scope、外部行為、品質標準、驗收、既定約束或外部授權者，必須交人類決定。執行失敗若只需修正程式以滿足原要件，不要求重新核准。
3. **提出可裁決方案**：說明保留原要件需要什麼、可行替代方案與對範圍／成本／時程／風險的影響、建議及需要人類回答的具體問題。沒有可行替代也須明說，不能臆造承諾。
4. **隔離受阻工作並通知**：停止依賴未決答案的工作；可續做有明確邊界且不依賴該決定的已授權工作。必須依下段新增 Linear escalation comment 並更新 workpad；當 issue 必須等待人類或 dependency 才能推進時標為 Blocked。不得默認答案、降低驗收、擴張範圍或以既有核准代替新決策。
5. **閉環恢復**：取得人類決定或 dependency 解除證據後，記錄回答、來源與待決項狀態；若改變 contract，同步契約版本、追溯表、plan、handoff 與必要 issue／依賴，再回適用階段重驗受影響部分。沒有回答不視為核准，不能僅因等待一段時間便恢復受阻工作。

需要人類決定時，負責對外溝通的 agent 應除了在執行輸出說明，也在對應 Linear issue 新增 escalation comment，讓人類不開 terminal 仍能看到並回覆。Comment 應說清楚待決問題、必要背景、可行選項與建議（若有）、受阻範圍及恢復條件，並提及需要回覆的人類；同時將阻礙與 comment 連結摘要到 workpad，需等待時依 [Linear interface contract](LINEAR-CONTRACT.md) 的狀態語意處理。單純修改既有 workpad 或改 state 不取代這則待決通知；同一未解問題沿用討論串，有實質變化再補充。人類在 Linear 的決定應於 resume 時讀取並納入後續工作。Linear 寫入失敗時，輸出應明示尚未送達並保留待同步內容，不把本機輸出視為已通知人類。

每個 issue 沿用一則 workpad comment，Lead 維護；Implementation 回報 checkpoint／成果，避免共同覆寫。按有意義的變化更新，不每個操作打 API。內容依工作需要包含：

- 契約版本、要件來源／ID 對照、Plan／DES ID、必要 implementation notes、內部 task status／checkpoints。
- 要件 → 設計 → 實作 → 驗收證據的追溯表，以及變更影響與決定紀錄。
- 驗證結果、對應 branch／PR／commit、附件／CI artifact 連結，以及 PR review／finding 處置連結。
- Working memory：已定決策、重要發現、未解問題、下一步。
- 阻礙原因、需要誰／哪個 dependency、解除條件與恢復點。
- `workflow: symphony`、mode、有效 model override，讓接手者沿用同一流程。

這些是續做摘要而非完整思考；契約版本、追溯及已發生的要件變更／待決事項是必要內容，其他依工作適用性記錄。Repo 保存長期架構／介面／操作知識，task plan／memory 不需另外 doc commit。Linear 暫時不可用可保留本機暫存，恢復後同步回原 workpad，避免雙重權威。

恢復時先讀最新 Linear state、workpad 與 PR feedback，再核對工作樹／commit；保留已完成工作，不把舊 plan 覆蓋人類新決定。原 session 不在時也應能從這些資訊接續。手動 session 的 Review 交接不表示有背景監看，仍由人類 trigger 續做，不建立未要求的 polling／排程；runner session 則由 runner 的既有 polling 與恢復機制接手。
