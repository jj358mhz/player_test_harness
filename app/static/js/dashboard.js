// Channels dashboard: filter, account chips, collapsible sections,
// select-all and the batch action bar. Patterns follow csl-slicer-console.
// Needs app.js (requestPlayback, showNotice) loaded first.

(function () {
    const sections = [...document.querySelectorAll('[data-account-section]')];
    if (!sections.length) return;

    const STORAGE_KEY = 'player-harness:collapsed-sections';
    const checkboxes = () => [...document.querySelectorAll('.channel-checkbox')];
    const cardOf = (cb) => cb.closest('[data-channel]');
    const visibleIn = (section) =>
        [...section.querySelectorAll('.channel-checkbox')].filter((cb) => !cardOf(cb).hidden);

    // ---- Filter -----------------------------------------------------------
    const filter = document.getElementById('channel-filter');
    filter?.addEventListener('input', () => {
        const q = filter.value.trim().toLowerCase();
        sections.forEach((section) => {
            let shown = 0;
            section.querySelectorAll('[data-channel]').forEach((card) => {
                const match = !q || card.dataset.search.includes(q);
                card.hidden = !match;
                if (match) shown++;
            });
            section.hidden = shown === 0;
            section.querySelector('[data-section-count]').textContent = shown;
            // The pinned rule only where pinned cards show above it and others below.
            const rule = section.querySelector('[data-pin-divider]');
            if (rule) {
                const visible = (card) => card.matches('[data-channel]') && !card.hidden;
                const before = [];
                const after = [];
                let past = false;
                for (const el of rule.parentElement.children) {
                    if (el === rule) past = true;
                    else if (visible(el)) (past ? after : before).push(el);
                }
                rule.hidden = !before.length || !after.length;
            }
        });
        syncSelection();
    });
    // ?q= (e.g. from the slicer console's link) pre-fills the filter.
    if (filter?.value) filter.dispatchEvent(new Event('input'));

    // ---- Selection --------------------------------------------------------
    const bar = document.getElementById('batch-bar');
    const count = document.getElementById('batch-count');

    function selected() {
        return checkboxes().filter((cb) => cb.checked && !cardOf(cb).hidden);
    }

    function syncSelection() {
        const n = selected().length;
        bar.hidden = n === 0;
        count.textContent = n;
        sections.forEach((section) => {
            const all = section.querySelector('.section-selectall__cb');
            const boxes = visibleIn(section);
            const on = boxes.filter((cb) => cb.checked).length;
            all.checked = boxes.length > 0 && on === boxes.length;
            all.indeterminate = on > 0 && on < boxes.length;
        });
    }

    checkboxes().forEach((cb) => cb.addEventListener('change', syncSelection));
    sections.forEach((section) => {
        const all = section.querySelector('.section-selectall__cb');
        all.addEventListener('change', () => {
            visibleIn(section).forEach((cb) => {
                cb.checked = all.checked;
            });
            syncSelection();
        });
    });
    document.getElementById('batch-clear').addEventListener('click', () => {
        checkboxes().forEach((cb) => {
            cb.checked = false;
        });
        syncSelection();
    });

    // ---- Collapsible sections (remembered per browser) ---------------------
    function loadCollapsed() {
        try {
            return new Set(JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'));
        } catch (_) {
            return new Set();
        }
    }

    function saveCollapsed(set) {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify([...set]));
        } catch (_) {
            /* private mode / quota: collapsing still works for this visit */
        }
    }

    const collapsed = loadCollapsed();
    sections.forEach((section) => {
        section.classList.toggle('account-section--collapsed', collapsed.has(section.dataset.section));
        section.querySelector('.account-section__header').addEventListener('click', (e) => {
            if (e.target.closest('.section-selectall')) return;
            const now = section.classList.toggle('account-section--collapsed');
            if (now) collapsed.add(section.dataset.section);
            else collapsed.delete(section.dataset.section);
            saveCollapsed(collapsed);
        });
    });
    document.getElementById('collapse-all-btn')?.addEventListener('click', () => {
        sections.forEach((s) => {
            s.classList.add('account-section--collapsed');
            collapsed.add(s.dataset.section);
        });
        saveCollapsed(collapsed);
    });
    document.getElementById('expand-all-btn')?.addEventListener('click', () => {
        sections.forEach((s) => s.classList.remove('account-section--collapsed'));
        collapsed.clear();
        saveCollapsed(collapsed);
    });

    // ---- Account chips: jump + highlight the section in view ---------------
    const chips = [...document.querySelectorAll('.workspace-nav__chip')];
    const setActive = (id) =>
        chips.forEach((c) => c.classList.toggle('workspace-nav__chip--active', c.dataset.target === id));
    chips.forEach((chip) =>
        chip.addEventListener('click', (e) => {
            const target = document.getElementById(chip.dataset.target);
            if (!target) return;
            e.preventDefault();
            target.classList.remove('account-section--collapsed');
            collapsed.delete(target.dataset.section);
            saveCollapsed(collapsed);
            setActive(target.id);
            target.scrollIntoView({behavior: 'smooth', block: 'start'});
        }),
    );
    if (chips.length && 'IntersectionObserver' in window) {
        const tops = new Map();
        const observer = new IntersectionObserver(
            (entries) => {
                entries.forEach((entry) => {
                    if (entry.isIntersecting) tops.set(entry.target.id, entry.boundingClientRect.top);
                    else tops.delete(entry.target.id);
                });
                let best = null;
                tops.forEach((y, id) => {
                    if (best === null || y < tops.get(best)) best = id;
                });
                if (best) setActive(best);
            },
            {rootMargin: '-20% 0px -60% 0px', threshold: 0},
        );
        sections.forEach((s) => observer.observe(s));
        setActive(sections[0].id);
    }

    // ---- Batch actions ----------------------------------------------------
    async function inBatches(items, size, fn) {
        for (let i = 0; i < items.length; i += size) {
            await Promise.all(items.slice(i, i + size).map(fn));
        }
    }

    function showCheck(card, results, encryption) {
        const el = card.querySelector('[data-check]');
        el.hidden = false;
        el.replaceChildren(
            ...results.map(({label, ok, error}) => {
                const pill = document.createElement('span');
                pill.className = `check-pill ${ok ? 'check-pill--ok' : 'check-pill--bad'}`;
                pill.textContent = `${label} ${ok ? '✓' : '✗'}`;
                if (error) pill.title = error;
                return pill;
            }),
        );
        // Only Studio DRM changes how to play; AES-128 is Uplynk's default.
        if (encryption === 'drm') {
            const pill = document.createElement('span');
            pill.className = 'check-pill check-pill--drm';
            pill.textContent = '🔒 DRM';
            pill.title = 'Studio DRM: FairPlay over HLS (Safari); Play opens DASH + Widevine in Chrome';
            el.append(pill);
        }
        if (encryption) markDrm(card, encryption === 'drm');
        const failed = results.find((r) => !r.ok);
        if (failed) {
            const why = document.createElement('span');
            why.className = 'check-why';
            why.textContent = failed.error;
            el.append(why);
        }
    }

    function markDrm(card, drm) {
        card.querySelector('[data-drm-badge]').hidden = !drm;
        card.querySelector('[data-play-label]').textContent = drm ? '▶ Play DRM' : '▶ Play HLS';
        const terms = card.dataset.search.split(' ').filter((t) => t !== 'drm');
        card.dataset.search = (drm ? [...terms, 'drm'] : terms).join(' ');
    }

    async function check(boxes) {
        let bad = 0;
        let drm = 0;
        await inBatches(boxes, 3, async (cb) => {
            const card = cardOf(cb);
            const results = [];
            let encryption = null;
            for (const [label, manifest] of [['HLS', 'm3u8'], ['DASH', 'mpd']]) {
                try {
                    const data = await requestPlayback({channel_id: Number(cb.value), manifest});
                    const ok = data.probe ? data.probe.ok : true;
                    encryption = encryption || data.probe?.encryption || null;
                    results.push({label, ok, error: data.probe?.error});
                } catch (err) {
                    results.push({label, ok: false, error: err.message});
                }
            }
            if (results.some((r) => !r.ok)) bad++;
            if (encryption === 'drm') drm++;
            showCheck(card, results, encryption);
        });
        showNotice(
            `Checked ${boxes.length} channel${boxes.length === 1 ? '' : 's'}: ` +
                (bad ? `${bad} with a manifest Uplynk refused (hover ✗ for why).` : 'every HLS and DASH manifest played.') +
                (drm ? ` ${drm} use${drm === 1 ? 's' : ''} Studio DRM.` : ''),
            bad ? 'error' : 'success',
        );
    }

    async function copy(boxes, manifest) {
        const lines = [];
        await inBatches(boxes, 4, async (cb) => {
            const data = await requestPlayback({channel_id: Number(cb.value), manifest, probe: false});
            lines.push([cb.dataset.name, data.url]);
        });
        lines.sort((a, b) => a[0].localeCompare(b[0]));
        await navigator.clipboard.writeText(lines.map(([name, url]) => `# ${name}\n${url}`).join('\n'));
        showNotice(`Copied ${lines.length} signed ${manifest === 'mpd' ? 'DASH' : 'HLS'} URL${lines.length === 1 ? '' : 's'}.`, 'success');
    }

    async function favorite(boxes, value) {
        const response = await fetch('/api/channels/favorite', {
            method: 'POST',
            headers: {'Content-Type': 'application/json', 'X-CSRFToken': csrfToken},
            body: JSON.stringify({ids: boxes.map((cb) => Number(cb.value)), favorite: value}),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        location.reload(); // pinned channels sort first
    }

    bar.querySelectorAll('[data-batch]').forEach((button) =>
        button.addEventListener('click', async () => {
            const boxes = selected();
            if (!boxes.length) return;
            bar.querySelectorAll('button').forEach((b) => {
                b.disabled = true;
            });
            try {
                const action = button.dataset.batch;
                if (action === 'check') await check(boxes);
                else if (action === 'copy-m3u8') await copy(boxes, 'm3u8');
                else if (action === 'copy-mpd') await copy(boxes, 'mpd');
                else await favorite(boxes, action === 'favorite');
            } catch (err) {
                showNotice(`Could not finish: ${err.message}`);
            } finally {
                bar.querySelectorAll('button').forEach((b) => {
                    b.disabled = false;
                });
            }
        }),
    );

    syncSelection();
})();
