// @ts-check
/// <reference lib="dom" />

const vscode = acquireVsCodeApi();

/** @type {Map<string, boolean>} */
const expandedSessions = new Map();

/** @type {any[]} */
let currentSessions = [];

/**
 * Save input values and scroll positions before a re-render.
 * @returns {{ inputs: Map<string, string>, scrolls: Map<string, {top: number, atBottom: boolean}> }}
 */
function saveUiState() {
  const inputs = new Map();
  const scrolls = new Map();
  let focusedId = '';
  let selectionStart = null;
  let selectionEnd = null;

  document.querySelectorAll('.instruction-input').forEach(el => {
    const input = /** @type {HTMLInputElement} */ (el);
    if (input.value) inputs.set(input.dataset.id ?? '', input.value);
    if (document.activeElement === input) {
      focusedId = input.dataset.id ?? '';
      selectionStart = input.selectionStart;
      selectionEnd = input.selectionEnd;
    }
  });

  document.querySelectorAll('[data-scroll-key]').forEach(el => {
    const key = /** @type {HTMLElement} */ (el).dataset.scrollKey ?? '';
    const atBottom = el.scrollHeight - el.scrollTop <= el.clientHeight + 20;
    scrolls.set(key, { top: el.scrollTop, atBottom });
  });

  return { inputs, scrolls, focusedId, selectionStart, selectionEnd };
}

/**
 * Restore input values and scroll positions after a re-render.
 * @param {{ inputs: Map<string, string>, scrolls: Map<string, {top: number, atBottom: boolean}>, focusedId: string, selectionStart: number | null, selectionEnd: number | null }} state
 */
function restoreUiState(state) {
  document.querySelectorAll('.instruction-input').forEach(el => {
    const input = /** @type {HTMLInputElement} */ (el);
    const saved = state.inputs.get(input.dataset.id ?? '');
    if (saved) input.value = saved;
  });

  document.querySelectorAll('[data-scroll-key]').forEach(el => {
    const key = /** @type {HTMLElement} */ (el).dataset.scrollKey ?? '';
    const saved = state.scrolls.get(key);
    if (!saved || saved.atBottom) {
      // New element or was already at bottom → scroll to bottom
      el.scrollTop = el.scrollHeight;
    } else {
      el.scrollTop = saved.top;
    }
  });

  if (state.focusedId) {
    const input = /** @type {HTMLInputElement | null} */ (
      document.querySelector(`.instruction-input[data-id="${state.focusedId}"]`)
    );
    if (input) {
      input.focus();
      if (typeof state.selectionStart === 'number' && typeof state.selectionEnd === 'number') {
        input.setSelectionRange(state.selectionStart, state.selectionEnd);
      }
    }
  }
}

/**
 * @param {any[]} sessions
 */
function renderSessions(sessions) {
  currentSessions = sessions;
  const list = document.getElementById('session-list');
  if (!list) return;

  const uiState = saveUiState();

  if (sessions.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        Claude Code セッションが見つかりません。<br>
        ターミナルで <code>claude</code> を起動するか、<br>
        「+」ボタンで新しいセッションを作成してください。
      </div>`;
    return;
  }

  list.innerHTML = sessions.map(session => renderSessionCard(session)).join('');

  restoreUiState(uiState);

  // ── Event listeners ──
  list.querySelectorAll('.session-header').forEach(header => {
    header.addEventListener('click', () => {
      const id = /** @type {HTMLElement} */ (header).dataset.id;
      if (!id) return;
      expandedSessions.set(id, !expandedSessions.get(id));
      renderSessions(currentSessions);
    });
  });

  list.querySelectorAll('.btn-focus').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const id = /** @type {HTMLElement} */ (btn).dataset.id;
      vscode.postMessage({ type: 'focusTerminal', sessionId: id });
    });
  });

  list.querySelectorAll('.btn-kill').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const id = /** @type {HTMLElement} */ (btn).dataset.id;
      vscode.postMessage({ type: 'killSession', sessionId: id });
    });
  });

  list.querySelectorAll('.btn-send').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const id = /** @type {HTMLElement} */ (btn).dataset.id;
      const input = /** @type {HTMLInputElement | null} */ (
        list.querySelector(`.instruction-input[data-id="${id}"]`)
      );
      if (!input || !input.value.trim()) return;
      vscode.postMessage({ type: 'sendInstruction', sessionId: id, text: input.value });
      input.value = '';
    });
  });

  list.querySelectorAll('.instruction-input').forEach(input => {
    input.addEventListener('keydown', e => {
      if (/** @type {KeyboardEvent} */ (e).key === 'Enter') {
        const id = /** @type {HTMLInputElement} */ (input).dataset.id;
        const val = /** @type {HTMLInputElement} */ (input).value.trim();
        if (!val) return;
        vscode.postMessage({ type: 'sendInstruction', sessionId: id, text: val });
        /** @type {HTMLInputElement} */ (input).value = '';
      }
    });
  });
}

/**
 * @param {any} session
 */
function renderSessionCard(session) {
  const expanded = expandedSessions.get(session.id) ?? false;
  const statusClass = session.status;
  const lastActivityStr = formatRelative(new Date(session.lastActivity));
  const cpuPct = Math.min(100, session.cpuPercent ?? 0);
  const memMB = session.memoryMB ?? 0;
  const isExternal = session.isExternal === true;

  const conversationHtml = buildConversationHtml(session.conversation ?? []);

  const focusBtn = isExternal
    ? '' // 別ウィンドウはターミナルを直接開けないので非表示
    : `<button class="btn btn-focus" data-id="${session.id}">ターミナルを開く</button>`;

  return `
    <div class="session-card ${expanded ? 'expanded' : ''}" data-id="${session.id}">
      <div class="session-header" data-id="${session.id}">
        <span class="status-dot ${statusClass}"></span>
        <span class="session-title">${escapeHtml(session.terminalName)}</span>
        ${isExternal ? '<span class="badge-external">別ウィンドウ</span>' : ''}
        <span class="session-pid">PID ${session.pid}</span>
        <span class="expand-icon">▶</span>
      </div>
      <div class="session-meta">
        <span class="meta-item" title="${escapeHtml(session.workDir)}">📁 ${escapeHtml(shortenPath(session.workDir))}</span>
        <span class="meta-item">🕐 ${lastActivityStr}</span>
        <span class="status-label status-label-${statusClass}">${statusLabel(statusClass)}</span>
      </div>
      ${focusBtn ? `<div class="session-actions">${focusBtn}</div>` : ''}
      <div class="session-detail">
        <div class="detail-section">
          <div class="detail-label">リソース</div>
          <div class="resource-row">
            <span class="resource-label">CPU</span>
            <div class="resource-bar-track">
              <div class="resource-bar-fill" style="width:${cpuPct}%;background:${cpuColor(cpuPct)}"></div>
            </div>
            <span class="resource-value">${cpuPct.toFixed(1)}%</span>
          </div>
          <div class="resource-row">
            <span class="resource-label">MEM</span>
            <div class="resource-bar-track">
              <div class="resource-bar-fill" style="width:${Math.min(100, memMB / 10)}%"></div>
            </div>
            <span class="resource-value">${memMB} MB</span>
          </div>
        </div>
        <div class="detail-section">
          <div class="detail-label">会話</div>
          <div class="conversation" data-scroll-key="conv-${session.id}">${conversationHtml}</div>
        </div>
        ${isExternal ? '' : `
        <div class="detail-section">
          <div class="detail-label">指示を送る</div>
          <div class="instruction-form">
            <input
              class="instruction-input"
              data-id="${session.id}"
              type="text"
              placeholder="Enter で送信"
            />
            <button class="btn primary btn-send" data-id="${session.id}">送信</button>
          </div>
        </div>
        `}
        <div class="detail-section detail-section-kill">
          <button class="btn danger btn-kill" data-id="${session.id}">セッションを終了 (Kill)</button>
        </div>
      </div>
    </div>`;
}

/**
 * Build readable conversation HTML from entries.
 * @param {any[]} entries
 */
function buildConversationHtml(entries) {
  if (!entries.length) {
    return '<div class="muted" style="font-size:11px">会話なし</div>';
  }
  return entries.slice(-20).map(m => {
    const roleLabel = m.role === 'user' ? 'You' : 'Claude';
    // Trim very long messages
    const text = (m.content ?? '').trim();
    const display = text.length > 500 ? text.slice(0, 500) + '…' : text;
    return `
      <div class="message ${m.role}">
        <div class="message-role">${roleLabel}</div>
        <div class="message-content">${escapeHtml(display)}</div>
      </div>`;
  }).join('');
}

/** @param {string} text */
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** @param {string} p */
function shortenPath(p) {
  if (!p) return '(不明)';
  const home = '/home/';
  if (p.startsWith(home)) {
    const rest = p.slice(home.length);
    const slash = rest.indexOf('/');
    if (slash !== -1) return '~/' + rest.slice(slash + 1);
  }
  if (p.length > 40) return '...' + p.slice(-37);
  return p;
}

/** @param {Date} d */
function formatRelative(d) {
  const diff = Date.now() - d.getTime();
  if (diff < 60000) return '今';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}分前`;
  return `${Math.floor(diff / 3600000)}時間前`;
}

/** @param {string} status */
function statusLabel(status) {
  switch (status) {
    case 'thinking':   return '考え中...';
    case 'running':    return '実行中...';
    case 'permission': return '承認待ち';
    case 'waiting':    return '入力待ち';
    case 'idle':       return 'アイドル';
    case 'stopped':    return '停止';
    default:           return status;
  }
}

/** @param {number} pct */
function cpuColor(pct) {
  if (pct > 70) return '#f44336';
  if (pct > 30) return '#ff9800';
  return '#4caf50';
}

// ── Message Handler ──
window.addEventListener('message', event => {
  const msg = event.data;
  switch (msg.type) {
    case 'update':
      renderSessions(msg.sessions);
      break;
  }
});

renderSessions([]);
