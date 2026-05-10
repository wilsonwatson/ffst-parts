const params = new URL(window.location.href).searchParams;
const API    = params.get('api') || 'https://api.frc5572.org';
const SERVER = params.get('server'); // OnShape origin, e.g. https://cad.onshape.com

let token = null;
let jwt   = null;
let popupWindow = null;

// Resolved OnShape ref for the currently selected part, or null.
let selectedPart = null;

const form = {
    manufacturing_type: '3d_print',
    priority: 'medium',
    quantity: 1,
    material: '',
    notes: '',
    redesign_predecessor_id: null,
};

// ---- Auth ----------------------------------------------------------------

async function login(res) {
    token = res.token;
    document.getElementById('user-avatar').src = res.user_info.data.picture;
    document.getElementById('user-name').textContent = res.user_info.data.name;
    document.getElementById('login-page').classList.add('hidden');
    document.getElementById('main').classList.remove('hidden');
    loadRedesignIssues();
}

// ---- Part resolution -----------------------------------------------------

function showState(id) {
    ['state-none', 'state-loading', 'state-one', 'state-multi', 'state-error']
        .forEach(s => document.getElementById(s).classList.toggle('hidden', s !== id));
}

async function resolveSelection(occurrencePath, workspaceMicroversionId, documentId, workspaceId, elementId) {
    showState('state-loading');
    document.getElementById('submit-btn').disabled = true;
    selectedPart = null;

    try {
        const resp = await fetch(`${API}/onshape/resolve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({
                occurrence_path: occurrencePath,
                workspace_microversion_id: workspaceMicroversionId,
                document_id: documentId,
                workspace_id: workspaceId,
                element_id: elementId,
            }),
        });

        if (!resp.ok) { showState('state-error'); return; }

        const part = await resp.json();
        selectedPart = part;

        document.getElementById('part-name').textContent = part.part_name;
        document.getElementById('part-link').href =
            `https://cad.onshape.com/documents/${part.onshape.document_id}` +
            `/w/${part.onshape.workspace_id}/m/${part.onshape.microversion_id}` +
            `/e/${part.onshape.element_id}`;

        const materialEl = document.getElementById('material');
        if (part.material && !materialEl.dataset.userEdited) {
            materialEl.value = part.material;
            form.material = part.material;
        }

        showState('state-one');
        updateSubmitState();
    } catch {
        showState('state-error');
    }
}

function updateSubmitState() {
    document.getElementById('submit-btn').disabled = !selectedPart;
}

// ---- OnShape postMessage -------------------------------------------------

function getOnshapeIds() {
    const p = new URL(window.location.href).searchParams;
    return {
        documentId:  p.get('documentId'),
        workspaceId: p.get('workspaceId'),
        elementId:   p.get('elementId'),
    };
}

window.addEventListener('message', async (e) => {
    // OAuth popup callback
    if (e.origin === API) {
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
        return;
    }

    // OnShape selection events
    if (SERVER && e.origin === SERVER && e.data?.messageName === 'SELECTION') {
        const selections = e.data.selections ?? [];
        const { documentId, workspaceId, elementId } = getOnshapeIds();

        if (selections.length === 0) {
            showState('state-none');
            selectedPart = null;
            updateSubmitState();
        } else if (selections.length === 1) {
            const { occurrencePath, workspaceMicroversionId } = selections[0];
            await resolveSelection(occurrencePath, workspaceMicroversionId, documentId, workspaceId, elementId);
        } else {
            showState('state-multi');
            selectedPart = null;
            updateSubmitState();
        }
    }
});

// ---- Form helpers --------------------------------------------------------

function setupSelector(listId, key) {
    const list = document.getElementById(listId);
    const items = [...list.children];
    // Select first item by default
    items[0].classList.add('selected');
    form[key] = items[0].dataset.value;

    items.forEach((item) => {
        item.addEventListener('click', () => {
            items.forEach(el => el.classList.remove('selected'));
            item.classList.add('selected');
            form[key] = item.dataset.value;
        });
    });
}

async function loadRedesignIssues() {
    try {
        const resp = await fetch(`${API}/parts?stage=redesign`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        if (!resp.ok) return;

        const issues = await resp.json();
        const select = document.getElementById('redesign-pred');
        issues.forEach(issue => {
            const opt = document.createElement('option');
            opt.value = issue.id;
            opt.textContent = issue.part_name;
            select.appendChild(opt);
        });

        document.getElementById('redesign-field').classList.toggle('hidden', issues.length === 0);
    } catch {
        document.getElementById('redesign-field').classList.add('hidden');
    }
}

// ---- Submit --------------------------------------------------------------

async function submit() {
    if (!selectedPart) return;

    const btn = document.getElementById('submit-btn');
    const errEl = document.getElementById('submit-error');
    btn.disabled = true;
    errEl.classList.add('hidden');

    const predecessor = document.getElementById('redesign-pred').value || null;

    try {
        const resp = await fetch(`${API}/parts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({
                part_name: selectedPart.part_name,
                onshape: selectedPart.onshape,
                manufacturing_type: form.manufacturing_type,
                priority: form.priority,
                quantity: parseInt(document.getElementById('quantity').value, 10),
                material: document.getElementById('material').value,
                notes: document.getElementById('notes').value,
                redesign_predecessor_id: predecessor,
            }),
        });

        if (resp.status === 201) {
            // Reset form state after successful submit
            showState('state-none');
            selectedPart = null;
            document.getElementById('notes').value = '';
            document.getElementById('material').value = '';
            document.getElementById('material').dataset.userEdited = '';
            document.getElementById('redesign-pred').value = '';
            updateSubmitState();
        } else if (resp.status === 403) {
            errEl.textContent = 'You don\'t have permission to submit parts.';
            errEl.classList.remove('hidden');
            btn.disabled = false;
        } else {
            errEl.textContent = 'Submission failed - please try again.';
            errEl.classList.remove('hidden');
            btn.disabled = false;
        }
    } catch {
        errEl.textContent = 'Network error - please try again.';
        errEl.classList.remove('hidden');
        btn.disabled = false;
    }
}

// ---- Init ----------------------------------------------------------------

document.addEventListener('DOMContentLoaded', async () => {
    const { documentId, workspaceId, elementId } = getOnshapeIds();

    // Tell OnShape the extension is ready
    window.parent.postMessage(
        { messageName: 'applicationInit', documentId, workspaceId, elementId },
        '*'
    );

    document.getElementById('login-btn').addEventListener('click', async () => {
        const resp = await fetch(`${API}/login`);
        const res = await resp.json();
        jwt = res.jwt;
        popupWindow = window.open(res.auth_url, 'Login', 'width=500,height=600,resizable');
    });

    setupSelector('mfg-type', 'manufacturing_type');
    setupSelector('priority', 'priority');

    document.getElementById('material').addEventListener('input', () => {
        document.getElementById('material').dataset.userEdited = '1';
    });

    document.getElementById('submit-btn').addEventListener('click', submit);

    // Restore session from localStorage
    const saved = localStorage.getItem('ffst-login');
    if (saved) {
        await login(JSON.parse(saved));
    }
});
