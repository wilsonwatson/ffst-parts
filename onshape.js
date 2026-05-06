/**
 * Extracts Onshape document, workspace, and element IDs from a given URL.
 * Supports both query parameter format and Onshape path-based URL format.
 *
 * @param {string} currentURL - The full URL string to parse.
 * @returns {{ documentId: string, workspaceId: string, elementId: string }} An object containing the three Onshape IDs.
 * @throws {Error} If the required IDs cannot be found in the URL.
 */
function getOnshapeIdsFromUrl(currentURL) {
    const url = new URL(currentURL);
    const params = url.searchParams;

    const documentId = params.get('documentId');
    const workspaceId = params.get('workspaceId');
    const elementId = params.get('elementId');

    if (documentId && workspaceId && elementId) {
        return { documentId, workspaceId, elementId };
    }

    const pathMatch = url.pathname.match(/\/documents\/([^/]+)\/(?:w|v|m)\/([^/]+)\/e\/([^/]+)/);

    if (pathMatch) {
        return {
            documentId: pathMatch[1],
            workspaceId: pathMatch[2],
            elementId: pathMatch[3]
        };
    }

    throw new Error('Missing Onshape IDs in URL. Provide documentId, workspaceId, and elementId as query parameters or use an Onshape document URL.');
}

let assembly_info = null;

async function update_assembly_info(force_reupdate_cache) {
    const { documentId, workspaceId, elementId } = getOnshapeIdsFromUrl(window.location.href);
    let resp = await fetch("https://api.frc5572.org/onshape/assembly_info", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + token
        },
        body: JSON.stringify({
            document: documentId,
            workspace: workspaceId,
            element: elementId,
            force_reupdate_cache: force_reupdate_cache,
        })
    });
    assembly_info = await resp.json();
    console.log(assembly_info);
}

async function login(res) {
    token = res.token;
    console.log(res.user_info);
    document.querySelectorAll(".user-img").forEach((e) => {
        e.src = res.user_info.picture;
    });
    await update_assembly_info(false);
    document.getElementById("login-page").classList.add("hidden");
    document.getElementById("auth-content").classList.remove("hidden");
}

function findPartPath(occurrence) {
    if(!assembly_info) {
        return null;
    }
    for(let i = 0; i < assembly_info.length; i++) {
        if(assembly_info[i].id === occurrence) {
            return assembly_info[i];
        }
    }

    return null;
}

const server = new URL(window.location.href).searchParams.get('server');

let popupWindow = null;
let jwt = null;
let token = null;

window.addEventListener("message", async function(e) {
    if(e.origin === "https://api.frc5572.org") {
        let data = JSON.parse(e.data);
        if(popupWindow) {
            popupWindow.close();
        }

        let resp = await fetch("https://api.frc5572.org/login_complete", {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                state: data.state,
                code: data.code,
                jwt: jwt
            })
        });
        let res = await resp.json();
        localStorage.setItem("ffst-login", JSON.stringify(res));
        await login(res);
    } else if (e.origin === server) {
        if (e.data && e.data.messageName) {
            console.log(e.data);
            if (e.data.messageName === "SELECTION") {
                for(let i = 0; i < e.data.selections.length; i++) {
                    let selection = e.data.selections[i];
                    let occurrence = selection['occurrencePath'][0];
                    let res = findPartPath(occurrence);
                    if(!res) {
                        await update_assembly_info(false);
                        res = findPartPath(occurrence);
                    }
                    console.log(res);
                }
            }
        }
    }
}, false);

/**
 * Initializes the Hello World application once the DOM is fully loaded.
 *
 * This handler performs the following steps:
 * 1. Parses Onshape document, workspace, and element IDs from the current
 *    page URL using {@link getOnshapeIdsFromUrl}.
 * 2. Sends an `applicationInit` message to the Onshape parent frame
 *    to signal that the app is ready.
 * 3. Attaches a click listener to the button that sends a `showMessageBubble` 
 *    message with the text "Hello World!" to the parent frame.
 *
 * @listens Document#DOMContentLoaded
 */
document.addEventListener('DOMContentLoaded', async function() {
    // Get reference to the parsed IDs.
    const { documentId, workspaceId, elementId } = getOnshapeIdsFromUrl(window.location.href);
    console.log('Onshape IDs:', { documentId, workspaceId, elementId });

    // Send applicationInit message
    const appInitMessage = {
        documentId: documentId,
        workspaceId: workspaceId,
        elementId: elementId,
        messageName: 'applicationInit'
    };
    window.parent.postMessage(appInitMessage, '*');

    document.getElementById("login").addEventListener("click", async () => {
        let resp = await fetch("https://api.frc5572.org/login");
        let res = await resp.json();
        jwt = res['jwt'];
        popupWindow = window.open(res['auth_url'], "Login", "resizable");
    });

    let res = localStorage.getItem("ffst-login");
    if(res) {
        await login(JSON.parse(res));
    }
});
