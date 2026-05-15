const params = new URL(window.location.href).searchParams;
const API    = params.get('api') || 'https://api.frc5572.org';

let token = null;
let jwt   = null;
let popupWindow = null;

let allIssues        = [];
let allUsers         = [];   // [{email, name}]
let currentUserEmail = null;
let isAdmin          = false;
let canDelete        = false;
let activeScope      = 'mine'; // 'mine' | 'all' | 'assignees'
let activeType       = '';     // '' | '3d_print' | 'cnc' | 'manual_cut'
let openIssueId      = null;
const collapsedSections = new Set(); // non-empty sections explicitly collapsed
const expandedSections  = new Set(); // empty sections explicitly expanded

function isSectionCollapsed(key, hasIssues) {
  if (collapsedSections.has(key)) return true;
  if (!hasIssues && !expandedSections.has(key)) return true;
  return false;
}

// ---- Stage / type metadata -----------------------------------------------

const TYPE_STAGES = {
  '3d_print':   ['ready_for_slicing', 'ready_for_printing', 'printing', 'complete'],
  'cnc':        ['ready_for_cam', 'ready_for_machining', 'machining', 'complete'],
  'manual_cut': ['ready_for_cutting', 'cutting', 'complete'],
};

const STAGE_LABEL = {
  ready_for_slicing:   'Ready for Slicing',
  ready_for_printing:  'Ready for Printing',
  printing:            'Printing',
  ready_for_cam:       'Ready for CAM',
  ready_for_machining: 'Ready for Machining',
  machining:           'Machining',
  ready_for_cutting:   'Ready for Cutting',
  cutting:             'Cutting',
  complete:            'Complete',
  redesign:            'Redesign',
};

const TYPE_LABEL = {
  '3d_print':   '3D Print',
  'cnc':        'CNC',
  'manual_cut': 'Manual Cut',
};

// Canonical order for "All" view - only non-empty stages are shown.
const ALL_STAGE_ORDER = [
  'ready_for_slicing', 'ready_for_cam', 'ready_for_cutting',
  'ready_for_printing', 'ready_for_machining',
  'printing', 'machining', 'cutting',
  'complete', 'redesign',
];

function visibleIssues() {
  const scoped = activeScope === 'mine' && currentUserEmail
    ? allIssues.filter(i =>
        i.assignees.includes(currentUserEmail) ||
        i.reviewers.includes(currentUserEmail))
    : allIssues; // 'all' and 'assignees' both show everything
  return activeType ? scoped.filter(i => i.manufacturing_type === activeType) : scoped;
}

function stagesFor(issues) {
  if (activeType) return TYPE_STAGES[activeType] ?? [];
  const present = new Set(issues.map(i => i.stage));
  return ALL_STAGE_ORDER.filter(s => present.has(s));
}

function nextStage(issue) {
  const stages = TYPE_STAGES[issue.manufacturing_type] ?? [];
  const idx = stages.indexOf(issue.stage);
  return idx >= 0 && idx < stages.length - 1 ? stages[idx + 1] : null;
}

// ---- Auth ----------------------------------------------------------------

async function login(res) {
  token = res.token;
  currentUserEmail = res.user_info.email;
  isAdmin      = !!(res.user_info.data?.permissions?.admin);
  canDelete    = !!(res.user_info.data?.permissions?.delete_parts) || isAdmin;
  document.getElementById('user-avatar').src = `${API}/avatars/${encodeURIComponent(res.user_info.email)}`;
  document.getElementById('user-name').textContent = res.user_info.data.name;
  document.getElementById('login-page').classList.add('hidden');
  document.getElementById('main').classList.remove('hidden');
  await Promise.all([loadIssues(), loadUsers()]);
}

async function loadUsers() {
  try {
    const resp = await fetch(`${API}/users`, { headers: { Authorization: `Bearer ${token}` } });
    if (resp.ok) allUsers = await resp.json();
  } catch {}
}

function userName(email) {
  const u = allUsers.find(u => u.email === email);
  return u ? u.name : email.split('@')[0];
}

function userAvatar(email, size = 22) {
  const u = allUsers.find(u => u.email === email);
  const label = esc(u?.name || email);
  if (u) {
    return `<img class="assignee-chip" src="${API}/avatars/${encodeURIComponent(u.email)}" title="${label}"
              style="width:${size}px;height:${size}px;border-radius:50%;object-fit:cover;display:inline-block;">`;
  }
  const initials = (u?.name || email.split('@')[0]).slice(0, 2).toUpperCase();
  return `<div class="assignee-chip" title="${label}">${initials}</div>`;
}

// ---- Data ----------------------------------------------------------------

async function loadIssues() {
  const resp = await fetch(`${API}/parts`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) return;
  allIssues = await resp.json();
  renderBoard();
  if (openIssueId) {
    const fresh = allIssues.find(i => i.id === openIssueId);
    if (fresh) renderPanel(fresh);
  }
}

// ---- Board ---------------------------------------------------------------

function renderBoard() {
  const board = document.getElementById('board');
  if (activeScope === 'assignees') {
    board.classList.add('board--assignees');
    renderAssigneeView();
  } else {
    board.classList.remove('board--assignees');
    renderBoardView();
  }
}

function renderBoardView() {
  const issues  = visibleIssues();
  const stages  = stagesFor(issues);
  const byStage = Object.fromEntries(stages.map(s => [s, []]));
  for (const issue of issues) {
    if (byStage[issue.stage] !== undefined) byStage[issue.stage].push(issue);
  }

  if (stages.length === 0) {
    document.getElementById('board').innerHTML =
      `<p style="color:var(--muted);padding:32px;font-size:14px">No issues assigned to you.</p>`;
    return;
  }

  document.getElementById('board').innerHTML = stages.map(stage => `
    <div class="col">
      <div class="col-header">
        <span class="col-title">${STAGE_LABEL[stage] ?? stage}</span>
        <span class="col-count">${byStage[stage].length}</span>
      </div>
      <div class="col-cards">
        ${byStage[stage].map(i => renderCard(i)).join('')}
      </div>
    </div>
  `).join('');

  document.querySelectorAll('.issue-card').forEach(el => {
    el.addEventListener('click', () => openPanel(el.dataset.id));
  });
}

// ---- Assignee view -------------------------------------------------------

function renderAssigneeView() {
  const issues = visibleIssues().filter(i => i.stage !== 'complete' && i.stage !== 'redesign');

  // Group: issues with no assignees go to 'open'; others appear once per assignee.
  const byEmail = new Map();
  const unassigned = [];
  for (const issue of issues) {
    if (issue.assignees.length === 0) {
      unassigned.push(issue);
    } else {
      for (const email of issue.assignees) {
        if (!byEmail.has(email)) byEmail.set(email, []);
        byEmail.get(email).push(issue);
      }
    }
  }

  const sortedEmails = allUsers
    .map(u => u.email)
    .sort((a, b) => userName(a).localeCompare(userName(b)));

  document.getElementById('board').innerHTML = [
    avSection('', 'Open', unassigned),
    ...sortedEmails.map(email => avSection(email, userName(email), byEmail.get(email) ?? [])),
  ].join('');

  wireAssigneeView();
}

function avSection(email, label, issues) {
  const key = email || 'open';
  const hasIssues = issues.length > 0;
  const isCollapsed = isSectionCollapsed(key, hasIssues);
  const avatarHtml = email
    ? `<img class="av-avatar" src="${API}/avatars/${encodeURIComponent(email)}" alt=""
           onerror="this.style.display='none'">`
    : `<span class="av-icon">📋</span>`;

  const cardHtml = issues.length
    ? issues.map(i => renderCard(i, `draggable="true" data-source-email="${esc(email)}"`)).join('')
    : `<span class="av-empty">No open items</span>`;

  return `
    <div class="av-section${isCollapsed ? ' collapsed' : ''}" data-email="${esc(email)}" data-has-issues="${hasIssues}">
      <div class="av-header" data-section-key="${esc(key)}">
        <span class="av-chevron">▼</span>
        ${avatarHtml}
        <span class="av-name">${esc(label)}</span>
        <span class="av-count">${issues.length}</span>
      </div>
      <div class="av-cards">${cardHtml}</div>
    </div>`;
}

function wireAssigneeView() {
  // Collapse toggles
  document.querySelectorAll('.av-header').forEach(header => {
    header.addEventListener('click', () => {
      const key = header.dataset.sectionKey;
      const section = header.closest('.av-section');
      const hasIssues = section.dataset.hasIssues === 'true';
      if (isSectionCollapsed(key, hasIssues)) {
        collapsedSections.delete(key);
        if (!hasIssues) expandedSections.add(key);
        section.classList.remove('collapsed');
      } else {
        collapsedSections.add(key);
        expandedSections.delete(key);
        section.classList.add('collapsed');
      }
    });
  });

  // Card clicks
  document.querySelectorAll('.issue-card').forEach(el => {
    el.addEventListener('click', () => openPanel(el.dataset.id));
  });

  // Drag and drop
  let activeDrag = null; // { id, sourceEmail }

  document.querySelectorAll('.issue-card[draggable]').forEach(card => {
    card.addEventListener('dragstart', e => {
      activeDrag = { id: card.dataset.id, sourceEmail: card.dataset.sourceEmail };
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.stopPropagation();
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      activeDrag = null;
    });
  });

  document.querySelectorAll('.av-section').forEach(section => {
    const targetEmail = section.dataset.email;

    section.addEventListener('dragover', e => {
      if (!activeDrag) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      section.classList.add('drag-over');
    });

    section.addEventListener('dragleave', e => {
      if (!section.contains(e.relatedTarget)) {
        section.classList.remove('drag-over');
      }
    });

    section.addEventListener('drop', e => {
      e.preventDefault();
      section.classList.remove('drag-over');
      if (!activeDrag) return;
      const { id, sourceEmail } = activeDrag;
      activeDrag = null;
      if (sourceEmail !== targetEmail) {
        reassignIssue(id, sourceEmail, targetEmail);
      }
    });
  });
}

async function reassignIssue(id, sourceEmail, targetEmail) {
  const issue = allIssues.find(i => i.id === id);
  if (!issue) return;
  let assignees = [...issue.assignees];
  if (sourceEmail && assignees.includes(sourceEmail)) {
    assignees = assignees.filter(e => e !== sourceEmail);
  }
  if (targetEmail && !assignees.includes(targetEmail)) {
    assignees.push(targetEmail);
  }
  await patchIssueLocal(id, { assignees });
}

function renderCard(issue, extraAttrs = '') {
  const assigneeHtml = issue.assignees.slice(0, 3).map(email => userAvatar(email)).join('');

  const extraAssignees = issue.assignees.length > 3
    ? `<span style="font-size:11px;color:var(--muted)">+${issue.assignees.length - 3}</span>`
    : '';

  return `
    <div class="issue-card" data-id="${issue.id}"${extraAttrs ? ' ' + extraAttrs : ''}>
      ${issue.thumbnail
        ? `<div class="card-thumb" style="background-image:url('data:image/png;base64,${issue.thumbnail}')"></div>`
        : ''}
      <div class="card-body">
        <div class="card-title">${esc(issue.part_name)}</div>
        <div class="card-meta">
          <span class="badge badge-type">${TYPE_LABEL[issue.manufacturing_type] ?? issue.manufacturing_type}</span>
          <span class="badge badge-${issue.priority}">${issue.priority}</span>
        </div>
        <div class="card-footer">
          <div class="assignee-chips">${assigneeHtml}${extraAssignees}</div>
          ${issue.comments.length > 0 ? `<span>💬 ${issue.comments.length}</span>` : ''}
          <span>&times;${issue.quantity}</span>
        </div>
      </div>
    </div>
  `;
}

// ---- Panel ---------------------------------------------------------------

function openPanel(id) {
  const issue = allIssues.find(i => i.id === id);
  if (!issue) return;
  openIssueId = id;
  renderPanel(issue);
  document.getElementById('overlay').classList.remove('hidden');
  document.getElementById('panel').classList.remove('hidden');
}

function closePanel() {
  openIssueId = null;
  document.getElementById('overlay').classList.add('hidden');
  document.getElementById('panel').classList.add('hidden');
}

function renderPanel(issue) {
  const next = nextStage(issue);
  const isTerminal = issue.stage === 'complete' || issue.stage === 'redesign';
  const onshapeUrl = `https://cad.onshape.com/documents/${issue.onshape.document_id}`
    + `/w/${issue.onshape.workspace_id}/m/${issue.onshape.microversion_id}/e/${issue.onshape.element_id}`;

  const redesignChain = [
    issue.redesign_predecessor_id
      ? `<div class="redesign-link">↩ Redesign of: <a href="#" data-id="${issue.redesign_predecessor_id}">${issue.redesign_predecessor_id}</a></div>`
      : '',
    issue.redesign_successor_id
      ? `<div class="redesign-link">↪ Replaced by: <a href="#" data-id="${issue.redesign_successor_id}">${issue.redesign_successor_id}</a></div>`
      : '',
  ].filter(Boolean).join('');

  // Build interleaved activity timeline
  const activity = [
    ...issue.comments.map(c => ({ type: 'comment', ts: c.created_at, data: c })),
    ...(issue.history || []).map(h => ({ type: 'history', ts: h.created_at, data: h })),
  ].sort((a, b) => new Date(a.ts) - new Date(b.ts));

  const activityHtml = activity.map(item => {
    if (item.type === 'comment') {
      const c = item.data;
      return `
        <div class="comment">
          <div class="comment-meta"><strong>${esc(userName(c.author))}</strong> &nbsp;${timeAgo(c.created_at)}</div>
          <div class="md">${c.body_html}</div>
        </div>`;
    } else {
      const h = item.data;
      const fromHtml = h.from ? `<span class="hist-from">${esc(h.from)}</span> → ` : '';
      return `
        <div class="history-entry">
          <span class="hist-actor">${esc(userName(h.actor))}</span>
          changed <strong>${esc(h.field)}</strong>:
          ${fromHtml}<span class="hist-to">${esc(h.to)}</span>
          <span class="hist-time">${timeAgo(h.created_at)}</span>
        </div>`;
    }
  }).join('');

  // Meta-grid: admin sees editable controls, others see static values
  const stageCell = isAdmin
    ? `<select id="admin-stage" class="admin-select">
        ${Object.entries(STAGE_LABEL).map(([v, l]) =>
          `<option value="${v}"${issue.stage === v ? ' selected' : ''}>${l}</option>`
        ).join('')}
       </select>`
    : `<strong>${STAGE_LABEL[issue.stage] ?? issue.stage}</strong>`;

  const typeCell = isAdmin
    ? `<select id="admin-type" class="admin-select">
        ${Object.entries(TYPE_LABEL).map(([v, l]) =>
          `<option value="${v}"${issue.manufacturing_type === v ? ' selected' : ''}>${l}</option>`
        ).join('')}
       </select>`
    : (TYPE_LABEL[issue.manufacturing_type] ?? issue.manufacturing_type);

  const priorityCell = isAdmin
    ? `<select id="admin-priority" class="admin-select">
        ${['critical','high','medium','low'].map(p =>
          `<option value="${p}"${issue.priority === p ? ' selected' : ''}>${p.charAt(0).toUpperCase()+p.slice(1)}</option>`
        ).join('')}
       </select>`
    : `<span class="badge badge-${issue.priority}">${issue.priority}</span>`;

  const qtyCell = isAdmin
    ? `<input id="admin-qty" class="admin-input" type="number" min="1" value="${issue.quantity}" style="width:72px">`
    : issue.quantity;

  const materialCell = isAdmin
    ? `<input id="admin-material" class="admin-input" type="text" value="${esc(issue.material)}">`
    : (esc(issue.material) || '<em>-</em>');

  const partNameHtml = isAdmin
    ? `<input id="admin-name" class="admin-title-input" type="text" value="${esc(issue.part_name)}">`
    : `<div class="panel-title">${esc(issue.part_name)}</div>`;

  const notesHtml = isAdmin
    ? `<div>
        <div class="section-heading">Description</div>
        <div style="margin-top:10px">
          <textarea id="admin-notes" class="admin-textarea">${esc(issue.notes)}</textarea>
          <div style="text-align:right;margin-top:6px">
            <button class="btn btn-default" id="save-notes-btn">Save Description</button>
          </div>
        </div>
       </div>`
    : (issue.notes_html ? `
        <div>
          <div class="section-heading">Description</div>
          <div class="md" style="margin-top:10px">${issue.notes_html}</div>
        </div>` : '');

  document.getElementById('panel-body').innerHTML = `
    <div>
      ${partNameHtml}
      <a class="panel-onshape-link" href="${onshapeUrl}" target="_blank">Open in OnShape ↗</a>
      ${redesignChain}
    </div>

    <dl class="meta-grid">
      <dt class="meta-label">Stage</dt>
      <dd class="meta-value">${stageCell}</dd>
      <dt class="meta-label">Type</dt>
      <dd class="meta-value">${typeCell}</dd>
      <dt class="meta-label">Priority</dt>
      <dd class="meta-value">${priorityCell}</dd>
      <dt class="meta-label">Assignees</dt>
      <dd class="meta-value" id="assignees-cell"></dd>
      <dt class="meta-label">Reviewers</dt>
      <dd class="meta-value" id="reviewers-cell"></dd>
      <dt class="meta-label">Submitted by</dt>
      <dd class="meta-value">${esc(userName(issue.submitted_by))}</dd>
      <dt class="meta-label">Quantity</dt>
      <dd class="meta-value">${qtyCell}</dd>
      <dt class="meta-label">Material</dt>
      <dd class="meta-value">${materialCell}</dd>
    </dl>

    <div class="actions">
      ${next && !isTerminal
        ? `<button class="btn btn-primary" id="advance-btn">Advance to ${STAGE_LABEL[next]} →</button>`
        : ''}
      ${!isTerminal
        ? `<button class="btn btn-danger" id="redesign-btn">Mark as Redesign</button>`
        : ''}
      ${canDelete
        ? `<button class="btn btn-delete" id="delete-btn">Delete Part</button>`
        : ''}
    </div>

    ${notesHtml}

    <div>
      <div class="section-heading">Files (${issue.files.length})</div>
      <div id="files-list" style="margin-top:10px">
        ${issue.files.length ? issue.files.map(f => `
          <div class="file-row">
            <a class="file-name" href="${API}${esc(f.download_url)}" target="_blank"
               data-auth-download="${esc(f.download_url)}">${esc(f.name)}</a>
            <span class="file-meta">${formatBytes(f.size)} &middot; ${timeAgo(f.uploaded_at)}</span>
          </div>
        `).join('') : '<p style="color:var(--muted);font-size:13px">No files attached.</p>'}
      </div>
      <div class="add-file" style="margin-top:10px">
        <input type="file" id="file-input" multiple accept=".gcode,.nc,.ngc,.stl,.step,.stp,.f3d">
        <button class="btn btn-default" id="file-upload-btn" style="margin-top:6px">Upload File(s)</button>
      </div>
    </div>

    <div>
      <div class="section-heading">Activity (${issue.comments.length + (issue.history||[]).length})</div>
      <div id="activity-list">${activityHtml || '<p style="color:var(--muted);font-size:13px;margin-top:10px">No activity yet.</p>'}</div>
      <div class="add-comment" style="margin-top:14px">
        <textarea id="comment-input" placeholder="Leave a comment… (Markdown supported)"></textarea>
        <div class="add-comment-footer">
          <button class="btn btn-primary" id="comment-submit">Comment</button>
        </div>
      </div>
    </div>
  `;

  // Wire standard actions
  document.getElementById('advance-btn')?.addEventListener('click', () => advanceStage(issue, next));
  document.getElementById('redesign-btn')?.addEventListener('click', () => markRedesign(issue));
  document.getElementById('delete-btn')?.addEventListener('click', () => deletePart(issue));
  document.getElementById('file-upload-btn').addEventListener('click', () => uploadFiles(issue.id));
  document.getElementById('comment-submit').addEventListener('click', () => submitComment(issue.id));

  // Multi-select dropdowns
  buildMultiSelect('assignees-cell', allUsers.filter(u => u.assignee), issue.assignees, sel =>
    patchIssueLocal(issue.id, { assignees: sel })
  );
  buildMultiSelect('reviewers-cell', allUsers.filter(u => u.reviewer), issue.reviewers, sel =>
    patchIssueLocal(issue.id, { reviewers: sel })
  );

  // Admin controls
  if (isAdmin) {
    function adminPatch(update) { patchIssueLocal(issue.id, update); }

    document.getElementById('admin-name')?.addEventListener('change', e =>
      adminPatch({ part_name: e.target.value.trim() })
    );
    document.getElementById('admin-stage')?.addEventListener('change', e =>
      adminPatch({ stage: e.target.value })
    );
    document.getElementById('admin-type')?.addEventListener('change', e =>
      adminPatch({ manufacturing_type: e.target.value })
    );
    document.getElementById('admin-priority')?.addEventListener('change', e =>
      adminPatch({ priority: e.target.value })
    );
    document.getElementById('admin-qty')?.addEventListener('change', e =>
      adminPatch({ quantity: parseInt(e.target.value, 10) })
    );
    document.getElementById('admin-material')?.addEventListener('change', e =>
      adminPatch({ material: e.target.value })
    );
    document.getElementById('save-notes-btn')?.addEventListener('click', () => {
      const val = document.getElementById('admin-notes')?.value ?? '';
      adminPatch({ notes: val });
    });
  }

  // Redesign chain navigation
  document.querySelectorAll('[data-id]').forEach(el => {
    el.addEventListener('click', e => { e.preventDefault(); openPanel(el.dataset.id); });
  });
}

// ---- Mutations -----------------------------------------------------------

// Optimistic local patch — updates memory + board immediately, syncs in background.
async function patchIssueLocal(id, update) {
  const issue = allIssues.find(i => i.id === id);
  if (issue) Object.assign(issue, update);
  renderBoard();
  const resp = await api('PATCH', `/parts/${id}`, update);
  if (resp.ok) {
    const fresh = await resp.json();
    const idx = allIssues.findIndex(i => i.id === id);
    if (idx !== -1) allIssues[idx] = fresh;
    renderBoard();
    if (openIssueId === id) renderPanel(fresh);
  }
}

// ---- Multi-select dropdown -----------------------------------------------

function buildMultiSelect(cellId, users, initialSelected, onChange) {
  const cell = document.getElementById(cellId);
  if (!cell) return;

  let selected = new Set(initialSelected);

  function triggerLabel() {
    if (selected.size === 0) return '<em>None</em>';
    return [...selected].map(e => esc(userName(e))).join(', ');
  }

  function render(filter) {
    const q = (filter || '').toLowerCase();
    const filtered = users.filter(u =>
      u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q)
    );
    return filtered.map(u => `
      <div class="ms-item${selected.has(u.email) ? ' ms-selected' : ''}" data-email="${esc(u.email)}">
        <span class="ms-check">✓</span>
        <img class="ms-avatar" src="${API}/avatars/${encodeURIComponent(u.email)}"
             alt="" onerror="this.style.display='none';this.nextElementSibling.style.display='inline-flex'">
        <div class="ms-avatar ms-avatar-initials" style="display:none">${esc((u.name||u.email).slice(0,2).toUpperCase())}</div>
        <span class="ms-name">${esc(u.name)}</span>
        <span class="ms-email-hint">${esc(u.email)}</span>
      </div>
    `).join('');
  }

  function mount() {
    cell.innerHTML = `
      <div class="ms-wrap">
        <button type="button" class="ms-trigger">${triggerLabel()}</button>
        <div class="ms-dropdown hidden">
          <input class="ms-search" type="text" placeholder="Filter users…" autocomplete="off">
          <div class="ms-list">${render('')}</div>
        </div>
      </div>`;

    const trigger  = cell.querySelector('.ms-trigger');
    const dropdown = cell.querySelector('.ms-dropdown');
    const search   = cell.querySelector('.ms-search');
    const list     = cell.querySelector('.ms-list');

    function wireItems() {
      list.querySelectorAll('.ms-item').forEach(el => {
        el.addEventListener('mousedown', e => {
          e.preventDefault(); // keep focus on search input
          const email = el.dataset.email;
          if (selected.has(email)) selected.delete(email);
          else selected.add(email);
          trigger.innerHTML = triggerLabel();
          list.innerHTML = render(search.value);
          wireItems();
          onChange([...selected]);
        });
      });
    }

    function close() { dropdown.classList.add('hidden'); }

    function open() {
      dropdown.classList.remove('hidden');
      search.value = '';
      list.innerHTML = render('');
      search.focus();
      wireItems();

      function onDocClick(e) {
        if (!cell.contains(e.target)) {
          close();
          document.removeEventListener('click', onDocClick);
        }
      }
      document.addEventListener('click', onDocClick);
    }

    trigger.addEventListener('click', e => {
      e.stopPropagation();
      dropdown.classList.contains('hidden') ? open() : close();
    });
    search.addEventListener('input', () => {
      list.innerHTML = render(search.value);
      wireItems();
    });
    dropdown.addEventListener('click', e => e.stopPropagation());
  }

  mount();
}

async function advanceStage(issue, next) {
  const btn = document.getElementById('advance-btn');
  if (btn) btn.disabled = true;
  await api('PATCH', `/parts/${issue.id}`, { stage: next });
  await loadIssues();
}

async function deletePart(issue) {
  if (!confirm(`Delete "${issue.part_name}"? This cannot be undone.`)) return;
  const btn = document.getElementById('delete-btn');
  if (btn) btn.disabled = true;
  const resp = await api('DELETE', `/parts/${issue.id}`);
  if (resp.ok) {
    allIssues = allIssues.filter(i => i.id !== issue.id);
    closePanel();
    renderBoard();
  } else {
    if (btn) btn.disabled = false;
  }
}

async function markRedesign(issue) {
  if (!confirm(`Mark "${issue.part_name}" as redesign? This is permanent.`)) return;
  const btn = document.getElementById('redesign-btn');
  if (btn) btn.disabled = true;
  await api('PATCH', `/parts/${issue.id}`, { stage: 'redesign' });
  await loadIssues();
}

async function uploadFiles(id) {
  const input = document.getElementById('file-input');
  if (!input.files.length) return;
  const btn = document.getElementById('file-upload-btn');
  btn.disabled = true;
  const form = new FormData();
  for (const file of input.files) form.append('file', file, file.name);
  await fetch(`${API}/parts/${id}/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  input.value = '';
  btn.disabled = false;
  await loadIssues();
}

async function submitComment(id) {
  const input = document.getElementById('comment-input');
  const body = input.value.trim();
  if (!body) return;
  const btn = document.getElementById('comment-submit');
  btn.disabled = true;
  await api('POST', `/parts/${id}/comments`, { body });
  input.value = '';
  btn.disabled = false;
  await loadIssues();
}

// ---- Helpers -------------------------------------------------------------

async function api(method, path, body) {
  return fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

function esc(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

function timeAgo(iso) {
  const diff = Date.now() - new Date(iso);
  const rtf  = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  if (diff < 60_000)     return rtf.format(-Math.round(diff / 1_000),    'second');
  if (diff < 3_600_000)  return rtf.format(-Math.round(diff / 60_000),   'minute');
  if (diff < 86_400_000) return rtf.format(-Math.round(diff / 3_600_000),'hour');
  return rtf.format(-Math.round(diff / 86_400_000), 'day');
}

// ---- Init ----------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('login-btn').addEventListener('click', async () => {
    const resp = await fetch(`${API}/login`);
    const res  = await resp.json();
    jwt = res.jwt;
    popupWindow = window.open(res.auth_url, 'Login', 'width=500,height=600,resizable');
  });

  window.addEventListener('message', async e => {
    if (e.origin !== API) return;
    const data = JSON.parse(e.data);
    popupWindow?.close();
    const resp = await fetch(`${API}/login_complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: data.state, code: data.code, jwt }),
    });
    if (resp.status === 403) {
      const body = await resp.json().catch(() => ({}));
      if (body.not_in_roster) {
        const params = new URLSearchParams();
        if (body.email) params.set('email', body.email);
        if (body.name)  params.set('name',  body.name);
        window.location.href = `${API}/request_access?${params}`;
        return;
      }
    }
    const res = await resp.json();
    if (res.needs_enrollment) {
      const params = new URLSearchParams();
      params.set('pending_jwt', res.pending_jwt);
      if (res.email)       params.set('email',       res.email);
      if (res.google_name) params.set('google_name', res.google_name);
      params.set('return', window.location.href);
      window.location.href = `${API}/enroll?${params}`;
      return;
    }
    localStorage.setItem('ffst-login', JSON.stringify(res));
    await login(res);
  });

  document.getElementById('panel-close').addEventListener('click', closePanel);
  document.getElementById('overlay').addEventListener('click', closePanel);

  document.getElementById('refresh-btn').addEventListener('click', loadIssues);

  const userDropdown = document.getElementById('user-dropdown');
  document.getElementById('user-menu-btn').addEventListener('click', e => {
    e.stopPropagation();
    userDropdown.classList.toggle('hidden');
  });
  document.addEventListener('click', () => userDropdown.classList.add('hidden'));
  document.getElementById('logout-btn').addEventListener('click', () => {
    localStorage.removeItem('ffst-login');
    location.reload();
  });

  document.querySelectorAll('.scope-filter .filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.scope-filter .filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeScope = btn.dataset.scope;
      renderBoard();
    });
  });

  document.querySelectorAll('.type-filter .filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.type-filter .filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeType = btn.dataset.type;
      renderBoard();
    });
  });

  // Auto-refresh every 30 s.
  setInterval(loadIssues, 30_000);

  (async () => {
    const saved = localStorage.getItem('ffst-login');
    if (!saved) return;
    const res = JSON.parse(saved);
    const vResp = await fetch(`${API}/me`, { headers: { Authorization: `Bearer ${res.token}` } });
    if (!vResp.ok) { localStorage.removeItem('ffst-login'); return; }
    res.user_info = await vResp.json();
    localStorage.setItem('ffst-login', JSON.stringify(res));
    login(res);
  })();
});
