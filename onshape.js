const params = new URL(window.location.href).searchParams;
const API            = params.get('api')            || 'https://api.frc5572.org';
const SERVER         = params.get('server');         // OnShape origin, e.g. https://cad.onshape.com
const AUTH0_DOMAIN   = params.get('auth0_domain')   || 'legoguy1000.auth0.com';
const AUTH0_CLIENT   = params.get('auth0_client_id')|| '3DIkQirwReuUotmcBcozUMlRHBKd60TX';
const AUTH0_AUDIENCE = params.get('auth0_audience') || 'https://parts.frc5572.org';

let auth0Client = null;

async function getToken() {
    return auth0Client.getTokenSilently({
        authorizationParams: { audience: AUTH0_AUDIENCE },
    });
}

// Resolved OnShape ref for the currently selected part, or null.
let selectedPart = null;

const form = {
    manufacturing_type: '3d_print',
    quantity: 1,
    material: '',
    notes: '',
    redesign_predecessor_id: null,
};

// ---- Auth ----------------------------------------------------------------

async function login(res) {
    document.getElementById('user-avatar').src = res.user_info.data.picture;
    document.getElementById('user-name').textContent = res.user_info.data.name;
    document.getElementById('login-page').classList.add('hidden');
    document.getElementById('main').classList.remove('hidden');

    const canSubmit = !!res.user_info.data.permissions?.onshape_submit;
    document.getElementById('no-permission').classList.toggle('hidden', canSubmit);
    document.getElementById('form-area').classList.toggle('hidden', !canSubmit);
    if (canSubmit) loadRedesignIssues();
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
        const t = await getToken();
        const resp = await fetch(`${API}/onshape/resolve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
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
        const nameEl = document.getElementById('submission-name');
        if (!nameEl.dataset.userEdited) nameEl.value = part.part_name;
        document.getElementById('part-link').href =
            `https://cad.onshape.com/documents/${part.document_id}` +
            `/w/${part.workspace_id}/m/${part.microversion_id}` +
            `/e/${part.element_id}`;

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
    const name = document.getElementById('submission-name')?.value.trim() ?? '';
    document.getElementById('submit-btn').disabled = !selectedPart || !name;
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
        const t = await getToken();
        const resp = await fetch(`${API}/parts?stage=redesign`, {
            headers: { Authorization: `Bearer ${t}` },
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
        const t = await getToken();
        const resp = await fetch(`${API}/parts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
            body: JSON.stringify({
                part_name: document.getElementById('submission-name').value.trim(),
                onshape: {
                    document_id: selectedPart.document_id,
                    workspace_id: selectedPart.workspace_id,
                    microversion_id: selectedPart.microversion_id,
                    element_id: selectedPart.element_id,
                    part_id: selectedPart.part_id,
                },
                manufacturing_type: form.manufacturing_type,
                quantity: parseInt(document.getElementById('quantity').value, 10),
                material: document.getElementById('material').value,
                notes: document.getElementById('notes').value,
                due_date: document.getElementById('due-date').value || null,
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
            document.getElementById('submission-name').value = '';
            document.getElementById('submission-name').dataset.userEdited = '';
            document.getElementById('due-date').value = '';
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

async function completeLogin() {
    const t = await getToken();
    let meResp = await fetch(`${API}/me`, { headers: { Authorization: `Bearer ${t}` } });

    if (meResp.status === 403) {
        // Not in roster — check if enrollment is open.
        const enrollCheck = await fetch(`${API}/enroll`);
        if (!enrollCheck.ok) {
            alert('Access denied. Contact an admin to be added to the roster.');
            return;
        }
        const enrollResp = await fetch(`${API}/enroll`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
            body: JSON.stringify({}),
        });
        if (!enrollResp.ok) {
            alert('Enrollment failed. Contact an admin.');
            return;
        }
        meResp = await fetch(`${API}/me`, { headers: { Authorization: `Bearer ${t}` } });
    }

    if (!meResp.ok) {
        alert('Login failed. Please try again.');
        return;
    }

    const userInfo = await meResp.json();
    await login({ user_info: userInfo });
}

document.addEventListener('DOMContentLoaded', async () => {
    auth0Client = await auth0.createAuth0Client({
        domain: AUTH0_DOMAIN,
        clientId: AUTH0_CLIENT,
        authorizationParams: {
            audience: AUTH0_AUDIENCE,
            scope: 'openid email profile',
        },
        useRefreshTokens: true,
        cacheLocation: 'localstorage',
    });

    const { documentId, workspaceId, elementId } = getOnshapeIds();

    // Tell OnShape the extension is ready
    window.parent.postMessage(
        { messageName: 'applicationInit', documentId, workspaceId, elementId },
        '*'
    );

    document.getElementById('login-btn').addEventListener('click', async () => {
        try {
            await auth0Client.loginWithPopup();
        } catch (e) {
            console.error('Login failed:', e);
            return;
        }
        await completeLogin();
    });

    setupSelector('mfg-type', 'manufacturing_type');

    document.getElementById('material').addEventListener('input', () => {
        document.getElementById('material').dataset.userEdited = '1';
    });
    document.getElementById('submission-name').addEventListener('input', () => {
        document.getElementById('submission-name').dataset.userEdited = '1';
        updateSubmitState();
    });

    document.getElementById('submit-btn').addEventListener('click', submit);

    // Restore session via Auth0's cached token.
    try {
        await auth0Client.getTokenSilently({
            authorizationParams: { audience: AUTH0_AUDIENCE },
        });
        await completeLogin();
    } catch {
        // No cached session — show login page.
    }
});
