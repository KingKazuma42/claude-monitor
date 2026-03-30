// @ts-check
/// <reference lib="dom" />

const vscode = acquireVsCodeApi();

/** @type {Map<string, boolean>} */
const expandedSessions = new Map();

/** @type {any[]} */
let currentSessions = [];

/**
 * @param {any[]} sessions
 */
function renderSessions(sessions) {
  currentSessions = sessions;
  const list = document.getElementById('session-list');
  if (!list) return;

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

  // Re-attach event listeners
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

  list.querySelectorAll('.btn-send').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const id = /** @type {HTMLElement} */ (btn).dataset.id;
      const input = /** @type {HTMLInputElement | null} */ (
        document.querySelector(`.instruction-input[data-id="${id}"]`)
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

  const logHtml = (session.outputLog ?? []).slice(-50).join('\n') || '(出力なし)';

  const conversationHtml = (session.conversation ?? [])
    .slice(-10)
    .map(/** @param {any} m */ m => `
      <div class="message ${m.role}">
        <div class="message-role">${m.role === 'user' ? 'You' : 'Claude'}</div>
        <div>${escapeHtml(m.content.slice(0, 300))}</div>
      </div>
    `)
    .join('') || '<div style="color:var(--vscode-descriptionForeground);font-size:11px">会話なし</div>';

  return `
    <div class="session-card ${expanded ? 'expanded' : ''}" data-id="${session.id}">
      <div class="session-header" data-id="${session.id}">
        <span class="status-dot ${statusClass}"></span>
        <span class="session-title">${escapeHtml(session.terminalName)}</span>
        <span class="session-pid">PID ${session.pid}</span>
        <span class="expand-icon">▶</span>
      </div>
      <div class="session-meta">
        <span class="meta-item" title="作業ディレクトリ">📁 ${escapeHtml(shortenPath(session.workDir))}</span>
        <span class="meta-item">🕐 ${lastActivityStr}</span>
      </div>
      <div class="session-actions">
        <button class="btn btn-focus" data-id="${session.id}">ターミナルを開く</button>
      </div>
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
          <div class="conversation">${conversationHtml}</div>
        </div>
        <div class="detail-section">
          <div class="detail-label">出力ログ</div>
          <div class="log-output">${escapeHtml(logHtml)}</div>
        </div>
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
      </div>
    </div>`;
}

/** @param {string} text */
function escapeHtml(text) {
  return text
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

// Initial render
renderSessions([]);
