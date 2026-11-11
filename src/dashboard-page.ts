import retry from "retry";

const retryDelays = retry.timeouts({
  minTimeout: 60_000,
  factor: 2,
  maxTimeout: 900_000,
  retries: 6,
});

export const dashboardPage: string = String.raw`<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>Symphony Machine · 工作總覽</title>
  <style>
    :root {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: #202b3a;
      background: #f5f7fa;
      font-synthesis: none;
      --muted: #667386;
      --line: #e3e8ef;
      --accent: #315dc5;
    }
    * { box-sizing: border-box; }
    body { margin: 0; }
    button, a, summary { -webkit-tap-highlight-color: transparent; }
    button { font: inherit; }
    a { color: var(--accent); text-underline-offset: 3px; }
    a:hover { color: #20428d; }
    :focus-visible { outline: 3px solid #7297ed; outline-offset: 4px; }
    [hidden] { display: none !important; }
    .shell { width: min(1400px, calc(100% - 48px)); margin: 0 auto; padding: 28px 0 40px; }
    .masthead { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; margin-bottom: 18px; }
    .eyebrow { margin: 0 0 7px; color: var(--accent); font-size: 11px; font-weight: 700; letter-spacing: .13em; }
    h1 { margin: 0; font-size: 25px; line-height: 1.3; letter-spacing: -.04em; }
    .subtitle { margin: 7px 0 0; color: var(--muted); font-size: 12px; line-height: 1.6; }
    .connection { padding-top: 4px; flex-shrink: 0; text-align: right; color: var(--muted); font-size: 12px; line-height: 1.7; }
    .connection-state { display: inline-flex; align-items: center; gap: 7px; color: #526071; font-size: 13px; }
    .connection-dot { width: 7px; height: 7px; border-radius: 50%; background: #96a1b1; }
    .connection[data-state="live"] .connection-dot { background: #288367; box-shadow: 0 0 0 4px #e5f2ed; }
    .connection[data-state="stale"] .connection-dot { background: #ba731b; box-shadow: 0 0 0 4px #fcf0dd; }
    .connection[data-state="stale"] .connection-state { color: #925916; }
    .connection-detail { margin-top: 4px; }
    .tabs { display: flex; gap: 6px; overflow-x: auto; border-bottom: 1px solid var(--line); margin-bottom: 18px; padding: 0 2px; }
    .tab { position: relative; flex-shrink: 0; display: flex; gap: 8px; align-items: center; border: 0; background: transparent; color: var(--muted); padding: 11px 13px 13px; cursor: pointer; font-size: 13px; font-weight: 600; }
    .tab::after { content: ""; position: absolute; height: 3px; bottom: 0; left: 12px; right: 12px; background: transparent; border-radius: 3px 3px 0 0; }
    .tab:hover { color: #25364c; background: #edf1f7; }
    .tab[aria-selected="true"] { color: var(--accent); }
    .tab[aria-selected="true"]::after { background: var(--accent); }
    .tab:focus-visible { outline-offset: -4px; }
    .tab-count { min-width: 20px; padding: 1px 6px; border-radius: 5px; background: #e8ecf2; color: #596579; font-size: 11px; text-align: center; }
    .tab[aria-selected="true"] .tab-count { background: #e5edfd; color: var(--accent); }
    .project-heading { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; margin-bottom: 16px; }
    .project-title { margin: 0; font-size: 18px; letter-spacing: -.025em; overflow-wrap: anywhere; }
    .repository { margin: 4px 0 0; color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
    .runner-control { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
    #runner-control { margin-bottom: 18px; }
    .control-state { color: var(--muted); font-size: 12px; line-height: 1.7; }
    .control-state[data-state="paused"], .control-state[data-state="pausing"] { color: #94651f; }
    .control-button { border: 1px solid #cbd6e8; border-radius: 7px; background: #fff; color: var(--accent); padding: 8px 12px; cursor: pointer; font-size: 12px; min-height: 36px; }
    .control-button:hover:enabled { background: #edf2fc; }
    .control-button:disabled { opacity: .55; cursor: default; }
    .control-error { margin: 0 0 14px; color: #ad4f4b; font-size: 12px; line-height: 1.7; }
    .section { margin-top: 20px; }
    .section-heading { display: flex; align-items: center; gap: 9px; margin: 0 0 10px; }
    h3 { margin: 0; font-size: 13px; font-weight: 650; }
    .section-count { color: var(--muted); font-size: 12px; }
    .card { overflow: hidden; border: 1px solid var(--line); border-radius: 12px; background: #fff; box-shadow: 0 2px 4px #202b3a03; }
    .board-heading { flex-wrap: wrap; }
    .snapshot { margin: 0 0 0 auto; color: var(--muted); font-size: 11px; line-height: 1.7; }
    .snapshot.stale { color: #94651f; }
    .board-scroll { overflow-x: auto; padding: 3px 3px 10px; margin: -3px; }
    .kanban { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(190px, 1fr); align-items: start; gap: 10px; }
    .column { min-width: 0; padding: 10px; background: #eaf0f5; border: 1px solid #e1e7ee; border-radius: 9px; }
    .column-heading { display: flex; align-items: center; gap: 7px; margin: 0 2px 10px; }
    .column-heading::before { content: ""; width: 6px; height: 6px; flex-shrink: 0; border-radius: 50%; background: #8592a6; }
    .column[data-column="in_progress"] .column-heading::before { background: #537bd1; }
    .column[data-column="review"] .column-heading::before { background: #9275c4; }
    .column[data-column="ready_to_merge"] .column-heading::before { background: #398b8e; }
    .column[data-column="blocked"] .column-heading::before { background: #bc852b; }
    .column[data-column="done"] .column-heading::before { background: #4d947b; }
    .column-title { margin: 0; font-size: 12px; font-weight: 650; }
    .column-count { margin-left: auto; color: var(--muted); font-size: 11px; }
    .column-empty { margin: 0; padding: 12px 0; color: #7a8799; font-size: 11px; text-align: center; }
    .ticket-list { display: grid; gap: 8px; list-style: none; padding: 0; margin: 0; }
    .ticket { min-width: 0; padding: 11px; border: 1px solid #dfe6ee; border-radius: 7px; background: #fff; }
    .ticket-topline { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-bottom: 5px; }
    .ticket-link { font-size: 11px; font-weight: 650; text-decoration: none; overflow-wrap: anywhere; }
    .ticket-link[href]:hover { text-decoration: underline; }
    .ticket-title { margin: 0; font-size: 12px; font-weight: 550; line-height: 1.65; overflow-wrap: anywhere; }
    .ticket-statuses { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 4px; margin-top: 7px; }
    .ticket-statuses .tag { display: block; overflow-wrap: anywhere; }
    .agent-status[data-status="running"] { color: #315dc5; background: #edf2fd; }
    .agent-status[data-status="blocked"], .agent-status[data-status="waiting"] { color: #94651f; background: #fbf2e4; }
    .agent-status[data-status="done"] { color: #28735d; background: #eaf4ef; }
    .agent-status[data-status="failed"] { color: #ad4f4b; background: #fbefee; }
    .ticket-tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 7px; }
    .ticket-times { margin-top: 6px; color: var(--muted); font-size: 10px; line-height: 1.8; }
    .tag { display: inline-flex; align-items: center; border-radius: 4px; padding: 1px 5px; color: #5e6a7b; background: #f0f3f7; font-size: 10px; font-weight: 500; line-height: 1.6; }
    .tag.mode { color: #5269a0; background: #eef2fb; }
    .tag.human-review { color: #87540d; background: #fff0cd; border: 1px solid #f1d591; font-weight: 650; }
    .tag.no-auto-pickup { color: #684b85; background: #f3eef8; border: 1px solid #dfd2eb; }
    .session { margin-top: 8px; border-top: 1px solid var(--line); padding-top: 7px; }
    .session > summary { color: var(--muted); font-size: 10px; cursor: pointer; }
    .resume-command { display: block; width: 100%; resize: vertical; margin-top: 7px; border: 1px solid #dbe2ec; border-radius: 4px; background: #f7f9fc; color: #435168; padding: 7px; font: 10px/1.6 ui-monospace, SFMono-Regular, Consolas, monospace; overflow-wrap: anywhere; }
    .copy-row { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; margin-top: 5px; }
    .copy-button { border: 1px solid #dbe2ec; border-radius: 4px; padding: 3px 7px; background: #fff; color: #526071; font-size: 10px; cursor: pointer; }
    .copy-button:hover { background: #edf2fa; }
    .copy-status { color: var(--muted); font-size: 10px; }
    .round { padding: 16px; }
    .round-topline { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; }
    .round-theme { margin: 0; font-size: 14px; font-weight: 600; line-height: 1.6; overflow-wrap: anywhere; }
    .status { display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0; border-radius: 5px; padding: 3px 8px; background: #eef1f6; color: #5d6b7d; font-size: 11px; line-height: 1.6; }
    .status::before { content: ""; width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
    .status[data-status="running"] { color: #315dc5; background: #edf2fd; }
    .status[data-status="done"] { color: #28735d; background: #eaf4ef; }
    .status[data-status="waiting"], .status[data-status="blocked"] { color: #94651f; background: #fbf2e4; }
    .status[data-status="failed"] { color: #ad4f4b; background: #fbefee; }
    .round-meta { margin: 6px 0 0; color: var(--muted); font-size: 11px; line-height: 1.8; overflow-wrap: anywhere; }
    .finding { margin: 12px 0 0; border-top: 1px solid var(--line); padding-top: 12px; font-size: 12px; line-height: 1.8; white-space: pre-wrap; overflow-wrap: anywhere; }
    .finding.pending { color: var(--muted); }
    .history-list { display: grid; gap: 8px; }
    .history-round { border: 1px solid var(--line); border-radius: 10px; background: #fff; }
    .history-summary { display: flex; align-items: center; gap: 10px; padding: 12px 16px; cursor: pointer; list-style: none; }
    .history-summary::-webkit-details-marker { display: none; }
    .history-summary::before { content: ""; width: 6px; height: 6px; flex-shrink: 0; border-right: 1.5px solid #7d899a; border-bottom: 1.5px solid #7d899a; transform: rotate(-45deg); transition: transform .12s; }
    .history-round[open] > .history-summary::before { transform: rotate(45deg); }
    .history-theme { flex: 1; min-width: 0; font-size: 12px; font-weight: 550; line-height: 1.7; overflow-wrap: anywhere; }
    .history-date { color: var(--muted); font-size: 11px; white-space: nowrap; }
    .history-content { margin: 0 16px 16px 33px; }
    .history-content .finding { margin-top: 12px; padding-top: 12px; }
    .empty { margin: 0; padding: 18px 16px; color: var(--muted); font-size: 12px; line-height: 1.8; }
    .page-empty { text-align: center; padding: 64px 24px; border: 1px dashed #d6dee9; border-radius: 12px; color: var(--muted); font-size: 14px; line-height: 1.8; }
    .footer { margin: 20px 0 0; color: #7a8799; font-size: 11px; line-height: 1.8; }
    @media (max-width: 640px) {
      .shell { width: calc(100% - 28px); padding-top: 22px; }
      .masthead { gap: 14px; margin-bottom: 14px; }
      h1 { font-size: 23px; }
      .subtitle { font-size: 12px; max-width: 190px; }
      .connection { font-size: 10px; }
      .connection-state { font-size: 11px; }
      .tabs { margin-bottom: 16px; }
      .tab { padding-left: 11px; padding-right: 11px; }
      .snapshot { width: 100%; margin-left: 0; }
      .board-scroll { overflow: visible; }
      .kanban { grid-auto-flow: row; grid-auto-columns: auto; grid-template-columns: minmax(0, 1fr); }
      .round { padding: 14px; }
      .history-summary { flex-wrap: wrap; gap: 8px; padding: 13px; }
      .history-theme { flex-basis: calc(100% - 24px); }
      .history-date { margin-left: 18px; }
      .history-content { margin: 0 16px 18px 34px; }
    }
    @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
  </style>
</head>
<body>
  <main class="shell">
    <header class="masthead">
      <div>
        <p class="eyebrow">SYMPHONY MACHINE</p>
        <h1>工作總覽</h1>
        <p class="subtitle">專案待辦、Symphony 工作與維護結果</p>
      </div>
      <div id="connection" class="connection" data-state="connecting" role="status" aria-live="polite">
        <div class="connection-state"><span class="connection-dot" aria-hidden="true"></span><span id="connection-label">連線中</span></div>
        <div id="connection-detail" class="connection-detail">等待第一筆狀態</div>
      </div>
    </header>
    <div id="runner-control"></div>
    <p id="control-error" class="control-error" role="alert" hidden></p>
    <nav id="project-tabs" class="tabs" role="tablist" aria-label="專案" hidden></nav>
    <div id="projects"></div>
    <p id="page-empty" class="page-empty">正在讀取工作狀態…</p>
    <p class="footer">每 30 秒自動更新 · 可暫停或繼續 Symphony 工作</p>
    <noscript><p class="page-empty">請啟用 JavaScript 以讀取工作狀態。</p></noscript>
  </main>
  <script>
    'use strict';

    const tabs = document.getElementById('project-tabs');
    const projects = document.getElementById('projects');
    const pageEmpty = document.getElementById('page-empty');
    const connection = document.getElementById('connection');
    const connectionLabel = document.getElementById('connection-label');
    const connectionDetail = document.getElementById('connection-detail');
    const controlError = document.getElementById('control-error');
    const projectViews = new Map();
    const statusLabels = { running: '執行中', waiting: '等待中', blocked: '受阻', done: '已完成', failed: '失敗' };
    const ticketColumns = [
      ['todo', 'Todo'], ['in_progress', '進行中'], ['review', 'Review'],
      ['ready_to_merge', 'Ready to merge'],
      ['blocked', 'Blocked'], ['done', 'Done'], ['other', '其他']
    ];
    const dateTime = new Intl.DateTimeFormat('zh-TW', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
    const eventTime = new Intl.DateTimeFormat('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    const clockTime = new Intl.DateTimeFormat('zh-TW', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    let selectedId = null;
    let projectOrder = [];
    let nextViewId = 0;
    let lastUpdatedAt = null;
    let refreshing = false;
    let refreshTimer = null;
    let failedRefreshes = 0;
    let lastSnapshot = null;
    let pendingControl = null;
    let controlVersion = 0;
    const retryDelays = ${JSON.stringify(retryDelays)};
    const globalControl = createControl('all');
    document.getElementById('runner-control').append(globalControl.root);

    function element(tag, className, text) {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    }

    function setText(node, value) {
      const text = value == null ? '' : String(value);
      if (node.textContent !== text) node.textContent = text;
    }

    function createControl(repo) {
      const root = element('div', 'runner-control');
      const state = element('span', 'control-state', '正在讀取執行狀態…');
      state.setAttribute('role', 'status');
      state.setAttribute('aria-live', 'polite');
      const button = element('button', 'control-button', repo === 'all' ? '暫停全部' : '暫停專案');
      button.type = 'button';
      button.disabled = true;
      button.addEventListener('click', () => {
        if (!lastSnapshot || pendingControl !== null || button.disabled) return;
        const scope = repo === 'all' ? lastSnapshot : lastSnapshot.projects.find((p) => p.id === repo);
        if (scope) changePause(repo, !scope.paused);
      });
      root.append(state, button);
      return { root, state, button };
    }

    function updateControl(view, scope, global) {
      const paused = global ? scope.paused : scope.effectivePaused;
      const inherited = !global && lastSnapshot.paused;
      const state = lastSnapshot.stopping ? 'stopping' : paused ? (scope.activeAgents > 0 ? 'pausing' : 'paused') : 'running';
      view.state.dataset.state = state;
      const labels = { running: '執行中', pausing: '暫停中', paused: '已暫停', stopping: '正在關閉' };
      setText(view.state, (global ? '全域：' : inherited ? '全域控制：' : '專案：') + labels[state] + ' · ' + scope.activeAgents + ' 個工作執行中');
      setText(view.button, pendingControl === (global ? 'all' : scope.id)
        ? '處理中…'
        : inherited ? '全域已暫停' : scope.paused ? (global ? '解除全域暫停' : '繼續專案') : (global ? '暫停全部' : '暫停專案'));
      view.button.disabled = pendingControl !== null || inherited || lastSnapshot.stopping;
    }

    function updateControls() {
      if (!lastSnapshot) return;
      updateControl(globalControl, lastSnapshot, true);
      for (const project of lastSnapshot.projects) {
        const view = projectViews.get(project.id);
        if (view) updateControl(view.control, project, false);
      }
    }

    async function changePause(repo, paused) {
      pendingControl = repo;
      controlVersion++;
      clearTimeout(refreshTimer);
      refreshTimer = null;
      controlError.hidden = true;
      updateControls();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      try {
        const response = await fetch('/api/control', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Symphony-Control': '1' },
          body: JSON.stringify({ repo, paused }),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('Control request failed');
        const data = await response.json();
        if (!data || !Array.isArray(data.projects)) throw new Error('Invalid control response');
        render(data);
      } catch {
        setText(controlError, '操作結果尚未確認，請等待狀態更新後再試。');
        controlError.hidden = false;
      } finally {
        clearTimeout(timeout);
        pendingControl = null;
        updateControls();
        if (!document.hidden) refresh();
      }
    }

    function formattedDate(value, formatter) {
      if (!value) return '時間未知';
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? '時間未知' : formatter.format(date);
    }

    function safeUrl(value) {
      if (typeof value !== 'string') return null;
      try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
      } catch {
        return null;
      }
    }

    function setLink(link, value) {
      const url = safeUrl(value);
      if (url) {
        if (link.getAttribute('href') !== url) link.setAttribute('href', url);
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
      } else {
        link.removeAttribute('href');
        link.removeAttribute('target');
        link.removeAttribute('rel');
      }
    }

    function setFinding(node, value, status) {
      const hasSummary = typeof value === 'string' && value.trim().length > 0;
      const text = hasSummary ? value : status === 'running' ? '本輪維護進行中，尚無結果摘要。' : '本輪尚無結果摘要。';
      node.classList.toggle('pending', !hasSummary);
      if (node.dataset.text === text) return;
      node.dataset.text = text;
      const fragment = document.createDocumentFragment();
      const pattern = /https?:\/\/[^\s<>"「」『』（）【】]+/gu;
      let offset = 0;
      for (const match of text.matchAll(pattern)) {
        const raw = match[0];
        const candidate = raw.replace(/[.,;:!?，。；：！？、)\]}]+$/u, '');
        const url = safeUrl(candidate);
        fragment.append(document.createTextNode(text.slice(offset, match.index)));
        if (url) {
          const link = element('a', '', candidate);
          setLink(link, url);
          fragment.append(link, document.createTextNode(raw.slice(candidate.length)));
        } else {
          fragment.append(document.createTextNode(raw));
        }
        offset = match.index + raw.length;
      }
      fragment.append(document.createTextNode(text.slice(offset)));
      node.replaceChildren(fragment);
    }

    function setStatus(node, status) {
      const known = Object.prototype.hasOwnProperty.call(statusLabels, status);
      node.dataset.status = known ? status : '';
      setText(node, known ? statusLabels[status] : '狀態未知');
    }

    // Keep existing nodes in place, including focused links and open history details.
    function orderChildren(parent, nodes) {
      const wanted = new Set(nodes);
      for (const child of Array.from(parent.children)) {
        if (!wanted.has(child)) child.remove();
      }
      let cursor = parent.firstElementChild;
      for (const node of nodes) {
        if (node === cursor) {
          cursor = cursor.nextElementSibling;
        } else {
          parent.insertBefore(node, cursor);
        }
      }
    }

    function createTicket() {
      const root = element('li', 'ticket');
      const topline = element('div', 'ticket-topline');
      const link = element('a', 'ticket-link');
      const mode = element('span', 'tag mode');
      const role = element('span', 'tag');
      const state = element('span', 'tag');
      const agentStatus = element('span', 'tag agent-status');
      const humanReview = element('span', 'tag human-review', '需要人類 review');
      const noAutoPickup = element('span', 'tag no-auto-pickup');
      noAutoPickup.title = '保留手動處理，Symphony 不自動接手；已在執行的 agent 會完成。';
      const title = element('p', 'ticket-title');
      const statuses = element('div', 'ticket-statuses');
      const tags = element('div', 'ticket-tags');
      const times = element('div', 'ticket-times');
      const started = element('div');
      const completed = element('div');
      const blocked = element('div');
      const session = element('details', 'session');
      const command = element('textarea', 'resume-command');
      command.readOnly = true;
      command.spellcheck = false;
      command.rows = 2;
      command.setAttribute('aria-label', '接手 session 指令');
      const copyRow = element('div', 'copy-row');
      const copy = element('button', 'copy-button', '複製');
      copy.type = 'button';
      const copyStatus = element('span', 'copy-status');
      copyStatus.setAttribute('role', 'status');
      copy.addEventListener('click', async () => {
        try {
          if (!navigator.clipboard) throw new Error('Clipboard unavailable');
          await navigator.clipboard.writeText(command.value);
          setText(copyStatus, '已複製');
        } catch {
          command.focus();
          command.select();
          setText(copyStatus, '請手動複製');
        }
      });
      copyRow.append(copy, copyStatus);
      session.append(element('summary', '', '接手 session'), command, copyRow);
      topline.append(link, mode);
      statuses.append(state, agentStatus);
      tags.append(role, humanReview, noAutoPickup);
      times.append(started, completed, blocked);
      root.append(topline, title, statuses, tags, times, session);
      return {
        root, link, mode, role, state, agentStatus, humanReview, noAutoPickup, title, tags, times,
        started, completed, blocked, session, command, copyStatus
      };
    }

    function updateTicket(view, ticket) {
      setText(view.link, ticket.identifier || ticket.id);
      setLink(view.link, ticket.url);
      setText(view.title, ticket.title);
      setText(view.mode, ticket.mode);
      view.mode.hidden = ticket.mode == null;
      const active = ticket.agentStatus === 'running';
      setText(view.role, ticket.role === 'review' ? '審查中' : '執行中');
      view.role.hidden = !active || ticket.role == null;
      setText(view.state, 'Linear · ' + (ticket.state || '未知'));
      const agentLabel = ticket.agentStatus === 'waiting' ? '等待' : statusLabels[ticket.agentStatus] || '無紀錄';
      setText(view.agentStatus, 'Agent · ' + agentLabel);
      view.agentStatus.dataset.status = ticket.agentStatus || '';
      view.humanReview.hidden = !ticket.needsHumanReview;
      setText(view.noAutoPickup, ticket.noAutoPickupLabel);
      view.noAutoPickup.hidden = !ticket.noAutoPickupLabel;
      view.tags.hidden = view.role.hidden && view.humanReview.hidden && view.noAutoPickup.hidden;
      view.started.hidden = !active || !ticket.startedAt;
      setText(view.started, '開始 ' + formattedDate(ticket.startedAt, dateTime));
      view.completed.hidden = !ticket.completedAt && ticket.column !== 'done';
      setText(view.completed, ticket.completedAt ? '完成 ' + formattedDate(ticket.completedAt, eventTime) : '完成時間未知');
      view.blocked.hidden = !ticket.blockedAt && ticket.column !== 'blocked';
      setText(view.blocked, ticket.blockedAt ? 'Blocked ' + formattedDate(ticket.blockedAt, eventTime) : 'Blocked 時間未知');
      view.times.hidden = view.started.hidden && view.completed.hidden && view.blocked.hidden;
      view.session.hidden = !ticket.resumeCommand;
      const command = ticket.resumeCommand || '';
      if (view.command.value !== command) {
        view.command.value = command;
        setText(view.copyStatus, '');
      }
    }

    function createRound(historical) {
      const root = element(historical ? 'details' : 'article', historical ? 'history-round' : 'round');
      const heading = element(historical ? 'summary' : 'div', historical ? 'history-summary' : 'round-topline');
      const theme = element(historical ? 'span' : 'h4', historical ? 'history-theme' : 'round-theme');
      const status = element('span', 'status');
      const date = historical ? element('span', 'history-date') : null;
      const meta = element('p', 'round-meta');
      const finding = element('div', 'finding');
      heading.append(theme);
      if (date) heading.append(date);
      heading.append(status);
      root.append(heading);
      if (historical) {
        const content = element('div', 'history-content');
        content.append(meta, finding);
        root.append(content);
      } else {
        root.append(meta, finding);
      }
      return { root, theme, status, date, meta, finding };
    }

    function updateRound(view, round) {
      setText(view.theme, round.theme || '未命名維護主題');
      setStatus(view.status, round.status);
      if (view.date) setText(view.date, formattedDate(round.startedAt, dateTime));
      const range = round.to
        ? ' · 檢查提交 ' + (round.from ? round.from.slice(0, 12) + ' → ' : '') + round.to.slice(0, 12)
        : '';
      setText(view.meta, '開始 ' + formattedDate(round.startedAt, dateTime) + ' · 更新 ' + formattedDate(round.updatedAt, dateTime) + range);
      setFinding(view.finding, round.summary, round.status);
    }

    function createProject(id) {
      const viewId = 'project-' + (++nextViewId);
      const tab = element('button', 'tab');
      tab.type = 'button';
      tab.id = viewId + '-tab';
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-controls', viewId);
      const tabName = element('span');
      const tabCount = element('span', 'tab-count');
      tab.append(tabName, tabCount);
      tab.addEventListener('click', () => selectProject(id, false));
      tab.addEventListener('keydown', (event) => {
        const index = projectOrder.indexOf(id);
        let next = index;
        if (event.key === 'ArrowRight') next = (index + 1) % projectOrder.length;
        else if (event.key === 'ArrowLeft') next = (index + projectOrder.length - 1) % projectOrder.length;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = projectOrder.length - 1;
        else return;
        event.preventDefault();
        selectProject(projectOrder[next], true);
      });

      const panel = element('section', 'panel');
      panel.id = viewId;
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-labelledby', tab.id);
      const heading = element('header', 'project-heading');
      const headingText = element('div');
      const name = element('h2', 'project-title');
      const repository = element('p', 'repository');
      headingText.append(name, repository);
      const control = createControl(id);
      heading.append(headingText, control.root);

      const ticketSection = element('section', 'section');
      const ticketHeading = element('div', 'section-heading board-heading');
      const ticketCount = element('span', 'section-count');
      const ticketFreshness = element('p', 'snapshot');
      ticketHeading.append(element('h3', '', '工作看板'), ticketCount, ticketFreshness);
      const boardScroll = element('div', 'board-scroll');
      boardScroll.tabIndex = 0;
      boardScroll.setAttribute('role', 'region');
      boardScroll.setAttribute('aria-label', '工作看板');
      const board = element('div', 'kanban');
      const columns = new Map();
      for (const [key, label] of ticketColumns) {
        const root = element('section', 'column');
        root.dataset.column = key;
        root.setAttribute('aria-label', label);
        const heading = element('div', 'column-heading');
        const count = element('span', 'column-count');
        heading.append(element('h4', 'column-title', label), count);
        const list = element('ul', 'ticket-list');
        const empty = element('p', 'column-empty', '暫無工作');
        root.append(heading, list, empty);
        board.append(root);
        columns.set(key, { root, count, list, empty });
      }
      boardScroll.append(board);
      ticketSection.append(ticketHeading, boardScroll);

      const latestSection = element('section', 'section');
      const latestHeading = element('div', 'section-heading');
      latestHeading.append(element('h3', '', '最新維護'));
      const latestCard = element('div', 'card');
      const latest = createRound(false);
      const maintenanceEmpty = element('p', 'empty', '尚無維護紀錄。');
      latestCard.append(latest.root, maintenanceEmpty);
      latestSection.append(latestHeading, latestCard);

      const historySection = element('section', 'section');
      const historyHeading = element('div', 'section-heading');
      const historyCount = element('span', 'section-count');
      historyHeading.append(element('h3', '', '歷史維護結果'), historyCount);
      const historyList = element('div', 'history-list');
      historySection.append(historyHeading, historyList);
      panel.append(heading, ticketSection, latestSection, historySection);
      return {
        tab, tabName, tabCount, panel, name, repository, control, ticketCount, ticketFreshness, columns,
        latest, maintenanceEmpty, historySection, historyCount, historyList,
        tickets: new Map(), history: new Map()
      };
    }

    function updateProject(view, project) {
      setText(view.tabName, project.name);
      setText(view.tabCount, project.tickets.length);
      view.tabCount.setAttribute('aria-label', project.tickets.length + ' 項工作');
      setText(view.name, project.name);
      setText(view.repository, project.repository);
      setText(view.ticketCount, project.tickets.length + ' 項');
      view.ticketFreshness.classList.toggle('stale', project.ticketsStale || !project.ticketsUpdatedAt);
      setText(view.ticketFreshness, !project.ticketsUpdatedAt
        ? 'Linear 快照暫時無法取得'
        : (project.ticketsStale ? 'Linear 快照已過期 · 保留 ' : 'Linear 快照更新於 ') + formattedDate(project.ticketsUpdatedAt, dateTime));
      const ticketIds = new Set(project.tickets.map((ticket) => ticket.id));
      for (const id of view.tickets.keys()) if (!ticketIds.has(id)) view.tickets.delete(id);
      const columnNodes = new Map(ticketColumns.map(([key]) => [key, []]));
      for (const ticket of project.tickets) {
        let ticketView = view.tickets.get(ticket.id);
        if (!ticketView) {
          ticketView = createTicket();
          view.tickets.set(ticket.id, ticketView);
        }
        updateTicket(ticketView, ticket);
        columnNodes.get(ticket.column).push(ticketView.root);
      }
      for (const [key, column] of view.columns) {
        const nodes = columnNodes.get(key);
        setText(column.count, nodes.length);
        column.root.hidden = key === 'other' && nodes.length === 0;
        column.empty.hidden = nodes.length > 0;
        orderChildren(column.list, nodes);
      }

      const latestRound = project.maintenance[0];
      view.latest.root.hidden = !latestRound;
      view.maintenanceEmpty.hidden = Boolean(latestRound);
      if (latestRound) updateRound(view.latest, latestRound);
      const historical = project.maintenance.slice(1);
      view.historySection.hidden = historical.length === 0;
      setText(view.historyCount, historical.length + ' 輪 · 展開查看');
      const historyIds = new Set(historical.map((round) => round.id));
      for (const id of view.history.keys()) if (!historyIds.has(id)) view.history.delete(id);
      const historyNodes = historical.map((round) => {
        let roundView = view.history.get(round.id);
        if (!roundView) {
          roundView = createRound(true);
          view.history.set(round.id, roundView);
        }
        updateRound(roundView, round);
        return roundView.root;
      });
      orderChildren(view.historyList, historyNodes);
    }

    function selectProject(id, focus) {
      selectedId = id;
      for (const [projectId, view] of projectViews) {
        const selected = projectId === id;
        view.tab.setAttribute('aria-selected', String(selected));
        view.tab.tabIndex = selected ? 0 : -1;
        view.panel.hidden = !selected;
      }
      if (focus && projectViews.has(id)) projectViews.get(id).tab.focus();
    }

    function render(data) {
      lastSnapshot = data;
      const focused = document.activeElement;
      projectOrder = data.projects.map((project) => project.id);
      const ids = new Set(projectOrder);
      for (const id of projectViews.keys()) if (!ids.has(id)) projectViews.delete(id);
      const tabNodes = [];
      const panelNodes = [];
      for (const project of data.projects) {
        let view = projectViews.get(project.id);
        if (!view) {
          view = createProject(project.id);
          projectViews.set(project.id, view);
        }
        updateProject(view, project);
        tabNodes.push(view.tab);
        panelNodes.push(view.panel);
      }
      orderChildren(tabs, tabNodes);
      orderChildren(projects, panelNodes);
      if (!ids.has(selectedId)) selectedId = projectOrder[0] || null;
      selectProject(selectedId, false);
      tabs.hidden = data.projects.length === 0;
      pageEmpty.hidden = data.projects.length > 0;
      setText(pageEmpty, '尚未設定任何專案。');
      if (focused && focused.isConnected && document.activeElement !== focused) focused.focus({ preventScroll: true });
      updateControls();
    }

    async function refresh() {
      if (refreshing || document.hidden || pendingControl !== null) return;
      clearTimeout(refreshTimer);
      refreshTimer = null;
      refreshing = true;
      const version = controlVersion;
      let delay = 30000;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      try {
        const response = await fetch('/api/status', { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error('Status request failed');
        const data = await response.json();
        if (version !== controlVersion) return;
        if (!data || !Array.isArray(data.projects)) throw new Error('Invalid status response');
        render(data);
        if (data.projects.some((p) => p.effectivePaused && p.activeAgents > 0)) delay = 1000;
        failedRefreshes = 0;
        lastUpdatedAt = data.updatedAt;
        connection.dataset.state = 'live';
        setText(connectionLabel, '連線正常');
        setText(connectionDetail, '更新於 ' + formattedDate(lastUpdatedAt, clockTime));
      } catch {
        delay = retryDelays[Math.min(failedRefreshes, retryDelays.length - 1)];
        failedRefreshes += 1;
        connection.dataset.state = 'stale';
        setText(connectionLabel, '連線中斷，正在重試');
        setText(connectionDetail, lastUpdatedAt ? '保留 ' + formattedDate(lastUpdatedAt, clockTime) + ' 的狀態' : '尚未取得狀態');
        if (!lastUpdatedAt) setText(pageEmpty, '暫時無法取得狀態，將自動重試。');
      } finally {
        clearTimeout(timeout);
        refreshing = false;
        if (!document.hidden && pendingControl === null) refreshTimer = setTimeout(refresh, delay);
      }
    }

    document.addEventListener('visibilitychange', () => {
      clearTimeout(refreshTimer);
      refreshTimer = null;
      if (!document.hidden) refresh();
    });
    refresh();
  </script>
</body>
</html>`;
