const params = new URL(window.location.href).searchParams;
const API    = params.get('api') || 'https://api.frc5572.org';

let token = null;
let jwt   = null;
let popupWindow = null;

let allIssues   = [];
let allUsers    = [];   // [{email, name}]
let activeType  = '';   // '' | '3d_print' | 'cnc' | 'manual_cut'
let openIssueId = null;

// ---- Stage / type metadata -----------------------------------------------

const TYPE_STAGES = {
  '3d_print':   ['ready_for_slicing', 'ready_for_printing', 'printing', 'complete'],
  'cnc':        ['ready_for_cam', 'ready_for_machining', 'machining', 'ready_for_deburring', 'complete'],
  'manual_cut': ['ready_for_cutting', 'cutting', 'complete'],
};

const STAGE_LABEL = {
  ready_for_slicing:   'Ready for Slicing',
  ready_for_printing:  'Ready for Printing',
  printing:            'Printing',
  ready_for_cam:       'Ready for CAM',
  ready_for_machining: 'Ready for Machining',
  machining:           'Machining',
  ready_for_deburring: 'Ready for Deburring',
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
  'ready_for_deburring',
  'complete', 'redesign',
];

function stagesFor(type) {
  if (type) return TYPE_STAGES[type] ?? [];
  // All: only stages that have at least one issue.
  const present = new Set(allIssues.map(i => i.stage));
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
  document.getElementById('user-avatar').src = res.user_info.data.picture;
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
  const stages  = stagesFor(activeType);
  const issues  = activeType ? allIssues.filter(i => i.manufacturing_type === activeType) : allIssues;
  const byStage = Object.fromEntries(stages.map(s => [s, []]));
  for (const issue of issues) {
    if (byStage[issue.stage] !== undefined) byStage[issue.stage].push(issue);
  }

  document.getElementById('board').innerHTML = stages.map(stage => `
    <div class="col">
      <div class="col-header">
        <span class="col-title">${STAGE_LABEL[stage] ?? stage}</span>
        <span class="col-count">${byStage[stage].length}</span>
      </div>
      <div class="col-cards">
        ${byStage[stage].map(renderCard).join('')}
      </div>
    </div>
  `).join('');

  document.querySelectorAll('.issue-card').forEach(el => {
    el.addEventListener('click', () => openPanel(el.dataset.id));
  });
}

function renderCard(issue) {
  const assigneeHtml = issue.assignees.slice(0, 3).map(email => {
    const initials = email.split('@')[0].slice(0, 2).toUpperCase();
    return `<div class="assignee-chip" title="${email}">${initials}</div>`;
  }).join('');

  const extraAssignees = issue.assignees.length > 3
    ? `<span style="font-size:11px;color:var(--muted)">+${issue.assignees.length - 3}</span>`
    : '';

  return `
    <div class="issue-card" data-id="${issue.id}">
      <div class="card-title">${esc(issue.part_name)}</div>
      <div class="card-meta">
        <span class="badge badge-type">${TYPE_LABEL[issue.manufacturing_type] ?? issue.manufacturing_type}</span>
        <span class="badge badge-${issue.priority}">${issue.priority}</span>
      </div>
      <div class="card-footer">
        <div class="assignee-chips">${assigneeHtml}${extraAssignees}</div>
        <span class="card-submitter" title="Submitted by ${esc(issue.submitted_by)}">${esc(userName(issue.submitted_by))}</span>
        ${issue.comments.length > 0 ? `<span>💬 ${issue.comments.length}</span>` : ''}
        <span>&times;${issue.quantity}</span>
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

  const commentsHtml = issue.comments.map(c => `
    <div class="comment">
      <div class="comment-meta"><strong>${esc(c.author)}</strong> &nbsp;${timeAgo(c.created_at)}</div>
      <div class="md">${c.body_html}</div>
    </div>
  `).join('');

  document.getElementById('panel-body').innerHTML = `
    <div>
      <div class="panel-title">${esc(issue.part_name)}</div>
      <a class="panel-onshape-link" href="${onshapeUrl}" target="_blank">Open in OnShape ↗</a>
      ${redesignChain}
    </div>

    <dl class="meta-grid">
      <dt class="meta-label">Stage</dt>
      <dd class="meta-value"><strong>${STAGE_LABEL[issue.stage] ?? issue.stage}</strong></dd>
      <dt class="meta-label">Type</dt>
      <dd class="meta-value">${TYPE_LABEL[issue.manufacturing_type] ?? issue.manufacturing_type}</dd>
      <dt class="meta-label">Priority</dt>
      <dd class="meta-value"><span class="badge badge-${issue.priority}">${issue.priority}</span></dd>
      <dt class="meta-label">Assignees</dt>
      <dd class="meta-value" id="assignees-cell"></dd>
      <dt class="meta-label">Reviewers</dt>
      <dd class="meta-value" id="reviewers-cell"></dd>
      <dt class="meta-label">Submitted by</dt>
      <dd class="meta-value">${esc(userName(issue.submitted_by))}</dd>
      <dt class="meta-label">Quantity</dt>
      <dd class="meta-value">${issue.quantity}</dd>
      <dt class="meta-label">Material</dt>
      <dd class="meta-value">${esc(issue.material) || '<em>-</em>'}</dd>
    </dl>

    <div class="actions">
      ${next && !isTerminal
        ? `<button class="btn btn-primary" id="advance-btn">Advance to ${STAGE_LABEL[next]} →</button>`
        : ''}
      ${!isTerminal
        ? `<button class="btn btn-danger" id="redesign-btn">Mark as Redesign</button>`
        : ''}
    </div>

    ${issue.notes_html ? `
      <div>
        <div class="section-heading">Description</div>
        <div class="md" style="margin-top:10px">${issue.notes_html}</div>
      </div>
    ` : ''}

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
      <div class="section-heading">Comments (${issue.comments.length})</div>
      <div id="comments-list">${commentsHtml}</div>
      <div class="add-comment" style="margin-top:14px">
        <textarea id="comment-input" placeholder="Leave a comment… (Markdown supported)"></textarea>
        <div class="add-comment-footer">
          <button class="btn btn-primary" id="comment-submit">Comment</button>
        </div>
      </div>
    </div>
  `;

  // Wire actions
  document.getElementById('advance-btn')?.addEventListener('click', () => advanceStage(issue, next));
  document.getElementById('redesign-btn')?.addEventListener('click', () => markRedesign(issue));
  document.getElementById('file-upload-btn').addEventListener('click', () => uploadFiles(issue.id));
  document.getElementById('comment-submit').addEventListener('click', () => submitComment(issue.id));

  // Multi-select dropdowns
  buildMultiSelect('assignees-cell', allUsers, issue.assignees, sel =>
    patchIssueLocal(issue.id, { assignees: sel })
  );
  buildMultiSelect('reviewers-cell', allUsers, issue.reviewers, sel =>
    patchIssueLocal(issue.id, { reviewers: sel })
  );

  // Redesign chain navigation
  document.querySelectorAll('[data-id]').forEach(el => {
    el.addEventListener('click', e => { e.preventDefault(); openPanel(el.dataset.id); });
  });
}

// ---- Mutations -----------------------------------------------------------

// Optimistic local patch — updates memory + board immediately, syncs in background.
function patchIssueLocal(id, update) {
  const issue = allIssues.find(i => i.id === id);
  if (issue) Object.assign(issue, update);
  renderBoard();
  api('PATCH', `/parts/${id}`, update);
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
    const res = await resp.json();
    localStorage.setItem('ffst-login', JSON.stringify(res));
    await login(res);
  });

  document.getElementById('panel-close').addEventListener('click', closePanel);
  document.getElementById('overlay').addEventListener('click', closePanel);

  document.getElementById('refresh-btn').addEventListener('click', loadIssues);

  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeType = btn.dataset.type;
      renderBoard();
    });
  });

  // Auto-refresh every 30 s.
  setInterval(loadIssues, 30_000);

  const saved = localStorage.getItem('ffst-login');
  if (saved) login(JSON.parse(saved));
});
