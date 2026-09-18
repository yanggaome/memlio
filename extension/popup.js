// The popup does all the work: no service worker, no content script file. It reads the active tab,
// optionally screenshots it, and hands everything to the local memlio host over native messaging.
const HOST = 'com.memlio.host';
const $ = (id) => document.getElementById(id);

const show = (text, kind = '') => {
  $('status').textContent = text;
  $('status').className = kind;
};

/** Turns Chrome's terse native messaging errors into the fix. */
function hostError(message) {
  if (/not found/i.test(message)) return 'The memlio host is not registered. Run: memlio setup chrome';
  if (/forbidden/i.test(message)) {
    return `This extension ID is not allowed. Run: memlio setup chrome --extension-id ${chrome.runtime.id}`;
  }
  if (/exited/i.test(message)) return 'The memlio host exited early. Run the launcher from a terminal to see why.';
  return message;
}

function native(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendNativeMessage(HOST, message, (response) => {
      if (chrome.runtime.lastError) reject(new Error(hostError(chrome.runtime.lastError.message)));
      else if (!response || !response.ok) reject(new Error(response?.error ?? 'The memlio host sent no reply.'));
      else resolve(response);
    });
  });
}

/** Runs inside the page. Only data comes back; nothing on the page is treated as an instruction. */
function capture() {
  return {
    title: document.title,
    html: document.documentElement.outerHTML.slice(0, 5_000_000),
    text: (document.body ? document.body.innerText : '').slice(0, 1_000_000),
  };
}

async function save(tab) {
  $('save').disabled = true;
  show('Saving…');
  try {
    const results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: capture });
    // Some frames (a PDF viewer, an error page) run the script but return nothing; the tab title still makes a bookmark.
    const page = results?.[0]?.result ?? { title: tab.title || '', html: '', text: '' };
    let screenshot;
    if ($('screenshot').checked) {
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      screenshot = dataUrl.slice(dataUrl.indexOf(',') + 1);
    }
    const saved = await native({
      type: 'store',
      url: tab.url,
      title: (page.title || tab.title || '').slice(0, 500),
      note: $('note').value.trim(),
      html: page.html,
      text: page.text,
      screenshot,
    });
    show(
      saved.duplicate
        ? `Already saved as ${saved.id}: ${saved.title}${saved.enriched ? '\nAdded the page text or screenshot it was missing.' : ''}`
        : [
            `Saved ${saved.id}: ${saved.title}`,
            saved.captureError ? `Page text not captured: ${saved.captureError}` : '',
            saved.indexError ? `Semantic indexing failed: ${saved.indexError}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
      'ok',
    );
  } catch (e) {
    show(e.message, 'error');
    $('save').disabled = false;
  }
}

async function main() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const savable = Boolean(tab?.url && /^https?:/i.test(tab.url));
  $('title').textContent = tab?.title || tab?.url || 'No page';
  $('url').textContent = savable ? new URL(tab.url).host : tab?.url || '';
  if (!savable) {
    show('Only web pages can be saved.', 'error');
    $('save').disabled = true;
  }
  $('save').addEventListener('click', () => save(tab));
  $('note').addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !$('save').disabled) save(tab);
  });
  try {
    const status = await native({ type: 'status' });
    $('footer').textContent = `${status.count} item${status.count === 1 ? '' : 's'} in ${status.home}`;
    $('footer').title = status.home;
  } catch (e) {
    $('footer').textContent = 'Not connected';
    show(e.message, 'error');
    $('save').disabled = true;
  }
}

main();
