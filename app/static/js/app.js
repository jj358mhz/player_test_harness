// Shared helpers for harness pages.

const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content;

async function requestPlayback(body) {
    const response = await fetch('/api/playback', {
        method: 'POST',
        headers: {'Content-Type': 'application/json', 'X-CSRFToken': csrfToken},
        body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({error: `HTTP ${response.status}`}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
}

function flashButton(button, text) {
    const original = button.dataset.label || button.textContent;
    button.dataset.label = original;
    button.textContent = text;
    setTimeout(() => { button.textContent = original; }, 1800);
}

// Show a flash message at the top of the page without reloading.
function showNotice(message, kind = 'error') {
    const main = document.querySelector('.site-main');
    let list = main.querySelector(':scope > .flashes');
    if (!list) {
        list = document.createElement('ul');
        list.className = 'flashes';
        main.prepend(list);
    }
    const item = document.createElement('li');
    item.className = `flash flash--${kind}`;
    item.textContent = message;
    list.prepend(item);
    list.scrollIntoView({behavior: 'smooth', block: 'nearest'});
}

// <button data-copy-url data-body='{"channel_id": 1, "manifest": "m3u8"}'>
document.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-copy-url]');
    if (!button) return;
    button.disabled = true;
    try {
        const data = await requestPlayback(JSON.parse(button.dataset.body));
        await navigator.clipboard.writeText(data.url);
        if (data.probe && !data.probe.ok) {
            flashButton(button, 'Copied ⚠');
            showNotice(`${button.dataset.label}: URL copied, but Uplynk answered ${data.probe.error}`);
        } else {
            flashButton(button, 'Copied ✓');
        }
    } catch (err) {
        flashButton(button, 'Failed');
        showNotice(`Could not sign URL: ${err.message}`);
    } finally {
        button.disabled = false;
    }
});
