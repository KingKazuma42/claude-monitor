// @ts-check
/// <reference lib="dom" />

const vscode = acquireVsCodeApi();

/** @type {Map<string, boolean>} */
const expandedSessions = new Map();

/** @type {any[]} */
let currentSessions = [];
/** @type {any[]} */
let currentHistory = [];
let historyExpanded = false;
let dashboardExpanded = false;
let showUsageDashboard = true;
const SESSION_WINDOW_MINUTES = 5 * 60;

// ── Cron Manager State ────────────────────────────────────────────────────────
/** @type {any[]} */
let currentCronSchedules = [];
let cronOverlayVisible = false;
let cronFormVisible = false;
/** @type {string | null} */
let cronEditingId = null;

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
function renderSessions(sessions, history = []) {
  currentSessions = sessions;
  currentHistory = history;
  const list = document.getElementById('session-list');
  if (!list) return;

  const uiState = saveUiState();

  if (sessions.length === 0) {
    list.innerHTML = `
      ${showUsageDashboard ? buildUsageDashboardHtml(sessions, history) : ''}
      <div class="empty-state">
        Claude Code セッションが見つかりません。<br>
        ターミナルで <code>claude</code> を起動するか、<br>
        「+」ボタンで新しいセッションを作成してください。
      </div>`;
  } else {
    list.innerHTML = [
      showUsageDashboard ? buildUsageDashboardHtml(sessions, history) : '',
      sessions.map(session => renderSessionCard(session)).join(''),
      renderHistorySection(history),
    ].join('');
  }

  restoreUiState(uiState);

  // ── Event listeners ──
  list.querySelectorAll('.session-header').forEach(header => {
    header.addEventListener('click', () => {
      const id = /** @type {HTMLElement} */ (header).dataset.id;
      if (!id) return;
      expandedSessions.set(id, !expandedSessions.get(id));
      renderSessions(currentSessions, currentHistory);
    });
  });

  list.querySelectorAll('.history-header').forEach(header => {
    header.addEventListener('click', () => {
      historyExpanded = !historyExpanded;
      renderSessions(currentSessions, currentHistory);
    });
  });

  list.querySelectorAll('.dashboard-header').forEach(header => {
    header.addEventListener('click', () => {
      dashboardExpanded = !dashboardExpanded;
      renderSessions(currentSessions, currentHistory);
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

  list.querySelectorAll('.btn-reattach').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const id = /** @type {HTMLElement} */ (btn).dataset.id;
      vscode.postMessage({ type: 'reattachTmux', sessionId: id });
    });
  });

  list.querySelectorAll('.btn-approve, .btn-reject').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const id = /** @type {HTMLElement} */ (btn).dataset.id;
      const choice = /** @type {HTMLElement} */ (btn).dataset.choice;
      if (!id || (choice !== 'yes' && choice !== 'no')) return;
      vscode.postMessage({ type: 'approvePermission', sessionId: id, choice });
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
 * @param {any[]} sessions
 * @param {any[]} history
 */
function buildUsageDashboardHtml(sessions, history) {
  const summary = summarizeUsage(sessions, history);
  const tightest = summary.tightestSession;
  const tightestForecast = tightest ? describeSessionForecast(tightest) : null;

  return `
    <div class="dashboard-section ${dashboardExpanded ? 'expanded' : ''}">
      <div class="dashboard-header">
        <div class="dashboard-title-wrap">
          <span class="dashboard-title">Dashboard</span>
        </div>
        <span class="expand-icon">▶</span>
      </div>
      <div class="dashboard-body">
        <div class="dashboard-grid">
          <div class="dashboard-card accent-blue">
            <div class="dashboard-card-label">Active Sessions</div>
            <div class="dashboard-card-value">${summary.activeSessions}</div>
            <div class="dashboard-card-meta">稼働中 ${summary.nonStoppedSessions} / 履歴 ${history.length}</div>
          </div>
          <div class="dashboard-card accent-amber">
            <div class="dashboard-card-label">Approval / Running</div>
            <div class="dashboard-card-value">${summary.permissionSessions} / ${summary.runningSessions}</div>
            <div class="dashboard-card-meta">承認待ち / 実行中</div>
          </div>
          <div class="dashboard-card accent-green">
            <div class="dashboard-card-label">Avg Context</div>
            <div class="dashboard-card-value">${summary.averageContextPct}%</div>
            <div class="dashboard-card-meta">context データあり ${summary.sessionsWithContext} 件</div>
          </div>
          <div class="dashboard-card ${summary.tightestPct >= 90 ? 'accent-red' : 'accent-violet'}">
            <div class="dashboard-card-label">Tightest Window</div>
            <div class="dashboard-card-value">${tightest ? `${tightest.contextWindow?.pct ?? 0}%` : 'N/A'}</div>
            <div class="dashboard-card-meta">${tightest ? `${escapeHtml(tightest.terminalName)} · 残り ${formatNumber(tightest.contextWindow?.remainingTokens ?? 0)}` : 'context データなし'}</div>
          </div>
        </div>
        <div class="dashboard-panels">
          <div class="dashboard-panel">
            <div class="dashboard-panel-title">Context Overview</div>
            <div class="dashboard-meter-row">
              <div class="dashboard-meter-track">
                <div class="dashboard-meter-fill ctx-normal" style="width:${summary.averageContextPct}%"></div>
              </div>
              <div class="dashboard-meter-value">平均 ${summary.averageContextPct}%</div>
            </div>
            <div class="dashboard-stats-row">
              <span>合計使用 ${formatNumber(summary.totalUsedTokens)} tokens</span>
              <span>合計残量 ${formatNumber(summary.totalRemainingTokens)} tokens</span>
            </div>
            <div class="dashboard-stats-row subdued">
              <span>80% 以上 ${summary.highContextSessions} 件</span>
              <span>90% 以上 ${summary.criticalContextSessions} 件</span>
            </div>
          </div>
          <div class="dashboard-panel">
            <div class="dashboard-panel-title">Session Forecast</div>
            ${buildSessionForecastHtml(tightest, tightestForecast)}
          </div>
          <div class="dashboard-panel">
            <div class="dashboard-panel-title">Source Coverage</div>
            <div class="dashboard-source-pills">
              <span class="ctx-source">hook ${summary.hookSessions}</span>
              <span class="ctx-source">transcript ${summary.transcriptSessions}</span>
              <span class="ctx-source">unknown ${summary.sessionsWithoutContext}</span>
            </div>
            <div class="dashboard-stats-row subdued">
              <span>statusline 優先</span>
              <span>fallback 利用状況を確認</span>
            </div>
          </div>
          <div class="dashboard-panel">
            <div class="dashboard-panel-title">Model Mix</div>
            ${buildModelMixHtml(summary.modelDistribution)}
          </div>
        </div>
        <div class="dashboard-panel ${summary.hotSessions.length ? '' : 'dashboard-panel-empty'}">
          <div class="dashboard-panel-title">Hot Sessions</div>
          ${summary.hotSessions.length ? summary.hotSessions.map(session => renderDashboardSessionRow(session)).join('') : '<div class="dashboard-empty">高負荷セッションはありません</div>'}
        </div>
      </div>
    </div>`;
}

/**
 * @param {any} session
 */
function renderDashboardSessionRow(session) {
  const context = session.contextWindow ?? { pct: session.contextPct ?? 0 };
  const pct = Math.max(0, Math.min(100, Number(context.pct ?? 0)));
  const sourceLabel = context.source === 'statusline-hook' ? 'hook' : 'transcript';
  const forecast = describeSessionForecast(session);

  return `
    <div class="dashboard-session-row">
      <div class="dashboard-session-main">
        <div class="dashboard-session-title">${escapeHtml(session.terminalName)}</div>
        <div class="dashboard-session-meta">${statusLabel(session.status)} · ${escapeHtml(shortenPath(session.workDir))}</div>
      </div>
      <div class="dashboard-session-usage">
        <div class="dashboard-mini-track">
          <div class="dashboard-mini-fill ${pct >= 90 ? 'ctx-danger' : pct >= 80 ? 'ctx-warning' : 'ctx-normal'}" style="width:${pct}%"></div>
        </div>
        <div class="dashboard-session-values">
          <span>${pct}%</span>
          <span>${typeof context.remainingTokens === 'number' ? `残り ${formatNumber(context.remainingTokens)}` : '残量不明'}</span>
          <span class="ctx-source">${sourceLabel}</span>
          ${forecast ? `<span class="dashboard-inline-stat">${forecast.burnRateTokensPerMinute > 0 ? `${forecast.burnRateTokensPerMinute.toFixed(0)} tok/min` : '静止中'}</span>` : ''}
        </div>
      </div>
    </div>`;
}

/**
 * @param {any[]} sessions
 * @param {any[]} history
 */
function summarizeUsage(sessions, history) {
  const activeSessions = sessions.filter(session => session.isHistorical !== true);
  const nonStoppedSessions = activeSessions.filter(session => session.status !== 'stopped');
  const sessionsWithContext = activeSessions.filter(session => session.contextWindow || session.contextPct !== undefined);
  const hookSessions = activeSessions.filter(session => session.contextWindow?.source === 'statusline-hook').length;
  const transcriptSessions = activeSessions.filter(session => session.contextWindow?.source === 'transcript').length;
  const permissionSessions = nonStoppedSessions.filter(session => session.status === 'permission').length;
  const runningSessions = nonStoppedSessions.filter(session => session.status === 'running').length;
  const totalUsedTokens = sessionsWithContext.reduce((sum, session) => sum + Number(session.contextWindow?.usedTokens ?? 0), 0);
  const totalRemainingTokens = sessionsWithContext.reduce((sum, session) => sum + Number(session.contextWindow?.remainingTokens ?? 0), 0);
  const averageContextPct = sessionsWithContext.length
    ? Math.round(sessionsWithContext.reduce((sum, session) => sum + Number(session.contextWindow?.pct ?? session.contextPct ?? 0), 0) / sessionsWithContext.length)
    : 0;
  const tightestSession = [...sessionsWithContext]
    .filter(session => typeof session.contextWindow?.remainingTokens === 'number')
    .sort((left, right) => Number(left.contextWindow.remainingTokens) - Number(right.contextWindow.remainingTokens))[0];
  const tightestPct = Number(tightestSession?.contextWindow?.pct ?? tightestSession?.contextPct ?? 0);
  const highContextSessions = sessionsWithContext.filter(session => Number(session.contextWindow?.pct ?? session.contextPct ?? 0) >= 80).length;
  const criticalContextSessions = sessionsWithContext.filter(session => Number(session.contextWindow?.pct ?? session.contextPct ?? 0) >= 90).length;
  const hotSessions = [...sessionsWithContext]
    .sort((left, right) => Number(right.contextWindow?.pct ?? right.contextPct ?? 0) - Number(left.contextWindow?.pct ?? left.contextPct ?? 0))
    .slice(0, 3);
  const modelDistribution = summarizeModelDistribution(activeSessions);

  return {
    activeSessions: activeSessions.length,
    nonStoppedSessions: nonStoppedSessions.length,
    sessionsWithContext: sessionsWithContext.length,
    sessionsWithoutContext: Math.max(0, activeSessions.length - sessionsWithContext.length),
    permissionSessions,
    runningSessions,
    totalUsedTokens,
    totalRemainingTokens,
    averageContextPct,
    hookSessions,
    transcriptSessions,
    tightestSession,
    tightestPct,
    highContextSessions,
    criticalContextSessions,
    hotSessions,
    modelDistribution,
    historySessions: history.length,
  };
}

/**
 * @param {any} session
 */
function describeSessionForecast(session) {
  if (!session?.startedAt) {
    return null;
  }

  const startedAt = new Date(session.startedAt);
  if (Number.isNaN(startedAt.getTime())) {
    return null;
  }

  const elapsedMinutes = Math.max(0, (Date.now() - startedAt.getTime()) / 60000);
  const remainingSessionMinutes = Math.max(0, SESSION_WINDOW_MINUTES - elapsedMinutes);
  const sessionProgressPct = Math.min(100, Math.max(0, Math.round((elapsedMinutes / SESSION_WINDOW_MINUTES) * 100)));
  const usedTokens = Number(session.contextWindow?.usedTokens ?? 0);
  const remainingTokens = typeof session.contextWindow?.remainingTokens === 'number'
    ? Number(session.contextWindow.remainingTokens)
    : undefined;
  const burnRateTokensPerMinute = usedTokens > 0 && elapsedMinutes > 1 ? usedTokens / elapsedMinutes : 0;
  const minutesToCompact = burnRateTokensPerMinute > 0 && remainingTokens !== undefined
    ? remainingTokens / burnRateTokensPerMinute
    : undefined;

  return {
    elapsedMinutes,
    remainingSessionMinutes,
    sessionProgressPct,
    burnRateTokensPerMinute,
    minutesToCompact,
    resetAt: new Date(startedAt.getTime() + SESSION_WINDOW_MINUTES * 60000),
    compactAt: minutesToCompact !== undefined ? new Date(Date.now() + minutesToCompact * 60000) : undefined,
    willCompactBeforeReset: minutesToCompact !== undefined && minutesToCompact < remainingSessionMinutes,
  };
}

/**
 * @param {any | undefined} session
 * @param {ReturnType<typeof describeSessionForecast> | null} forecast
 */
function buildSessionForecastHtml(session, forecast) {
  if (!session || !forecast) {
    return '<div class="dashboard-empty">予測に必要なセッションデータがありません</div>';
  }

  return `
    <div class="dashboard-stats-row">
      <span>${escapeHtml(session.terminalName)}</span>
      <span>${formatDuration(forecast.remainingSessionMinutes)} で reset</span>
    </div>
    <div class="dashboard-meter-row">
      <div class="dashboard-meter-track">
        <div class="dashboard-meter-fill ctx-warning" style="width:${forecast.sessionProgressPct}%"></div>
      </div>
      <div class="dashboard-meter-value">${forecast.sessionProgressPct}%</div>
    </div>
    <div class="dashboard-stats-row subdued">
      <span>Burn Rate ${forecast.burnRateTokensPerMinute > 0 ? `${forecast.burnRateTokensPerMinute.toFixed(1)} tok/min` : '0 tok/min'}</span>
      <span>Reset ${formatClock(forecast.resetAt)}</span>
    </div>
    <div class="dashboard-prediction ${forecast.willCompactBeforeReset ? 'danger' : 'safe'}">
      ${forecast.minutesToCompact !== undefined
        ? (forecast.willCompactBeforeReset
          ? `このペースなら ${formatDuration(forecast.minutesToCompact)} で compact 到達見込み`
          : `現在ペースでは reset が先です (${formatClock(forecast.resetAt)})`)
        : 'compact 予測に十分な履歴がありません'}
    </div>`;
}

/**
 * @param {{ segments: Array<{ label: string, pct: number, tokens: number, className: string }>, unknownCount: number }} distribution
 */
function buildModelMixHtml(distribution) {
  if (!distribution.segments.length) {
    return '<div class="dashboard-empty">model 情報がまだありません</div>';
  }

  return `
    <div class="dashboard-model-track">
      ${distribution.segments.map(segment => `<div class="dashboard-model-fill ${segment.className}" style="width:${segment.pct}%"></div>`).join('')}
    </div>
    <div class="dashboard-model-legend">
      ${distribution.segments.map(segment => `<span class="dashboard-model-pill ${segment.className}">${segment.label} ${segment.pct}%</span>`).join('')}
      ${distribution.unknownCount > 0 ? `<span class="dashboard-inline-stat">unknown ${distribution.unknownCount}</span>` : ''}
    </div>`;
}

/**
 * @param {any[]} sessions
 */
function summarizeModelDistribution(sessions) {
  const buckets = new Map([
    ['Sonnet', 0],
    ['Opus', 0],
    ['Haiku', 0],
    ['Other', 0],
  ]);
  let unknownCount = 0;

  sessions.forEach(session => {
    const modelId = String(session.contextWindow?.modelId ?? '').toLowerCase();
    const weight = Number(session.contextWindow?.usedTokens ?? 0);
    if (!modelId) {
      unknownCount += 1;
      return;
    }

    if (modelId.includes('sonnet')) {
      buckets.set('Sonnet', Number(buckets.get('Sonnet')) + weight);
    } else if (modelId.includes('opus')) {
      buckets.set('Opus', Number(buckets.get('Opus')) + weight);
    } else if (modelId.includes('haiku')) {
      buckets.set('Haiku', Number(buckets.get('Haiku')) + weight);
    } else {
      buckets.set('Other', Number(buckets.get('Other')) + weight);
    }
  });

  const total = Array.from(buckets.values()).reduce((sum, value) => sum + Number(value), 0);
  const classByLabel = {
    Sonnet: 'model-sonnet',
    Opus: 'model-opus',
    Haiku: 'model-haiku',
    Other: 'model-other',
  };

  const segments = Array.from(buckets.entries())
    .filter(([, tokens]) => Number(tokens) > 0)
    .map(([label, tokens]) => ({
      label,
      tokens: Number(tokens),
      pct: total > 0 ? Math.round((Number(tokens) / total) * 100) : 0,
      className: classByLabel[label],
    }));

  return { segments, unknownCount };
}

/** @param {number} minutes */
function formatDuration(minutes) {
  const safeMinutes = Math.max(0, Math.round(minutes));
  const hours = Math.floor(safeMinutes / 60);
  const mins = safeMinutes % 60;
  if (hours <= 0) {
    return `${mins}分`;
  }
  return `${hours}時間${mins}分`;
}

/** @param {Date | undefined} date */
function formatClock(date) {
  if (!date || Number.isNaN(date.getTime())) {
    return '--:--';
  }
  return date.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
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
  const isHistorical = session.isHistorical === true;
  const isTmux = !!session.tmuxSessionName;
  const isDetachedTmux = isExternal && isTmux;
  const isOtherWindow = isExternal && !isTmux;
  const stoppedAtStr = session.stoppedAt ? formatRelative(new Date(session.stoppedAt)) : '';

  const conversationHtml = buildConversationHtml(session.conversation ?? []);

  // Reattach button for detached tmux sessions; normal focus button for local sessions.
  // Sessions in other windows have no direct terminal access button.
  const focusBtn = isHistorical
    ? ''
    : isDetachedTmux
      ? `<button class="btn btn-reattach" data-id="${session.id}">Reattach</button>`
      : isOtherWindow
        ? ''
        : `<button class="btn btn-focus" data-id="${session.id}">ターミナルを開く</button>`;
  const approvalActions = '';

  return `
    <div class="session-card ${expanded ? 'expanded' : ''} ${isHistorical ? 'historical' : ''}" data-id="${session.id}">
      <div class="session-header" data-id="${session.id}">
        <span class="status-dot ${statusClass}"></span>
        <span class="session-title">${escapeHtml(session.terminalName)}</span>
        ${isTmux ? `<span class="badge-tmux">${isDetachedTmux ? 'tmux: デタッチ中' : 'tmux'}</span>` : ''}
        ${isOtherWindow ? '<span class="badge-external">別ウィンドウ</span>' : ''}
        ${isHistorical ? '<span class="badge-history">履歴</span>' : ''}
        <span class="session-pid">PID ${session.pid}</span>
        <span class="expand-icon">▶</span>
      </div>
      <div class="session-meta">
        <span class="meta-item" title="${escapeHtml(session.workDir)}">📁 ${escapeHtml(shortenPath(session.workDir))}</span>
        <span class="meta-item">🕐 ${lastActivityStr}</span>
        ${stoppedAtStr ? `<span class="meta-item">⏹ ${stoppedAtStr} に停止</span>` : ''}
        <span class="status-label status-label-${statusClass}">${statusLabel(statusClass)}</span>
      </div>
      ${session.contextWindow ? buildContextBarHtml(session.contextWindow) : ((session.contextPct !== undefined && session.contextPct !== null) ? buildContextBarHtml({ pct: session.contextPct }) : '')}
      ${approvalActions}
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
              <div class="resource-bar-fill" style="width:${Math.min(100, memMB / 10)}%;background:${memColor(memMB)}"></div>
            </div>
            <span class="resource-value">${memMB} MB</span>
          </div>
        </div>
        <div class="detail-section">
          <div class="detail-label">会話</div>
          <div class="conversation" data-scroll-key="conv-${session.id}">${conversationHtml}</div>
        </div>
        ${isExternal || isHistorical || isDetachedTmux ? '' : `
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
        <div class="detail-section detail-section-kill ${isHistorical ? 'hidden-section' : ''}">
          <button class="btn danger btn-kill" data-id="${session.id}">セッションを終了 (Kill)</button>
        </div>
      </div>
    </div>`;
}

/**
 * @param {any[]} history
 */
function renderHistorySection(history) {
  if (!history.length) {
    return '';
  }

  return `
    <div class="history-section ${historyExpanded ? 'expanded' : ''}">
      <div class="history-header">
        <span class="history-title">過去のセッション (${history.length})</span>
        <span class="expand-icon">▶</span>
      </div>
      <div class="history-body">
        ${history.map(session => renderSessionCard(session)).join('')}
      </div>
    </div>`;
}

/**
 * Build context window progress bar and warning HTML.
 * @param {{ pct?: number, usedTokens?: number, limitTokens?: number, remainingTokens?: number, source?: string }} context
 */
function buildContextBarHtml(context) {
  const pct = Math.max(0, Math.min(100, Number(context.pct ?? 0)));
  const colorClass = pct >= 90 ? 'ctx-danger'
                   : pct >= 80 ? 'ctx-warning'
                   : 'ctx-normal';
  const detailHtml = buildContextDetailHtml(context, colorClass);
  const warningHtml = buildContextWarningHtml(pct, context.remainingTokens);
  return `
    <div class="session-ctx">
      <div class="ctx-bar-track">
        <div class="ctx-bar-fill ${colorClass}" style="width:${pct}%"></div>
      </div>
      <span class="ctx-pct ${colorClass}">${pct}%</span>
    </div>
    ${detailHtml}
    ${warningHtml}`;
}

/**
 * @param {{ usedTokens?: number, limitTokens?: number, remainingTokens?: number, source?: string }} context
 * @param {string} colorClass
 */
function buildContextDetailHtml(context, colorClass) {
  if (typeof context.usedTokens !== 'number' || typeof context.limitTokens !== 'number') {
    return '';
  }

  const remainingTokens = typeof context.remainingTokens === 'number'
    ? context.remainingTokens
    : Math.max(0, context.limitTokens - context.usedTokens);
  const sourceLabel = context.source === 'statusline-hook' ? 'hook' : 'transcript';

  return `
    <div class="ctx-meta">
      <span class="ctx-detail ${colorClass}">${formatNumber(context.usedTokens)} / ${formatNumber(context.limitTokens)}</span>
      <span class="ctx-detail">残り ${formatNumber(remainingTokens)} tokens</span>
      <span class="ctx-source">${sourceLabel}</span>
    </div>`;
}

/**
 * Build a warning message when the context window is close to auto-compact.
 * @param {number} pct - usage percentage 0-100
 * @param {number | undefined} remainingTokens
 */
function buildContextWarningHtml(pct, remainingTokens) {
  if (pct < 80) {
    return '';
  }

  const warningClass = pct >= 90 ? 'ctx-alert-danger' : 'ctx-alert-warning';
  const remainingText = typeof remainingTokens === 'number'
    ? ` 残り ${formatNumber(Math.max(0, remainingTokens))} tokens です。`
    : '';
  const message = pct >= 90
    ? `コンテキスト使用率がかなり高いです。auto-compact が近いため、早めに会話を整理してください。${remainingText}`
    : `コンテキスト使用率が 80% を超えました。auto-compact 前に会話を整理することを推奨します。${remainingText}`;

  return `<div class="ctx-alert ${warningClass}">${message}</div>`;
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
  const homeMatch = p.match(/^(?:\/home\/[^/]+|\/Users\/[^/]+|\/root)(\/.*)?$/);
  if (homeMatch) {
    return `~${homeMatch[1] ?? ''}`;
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

/** @param {number} value */
function formatNumber(value) {
  return Math.round(value).toLocaleString('ja-JP');
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

/** @param {number} memMB */
function memColor(memMB) {
  if (memMB > 2048) return '#f44336';
  if (memMB > 512) return '#ff9800';
  return '#0e70c0';
}

// ── Cron Manager ─────────────────────────────────────────────────────────────

function openCronOverlay() {
  cronOverlayVisible = true;
  cronFormVisible = false;
  cronEditingId = null;
  vscode.postMessage({ type: 'getCronSchedules' });
  renderCronOverlay();
  const overlay = document.getElementById('cron-overlay');
  if (overlay) overlay.style.display = 'flex';
}

function closeCronOverlay() {
  cronOverlayVisible = false;
  cronFormVisible = false;
  cronEditingId = null;
  const overlay = document.getElementById('cron-overlay');
  if (overlay) overlay.style.display = 'none';
}

function renderCronOverlay() {
  const overlay = document.getElementById('cron-overlay');
  if (!overlay) return;

  overlay.innerHTML = `
    <div class="cron-header">
      <span class="cron-title">⏰ スケジュール管理</span>
      <div class="cron-header-actions">
        ${!cronFormVisible ? '<button class="btn primary btn-cron-add">＋ 追加</button>' : ''}
        <button class="btn btn-icon btn-cron-close" title="パネルに戻る" aria-label="パネルに戻る">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
               fill="none" stroke="currentColor" stroke-width="2.5"
               stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <line x1="19" y1="12" x2="5" y2="12"/>
            <polyline points="12 19 5 12 12 5"/>
          </svg>
        </button>
      </div>
    </div>
    <div class="cron-body">
      ${cronFormVisible ? buildCronFormHtml() : buildCronListHtml()}
    </div>`;

  bindCronOverlayEvents(overlay);
}

/** @param {HTMLElement} overlay */
function bindCronOverlayEvents(overlay) {
  overlay.querySelector('.btn-cron-close')
    ?.addEventListener('click', () => closeCronOverlay());

  if (!cronFormVisible) {
    overlay.querySelector('.btn-cron-add')?.addEventListener('click', () => {
      cronFormVisible = true;
      cronEditingId = null;
      renderCronOverlay();
    });

    overlay.querySelectorAll('.btn-cron-edit').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        cronEditingId = /** @type {HTMLElement} */ (btn).dataset.id ?? null;
        cronFormVisible = true;
        renderCronOverlay();
      });
    });

    overlay.querySelectorAll('.btn-cron-delete').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const id = /** @type {HTMLElement} */ (btn).dataset.id;
        if (!id) return;
        vscode.postMessage({ type: 'deleteCronSchedule', scheduleId: id });
      });
    });

    overlay.querySelectorAll('.cron-toggle-input').forEach(input => {
      input.addEventListener('change', () => {
        const id = /** @type {HTMLInputElement} */ (input).dataset.id;
        const sched = currentCronSchedules.find(s => s.id === id);
        if (!sched) return;
        vscode.postMessage({
          type: 'updateCronSchedule',
          schedule: { ...sched, enabled: /** @type {HTMLInputElement} */ (input).checked },
        });
      });
    });

  } else {
    // ── Form events ──
    overlay.querySelector('.btn-cron-cancel')?.addEventListener('click', () => {
      cronFormVisible = false;
      cronEditingId = null;
      renderCronOverlay();
    });

    overlay.querySelector('.btn-cron-save')?.addEventListener('click', () => {
      submitCronForm(overlay);
    });

    // Type radio toggle
    overlay.querySelectorAll('input[name="cron-type"]').forEach(radio => {
      radio.addEventListener('change', () => {
        const r = /** @type {HTMLInputElement} */ (radio);
        const intervalFields = overlay.querySelector('#cron-interval-fields');
        const dailyFields = overlay.querySelector('#cron-daily-fields');
        if (!intervalFields || !dailyFields) return;
        if (r.value === 'interval' && r.checked) {
          intervalFields.classList.remove('hidden');
          dailyFields.classList.add('hidden');
        } else if (r.value === 'daily' && r.checked) {
          intervalFields.classList.add('hidden');
          dailyFields.classList.remove('hidden');
        }
      });
    });

    // Target radio toggle
    overlay.querySelectorAll('input[name="cron-target"]').forEach(radio => {
      radio.addEventListener('change', () => {
        const r = /** @type {HTMLInputElement} */ (radio);
        const picker = overlay.querySelector('#cron-target-picker');
        if (!picker) return;
        if (r.value === 'specific' && r.checked) {
          picker.classList.remove('hidden');
          // Auto-select the first real session if nothing is chosen yet
          const sel = /** @type {HTMLSelectElement | null} */(overlay.querySelector('#cron-form-target'));
          if (sel) {
            if (!sel.value) {
              const first = Array.from(sel.options).find(o => o.value !== '');
              if (first) sel.value = first.value;
            }
            sel.style.outline = ''; // clear any previous error state
          }
        } else if (r.value === 'all' && r.checked) {
          picker.classList.add('hidden');
        }
      });
    });

    // Preset chips
    overlay.querySelectorAll('.cron-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const minutes = /** @type {HTMLElement} */ (chip).dataset.minutes;
        const minutesInput = /** @type {HTMLInputElement | null} */ (
          overlay.querySelector('#cron-form-minutes')
        );
        if (minutesInput && minutes) minutesInput.value = minutes;
      });
    });
  }
}

function buildCronListHtml() {
  if (currentCronSchedules.length === 0) {
    return `
      <div class="cron-empty">
        <p>スケジュールはまだありません。</p>
        <p>「＋ 追加」でスケジュールを作成してください。</p>
      </div>`;
  }
  return `<div class="cron-items">
    ${currentCronSchedules.map(sched => buildCronItemHtml(sched)).join('')}
  </div>`;
}

/** @param {any} sched */
function buildCronItemHtml(sched) {
  const specLabel = formatScheduleSpecJs(sched.spec);
  const lastFiredLabel = formatLastFired(sched.lastFiredAt);
  const instruction = (sched.instruction ?? '').trim();
  const displayInstruction = instruction.length > 60
    ? instruction.slice(0, 60) + '…'
    : instruction;

  const targetLabel = sched.targetWorkDir
    ? `📁 ${shortenPath(sched.targetWorkDir)}`
    : '📢 全セッション';

  return `
    <div class="cron-item ${sched.enabled ? '' : 'cron-item-disabled'}">
      <label class="cron-toggle" title="${sched.enabled ? '無効にする' : '有効にする'}">
        <input type="checkbox" class="cron-toggle-input"
               data-id="${escapeHtml(sched.id)}" ${sched.enabled ? 'checked' : ''}>
        <span class="cron-toggle-thumb"></span>
      </label>
      <div class="cron-item-body">
        <div class="cron-item-label">${escapeHtml(sched.label || '(無題)')}</div>
        <div class="cron-item-meta">${escapeHtml(specLabel)} · ${escapeHtml(targetLabel)} · ${escapeHtml(lastFiredLabel)}</div>
        ${displayInstruction
          ? `<div class="cron-item-instruction">${escapeHtml(displayInstruction)}</div>`
          : ''}
      </div>
      <div class="cron-item-actions">
        <button class="btn btn-cron-edit" data-id="${escapeHtml(sched.id)}">編集</button>
        <button class="btn danger btn-cron-delete" data-id="${escapeHtml(sched.id)}">削除</button>
      </div>
    </div>`;
}

function buildCronFormHtml() {
  const sched = cronEditingId
    ? currentCronSchedules.find(s => s.id === cronEditingId)
    : null;

  const isInterval      = !sched || sched.spec?.type === 'interval';
  const label           = escapeHtml(sched?.label ?? '');
  const instruction     = escapeHtml(sched?.instruction ?? '');
  const minutes         = sched?.spec?.type === 'interval' ? (sched.spec.minutes ?? 30) : 30;
  const hour            = sched?.spec?.type === 'daily'    ? (sched.spec.hour ?? 9)     : 9;
  const minute          = sched?.spec?.type === 'daily'    ? (sched.spec.minute ?? 0)   : 0;
  const paddedMin       = String(minute).padStart(2, '0');
  const targetSessionId   = sched?.targetSessionId ?? '';
  const targetWorkDir     = sched?.targetWorkDir ?? '';
  // A schedule targets a specific session when either id or workDir is recorded
  const hasSpecificTarget = Boolean(targetSessionId || targetWorkDir);
  const formTitle       = sched ? 'スケジュールを編集' : 'スケジュールを追加';
  const saveLabel       = sched ? '更新' : '追加';

  // Active (non-stopped) sessions for the target picker.
  // Option value is the session id (unique per process) so two sessions in the
  // same workDir are always distinguishable.
  const activeSessions = currentSessions.filter(s => s.status !== 'stopped');

  const sessionOptions = activeSessions.map(s => {
    // Prefer matching by targetSessionId; fall back to workDir for legacy schedules
    const isSelected = targetSessionId ? s.id === targetSessionId : s.workDir === targetWorkDir;
    const selected   = isSelected ? 'selected' : '';
    const display    = `${escapeHtml(s.terminalName)}  ${escapeHtml(shortenPath(s.workDir))}`;
    return `<option value="${escapeHtml(s.id)}" ${selected}>${display}</option>`;
  }).join('');

  const targetPickerHtml = activeSessions.length > 0
    ? `<select id="cron-form-target" class="cron-input">
         <option value="" ${!hasSpecificTarget ? 'selected' : ''}>(セッションを選択)</option>
         ${sessionOptions}
       </select>`
    : `<div class="cron-target-empty">現在実行中のセッションがありません</div>`;

  return `
    <div class="cron-form">
      <div class="cron-form-title">${formTitle}</div>

      <div class="cron-form-row">
        <div class="cron-form-label">ラベル</div>
        <input id="cron-form-label" class="cron-input" type="text"
               value="${label}" placeholder="例: 進捗確認、朝のチェック">
      </div>

      <div class="cron-form-row">
        <div class="cron-form-label">タイミング</div>
        <div class="cron-type-row">
          <label class="cron-radio-label">
            <input type="radio" name="cron-type" value="interval" ${isInterval ? 'checked' : ''}>
            毎N分
          </label>
          <label class="cron-radio-label">
            <input type="radio" name="cron-type" value="daily" ${!isInterval ? 'checked' : ''}>
            毎日
          </label>
        </div>
      </div>

      <div id="cron-interval-fields" class="cron-form-row ${isInterval ? '' : 'hidden'}">
        <div class="cron-form-label">間隔</div>
        <div class="cron-interval-row">
          <input id="cron-form-minutes" class="cron-input cron-input-num"
                 type="number" min="1" max="1440" value="${minutes}">
          <span class="cron-unit">分ごと</span>
        </div>
        <div class="cron-preset-chips">
          <button class="cron-chip" data-minutes="15">15分</button>
          <button class="cron-chip" data-minutes="30">30分</button>
          <button class="cron-chip" data-minutes="60">1時間</button>
          <button class="cron-chip" data-minutes="120">2時間</button>
          <button class="cron-chip" data-minutes="240">4時間</button>
        </div>
      </div>

      <div id="cron-daily-fields" class="cron-form-row ${!isInterval ? '' : 'hidden'}">
        <div class="cron-form-label">時刻</div>
        <div class="cron-time-row">
          <input id="cron-form-hour" class="cron-input cron-input-num"
                 type="number" min="0" max="23" value="${hour}">
          <span class="cron-unit">:</span>
          <input id="cron-form-minute-val" class="cron-input cron-input-num"
                 type="number" min="0" max="59" step="5" value="${paddedMin}">
        </div>
      </div>

      <div class="cron-form-row">
        <div class="cron-form-label">指示テキスト</div>
        <textarea id="cron-form-instruction" class="cron-textarea" rows="3"
                  placeholder="Claude に送る指示を入力してください">${instruction}</textarea>
      </div>

      <div class="cron-form-row">
        <div class="cron-form-label">送信先</div>
        <div class="cron-type-row">
          <label class="cron-radio-label">
            <input type="radio" name="cron-target" value="all"
                   ${!hasSpecificTarget ? 'checked' : ''}>
            全セッション
          </label>
          <label class="cron-radio-label">
            <input type="radio" name="cron-target" value="specific"
                   ${hasSpecificTarget ? 'checked' : ''}>
            指定のセッション
          </label>
        </div>
        <div id="cron-target-picker" class="${hasSpecificTarget ? '' : 'hidden'}">
          ${targetPickerHtml}
        </div>
      </div>

      <div class="cron-form-actions">
        <button class="btn btn-cron-cancel">キャンセル</button>
        <button class="btn primary btn-cron-save">${saveLabel}</button>
      </div>
    </div>`;
}

/** @param {HTMLElement} overlay */
function submitCronForm(overlay) {
  const labelInput       = /** @type {HTMLInputElement | null} */  (overlay.querySelector('#cron-form-label'));
  const instructionInput = /** @type {HTMLTextAreaElement | null} */(overlay.querySelector('#cron-form-instruction'));
  const typeRadio        = /** @type {HTMLInputElement | null} */  (overlay.querySelector('input[name="cron-type"]:checked'));

  const label       = (labelInput?.value ?? '').trim();
  const instruction = (instructionInput?.value ?? '').trim();
  const type        = typeRadio?.value ?? 'interval';

  if (!label) {
    labelInput?.focus();
    return;
  }
  if (!instruction) {
    instructionInput?.focus();
    return;
  }

  /** @type {any} */
  let spec;
  if (type === 'interval') {
    const minutesInput = /** @type {HTMLInputElement | null} */(overlay.querySelector('#cron-form-minutes'));
    const minutes = parseInt(minutesInput?.value ?? '30', 10);
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440) {
      minutesInput?.focus();
      return;
    }
    spec = { type: 'interval', minutes };
  } else {
    const hourInput   = /** @type {HTMLInputElement | null} */(overlay.querySelector('#cron-form-hour'));
    const minuteInput = /** @type {HTMLInputElement | null} */(overlay.querySelector('#cron-form-minute-val'));
    const hour   = parseInt(hourInput?.value   ?? '9', 10);
    const minute = parseInt(minuteInput?.value ?? '0', 10);
    if (!Number.isFinite(hour)   || hour   < 0 || hour   > 23) { hourInput?.focus();   return; }
    if (!Number.isFinite(minute) || minute < 0 || minute > 59) { minuteInput?.focus(); return; }
    spec = { type: 'daily', hour, minute };
  }

  // Resolve target session: option value is now a session id (e.g. "claude-12345").
  // We also record the workDir at save time so the schedule can fall back to a
  // workDir match if the original session is restarted and gets a new id.
  const targetRadio  = /** @type {HTMLInputElement | null} */(overlay.querySelector('input[name="cron-target"]:checked'));
  const targetSelect = /** @type {HTMLSelectElement | null} */(overlay.querySelector('#cron-form-target'));
  const useSpecific  = targetRadio?.value === 'specific';
  const rawTargetSessionId = targetSelect?.value ?? '';

  // Guard: "指定のセッション" selected but no session chosen
  if (useSpecific && !rawTargetSessionId) {
    if (targetSelect) {
      targetSelect.style.outline = '2px solid var(--vscode-inputValidation-errorBorder, #f48771)';
      targetSelect.focus();
    }
    return;
  }

  // Look up the session to get its workDir (stable across restarts, used as fallback)
  const targetSession   = useSpecific ? currentSessions.find(s => s.id === rawTargetSessionId) : undefined;
  const targetSessionId = useSpecific ? rawTargetSessionId : undefined;
  const targetWorkDir   = useSpecific ? (targetSession?.workDir ?? undefined) : undefined;

  if (cronEditingId) {
    const existing = currentCronSchedules.find(s => s.id === cronEditingId);
    if (!existing) return;
    vscode.postMessage({
      type: 'updateCronSchedule',
      schedule: { ...existing, label, spec, instruction, targetSessionId, targetWorkDir },
    });
  } else {
    vscode.postMessage({
      type: 'addCronSchedule',
      schedule: {
        id: '',  // generated by extension
        label,
        spec,
        instruction,
        enabled: true,
        createdAt: new Date().toISOString(),
        targetSessionId,
        targetWorkDir,
      },
    });
  }

  cronFormVisible = false;
  cronEditingId = null;
  // Overlay will refresh when 'cronSchedules' arrives from the extension
}

/** @param {any} spec */
function formatScheduleSpecJs(spec) {
  if (!spec) return '不明';
  if (spec.type === 'interval') {
    const m = spec.minutes;
    if (m < 60)  return `毎 ${m} 分`;
    const h = Math.floor(m / 60);
    const r = m % 60;
    return r === 0 ? `毎 ${h} 時間` : `毎 ${h} 時間 ${r} 分`;
  }
  if (spec.type === 'daily') {
    const hh = String(spec.hour).padStart(2, '0');
    const mm = String(spec.minute).padStart(2, '0');
    return `毎日 ${hh}:${mm}`;
  }
  return '不明';
}

/** @param {string | undefined} isoString */
function formatLastFired(isoString) {
  if (!isoString) return '未発火';
  const diff = Date.now() - new Date(isoString).getTime();
  if (diff < 60_000)       return 'たった今';
  if (diff < 3_600_000)    return `${Math.floor(diff / 60_000)} 分前`;
  if (diff < 86_400_000)   return `${Math.floor(diff / 3_600_000)} 時間前`;
  return `${Math.floor(diff / 86_400_000)} 日前`;
}

// ── Message Handler ──
window.addEventListener('message', event => {
  const msg = event.data;
  switch (msg.type) {
    case 'update':
      showUsageDashboard = msg.showUsageDashboard !== false;
      renderSessions(msg.sessions, msg.history ?? []);
      break;

    case 'openCronManager':
      openCronOverlay();
      break;

    case 'cronSchedules': {
      currentCronSchedules = msg.schedules ?? [];
      if (cronOverlayVisible) renderCronOverlay();
      break;
    }

    case 'cronFired': {
      // Update lastFiredAt locally so the list reflects the change immediately
      const idx = currentCronSchedules.findIndex(s => s.id === msg.scheduleId);
      if (idx !== -1) {
        currentCronSchedules = currentCronSchedules.slice();
        currentCronSchedules[idx] = {
          ...currentCronSchedules[idx],
          lastFiredAt: new Date().toISOString(),
        };
      }
      if (cronOverlayVisible) renderCronOverlay();
      break;
    }
  }
});

renderSessions([], []);
vscode.postMessage({ type: 'ready' });
