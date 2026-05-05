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

const server = new URL(window.location.href).searchParams.get('server');

let popupWindow = null;
let jwt = null;
let token = null;

window.addEventListener("message", function(e) {
    console.log("Post message received in application extension.");
    console.log("e.origin = " + e.origin);

    // Verify the origin matches the server iframe src query parameter
    if (server === e.origin) {
        console.log("Message safe and can be handled as it is from origin '"
                    + e.origin +
                    "', which matches server query parameter '"
                    + server + "'.");
        if (e.data && e.data.messageName) {
            console.log("Message name = '" + e.data.messageName + "'");
        } else {
            console.log("Message name not found. Ignoring message.");
        }
        console.log(e.data);
    } else {
    console.log("Message NOT safe and should be ignored.");
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
document.addEventListener('DOMContentLoaded', function() {
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
});
