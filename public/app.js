/**
 * CineSeat — three panels: Sinema Seçimi | Film Seçimi | Tarih ve Seans.
 *
 * The first two panels swap, so the flow works cinema→film or film→cinema. The
 * catalogue is fetched live per panel, which is fast enough that there is no
 * loading state worth designing around; only the seat scan takes real time.
 *
 * UI strings are Turkish; code and comments stay English.
 */

const el = (id) => document.getElementById(id);

const state = {
  mode: 'cinema-first', // or 'film-first'
  cinemas: [],
  films: [],
  technologies: {},
  cities: [],
  cinema: null,
  film: null,
  date: null,
  sessions: { groups: [], showtimes: [] },
  scanned: new Map(), // sessionId → scan result
  cinemaScope: 'all',
  filmScope: 'all',
  cityFilter: null,
  techFilter: null,
  cinemaQuery: '',
  filmQuery: '',
  ticketCount: 2,
  autoScan: true,
  coords: null,
  scanSource: null,
  scanToken: 0,
};

// ─── Fetch ────────────────────────────────────────────────────────────────────

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Sunucu hatası (HTTP ${res.status})`);
  }
  return res.json();
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

async function boot() {
  const settings = await api('/api/settings').catch(() => ({}));
  state.ticketCount = settings.ticketCount ?? 2;
  state.autoScan = settings.autoScan ?? true;
  state.cityFilter = settings.city ?? null;
  el('tc-value').textContent = state.ticketCount;
  el('autoscan-toggle').checked = state.autoScan;

  await Promise.all([loadCinemas(), loadFilms(), loadTechnologies()]);
  renderCityCombo();
  renderTechCombo();
  renderCinemas();
  renderFilms();
  renderSessions();
}

async function loadCinemas() {
  const q = new URLSearchParams();
  if (state.mode === 'film-first' && state.film) q.set('filmId', state.film.id);
  if (state.coords) {
    q.set('lat', state.coords.lat);
    q.set('lng', state.coords.lng);
  }
  state.cinemas = await api(`/api/cinemas?${q}`);
  state.cities = [...new Set(state.cinemas.map((c) => c.city).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, 'tr'),
  );
}

async function loadFilms() {
  const q = new URLSearchParams();
  if (state.mode === 'cinema-first' && state.cinema) q.set('cinemaId', state.cinema.id);
  state.films = await api(`/api/films?${q}`);
}

async function loadTechnologies() {
  state.technologies = await api('/api/technologies').catch(() => ({}));
}

// ─── Panel 1/2: cinemas ───────────────────────────────────────────────────────

function visibleCinemas() {
  let list = state.cinemas;
  if (state.cinemaScope === 'fav') list = list.filter((c) => c.isFavourite);
  if (state.cinemaScope === 'near' && state.coords) {
    list = [...list].sort((a, b) => (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9)).slice(0, 25);
  }
  if (state.cityFilter) list = list.filter((c) => c.city === state.cityFilter);
  if (state.techFilter) list = list.filter((c) => c.technologies.some((t) => t.slug === state.techFilter));
  const q = state.cinemaQuery.trim().toLocaleLowerCase('tr');
  if (q) {
    list = list.filter(
      (c) =>
        c.name.toLocaleLowerCase('tr').includes(q) ||
        (c.city ?? '').toLocaleLowerCase('tr').includes(q),
    );
  }
  if (state.cinemaScope !== 'near') {
    list = [...list].sort(
      (a, b) => Number(b.isFavourite) - Number(a.isFavourite) || a.name.localeCompare(b.name, 'tr'),
    );
  }
  return list;
}

function renderCinemas() {
  const list = visibleCinemas();
  const box = el('cinema-list');

  if (state.mode === 'film-first' && !state.film) {
    box.innerHTML = hint('Önce bir film seçin.');
    return;
  }
  if (!list.length) {
    box.innerHTML = hint('Eşleşen salon yok.');
    return;
  }

  box.innerHTML = list
    .map(
      (c) => `
      <article class="card cinema${state.cinema?.id === c.id ? ' is-selected' : ''}"
               data-cinema="${attr(c.id)}" tabindex="0" role="button">
        <div class="card-main">
          <h3>${esc(c.name)}</h3>
          <p class="muted">${esc(c.city ?? '')}${
            c.distanceKm != null && state.coords ? ` · ${c.distanceKm.toFixed(0)} km` : ''
          }</p>
          ${
            c.technologies.length
              ? `<div class="tech-row">${c.technologies
                  .map((t) => `<span class="tech-badge">${esc(t.label ?? t.slug)}</span>`)
                  .join('')}</div>`
              : ''
          }
        </div>
        <button type="button" class="heart${c.isFavourite ? ' is-on' : ''}" data-fav="${attr(c.id)}"
                aria-label="${c.isFavourite ? 'Favorilerden çıkar' : 'Favorilere ekle'}">♥</button>
      </article>`,
    )
    .join('');

  box.querySelectorAll('.cinema').forEach((card) => {
    const pick = () => selectCinema(card.dataset.cinema);
    card.addEventListener('click', (e) => {
      if (e.target.closest('.heart')) return;
      pick();
    });
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        pick();
      }
    });
  });

  box.querySelectorAll('.heart').forEach((btn) =>
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.fav;
      const c = state.cinemas.find((x) => x.id === id);
      try {
        const r = await api(`/api/favourites/${encodeURIComponent(id)}`, {
          method: 'POST',
          body: JSON.stringify({ isFavourite: !c.isFavourite }),
        });
        c.isFavourite = r.isFavourite;
        renderCinemas();
      } catch (err) {
        toast(err.message);
      }
    }),
  );
}

async function selectCinema(id) {
  state.cinema = state.cinemas.find((c) => c.id === id) ?? null;
  state.date = null;
  state.sessions = { groups: [], showtimes: [] };
  state.scanned.clear();
  renderCinemas();

  if (state.mode === 'cinema-first') {
    // Narrow the film panel to what is actually showing here.
    state.film = null;
    await loadFilms();
    renderFilms();
    renderSessions();
  } else {
    await refreshDates();
  }
}

// ─── Panel 1/2: films ─────────────────────────────────────────────────────────

function visibleFilms() {
  let list = state.films;
  if (state.filmScope === 'presale') list = list.filter((f) => f.isPreSale);
  const q = state.filmQuery.trim().toLocaleLowerCase('tr');
  if (q) {
    list = list.filter(
      (f) =>
        f.title.toLocaleLowerCase('tr').includes(q) ||
        (f.originalTitle ?? '').toLocaleLowerCase('tr').includes(q),
    );
  }
  return list;
}

function renderFilms() {
  const box = el('film-list');
  if (state.mode === 'cinema-first' && !state.cinema) {
    box.innerHTML = hint('Önce bir salon seçin.');
    return;
  }
  const list = visibleFilms();
  if (!list.length) {
    box.innerHTML = hint('Film bulunamadı.');
    return;
  }

  box.innerHTML = list
    .map(
      (f) => `
      <article class="card film${state.film?.id === f.id ? ' is-selected' : ''}"
               data-film="${attr(f.id)}" tabindex="0" role="button">
        ${
          f.posterUrl
            ? `<img class="poster" src="${attr(f.posterUrl)}" alt="" loading="lazy" />`
            : `<div class="poster poster-empty">🎬</div>`
        }
        <div class="card-main">
          <h3>${esc(f.title)}</h3>
          ${f.originalTitle ? `<p class="muted italic">${esc(f.originalTitle)}</p>` : ''}
          ${f.isPreSale ? `<span class="pill">Ön Satış</span>` : ''}
        </div>
      </article>`,
    )
    .join('');

  box.querySelectorAll('.film').forEach((card) => {
    const pick = () => selectFilm(card.dataset.film);
    card.addEventListener('click', pick);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        pick();
      }
    });
  });
}

async function selectFilm(id) {
  state.film = state.films.find((f) => f.id === id) ?? null;
  state.date = null;
  state.sessions = { groups: [], showtimes: [] };
  state.scanned.clear();
  renderFilms();

  if (state.mode === 'film-first') {
    // Narrow the cinema panel to those showing this film.
    state.cinema = null;
    await loadCinemas();
    renderCinemas();
    renderSessions();
  } else {
    await refreshDates();
  }
}

// ─── Panel 3: dates + sessions ────────────────────────────────────────────────

async function refreshDates() {
  if (!state.cinema || !state.film) {
    renderSessions();
    return;
  }
  el('date-strip').innerHTML = `<span class="muted small">Tarihler alınıyor…</span>`;
  try {
    const dates = await api(
      `/api/dates?filmId=${encodeURIComponent(state.film.id)}&cinemaId=${encodeURIComponent(state.cinema.id)}`,
    );
    if (!dates.length) {
      el('date-strip').innerHTML = '';
      el('session-list').innerHTML = hint('Bu film bu salonda gösterimde değil.');
      return;
    }
    state.dates = dates;
    renderDateStrip();
    await selectDate(dates[0].date);
  } catch (err) {
    el('date-strip').innerHTML = '';
    el('session-list').innerHTML = errorBox('Tarihler alınamadı', err.message);
  }
}

function renderDateStrip() {
  el('date-strip').innerHTML = (state.dates ?? [])
    .map(
      (d) => `
      <button type="button" class="date-chip${state.date === d.date ? ' is-selected' : ''}"
              data-date="${attr(d.date)}">
        <strong>${esc(dayNum(d.date))} ${esc(monthName(d.date))}</strong>
        <span>${esc(weekday(d.date))}</span>
      </button>`,
    )
    .join('');
  el('date-strip')
    .querySelectorAll('.date-chip')
    .forEach((b) => b.addEventListener('click', () => selectDate(b.dataset.date)));
}

async function selectDate(date) {
  state.date = date;
  state.scanned.clear();
  renderDateStrip();
  el('session-list').innerHTML = hint('Seanslar alınıyor…');
  try {
    state.sessions = await api(
      `/api/sessions?filmId=${encodeURIComponent(state.film.id)}` +
        `&cinemaId=${encodeURIComponent(state.cinema.id)}&date=${encodeURIComponent(date)}`,
    );
    renderSessions();
    if (state.autoScan) startScan();
  } catch (err) {
    el('session-list').innerHTML = errorBox('Seanslar alınamadı', err.message);
  }
}

function renderSessions() {
  const box = el('session-list');
  if (!state.cinema || !state.film) {
    box.innerHTML = hint('Salon ve film seçtiğinizde seanslar burada görünür.');
    return;
  }
  const { groups } = state.sessions;
  if (!groups?.length) {
    box.innerHTML = hint('Seans bulunamadı.');
    return;
  }

  box.innerHTML = groups
    .map(
      (g) => `
      <div class="sgroup">
        <div class="sgroup-head">
          ${g.technologies
            .map((t) => `<span class="tech-badge strong">${esc(techLabel(t))}</span>`)
            .join('')}
          <span class="sgroup-label">${esc(g.label)}</span>
        </div>
        <div class="times">
          ${g.showtimes.map(showtimeChip).join('')}
        </div>
      </div>`,
    )
    .join('');

  box.querySelectorAll('.time-chip').forEach((chip) =>
    chip.addEventListener('click', () => onShowtimeClick(chip.dataset.session)),
  );
}

function showtimeChip(s) {
  const scan = state.scanned.get(s.sessionId);
  let meta = '';
  let cls = '';

  if (scan?.error) {
    // A showtime with nothing on sale is not the same as a failed lookup, and
    // neither is the same as a full hall.
    cls = scan.unavailable ? ' is-unavailable' : ' is-error';
    meta = `<span class="chip-meta">${scan.unavailable ? 'satışta değil' : 'kontrol edilemedi'}</span>`;
  } else if (scan) {
    const pct = scan.bestScore == null ? null : Math.round(scan.bestScore * 100);
    cls = pct == null ? ' is-none' : pct >= 80 ? ' is-great' : pct >= 50 ? ' is-ok' : ' is-poor';
    meta = `<span class="chip-meta">${
      pct == null ? 'yan yana yer yok' : `${esc(scan.bestLabel ?? '')} · %${pct}`
    }</span><span class="chip-free">${scan.available}/${scan.total}</span>`;
  }

  return `
    <button type="button" class="time-chip${cls}" data-session="${attr(s.sessionId)}">
      <span class="chip-time">${esc(s.time)}${
        s.isNextDay ? '<span class="next-day">+1 gün</span>' : ''
      }</span>
      ${meta}
    </button>`;
}

// ─── Scan ─────────────────────────────────────────────────────────────────────

function startScan() {
  stopScan();
  if (!state.cinema || !state.film || !state.date) return;
  const total = state.sessions.showtimes.length;
  if (!total) return;

  const token = ++state.scanToken;
  const url =
    `/api/scan?filmId=${encodeURIComponent(state.film.id)}` +
    `&cinemaId=${encodeURIComponent(state.cinema.id)}` +
    `&date=${encodeURIComponent(state.date)}&ticketCount=${state.ticketCount}`;

  const src = new EventSource(url);
  state.scanSource = src;
  showScanBar(0, total);

  src.addEventListener('progress', (e) => {
    if (token !== state.scanToken) return;
    const { done, total: t, latest } = JSON.parse(e.data);
    if (latest) state.scanned.set(latest.sessionId, latest);
    showScanBar(done, t);
    renderSessions();
  });

  src.addEventListener('done', () => {
    if (token === state.scanToken) stopScan();
  });

  src.addEventListener('error', () => {
    if (token === state.scanToken) stopScan();
  });
}

function stopScan() {
  state.scanSource?.close();
  state.scanSource = null;
  el('scan-bar').hidden = true;
}

function showScanBar(done, total) {
  el('scan-bar').hidden = false;
  el('scan-fill').style.width = total ? `${Math.round((done / total) * 100)}%` : '0%';
  el('scan-label').textContent = `${done}/${total} seans`;
}

// ─── Showtime → seat map ──────────────────────────────────────────────────────

function onShowtimeClick(sessionId) {
  const s = state.sessions.showtimes.find((x) => x.sessionId === sessionId);
  if (!s) return;

  // The site flags sessions that run past midnight, with its own wording. Make
  // the user acknowledge it so the date can't be misread.
  if (s.isNextDay && s.warning) {
    showWarning(s.warning, () => openSeats(s));
  } else {
    openSeats(s);
  }
}

function showWarning(text, onOk) {
  el('warn-text').textContent = text;
  el('warn-modal').hidden = false;
  const ok = el('warn-ok');
  ok.focus();
  const done = () => {
    el('warn-modal').hidden = true;
    ok.removeEventListener('click', done);
    onOk?.();
  };
  ok.addEventListener('click', done);
}

async function openSeats(showtime, { ticketTypeCode = null } = {}) {
  el('seat-sheet').hidden = false;
  el('sheet-title').textContent = `${state.film?.title ?? ''} · ${showtime.time}`;
  el('sheet-sub').textContent = [
    state.cinema?.name,
    showtime.label,
    showtime.isNextDay ? 'ertesi gün' : null,
  ]
    .filter(Boolean)
    .join(' · ');
  el('seat-body').innerHTML = `<div class="loading"><div class="spinner"></div><p>Koltuk planı alınıyor…</p></div>`;

  const q = new URLSearchParams({ ticketCount: String(state.ticketCount) });
  if (ticketTypeCode) q.set('ticketTypeCode', ticketTypeCode);

  try {
    const data = await api(
      `/api/seats/${encodeURIComponent(showtime.cinemaCode)}/${encodeURIComponent(showtime.sessionId)}?${q}`,
    );
    renderSeats(data, showtime);
  } catch (err) {
    el('seat-body').innerHTML = errorBox('Koltuk planı alınamadı', err.message, true);
    el('seat-body')
      .querySelector('.retry')
      ?.addEventListener('click', () => openSeats(showtime, { ticketTypeCode }));
  }
}

function renderSeats(data, showtime) {
  const suggestions = data.suggestions ?? [];
  const rank = new Map();
  suggestions.forEach((s, i) => s.seats.forEach((x) => rank.set(`${x.rowLetter}-${x.seatNumber}`, i)));

  el('seat-body').innerHTML = `
    <div class="answer">
      ${
        suggestions.length
          ? `<div class="answer-main">${esc(data.bestLabel ?? '')}</div>
             <div class="answer-sub">%${Math.round(suggestions[0].score * 100)} uygunluk · ${state.ticketCount} kişilik</div>`
          : `<div class="answer-main muted">${state.ticketCount} yan yana boş koltuk yok</div>`
      }
      <dl class="facts">
        <div><dt>Boş</dt><dd>${data.available} / ${data.totalSeats}</dd></div>
        <div><dt>Salon</dt><dd>${data.rowCount}×${data.maxRowWidth}</dd></div>
        <div><dt>Veri</dt><dd>${data.fromCache ? `${data.ageSeconds} sn önce` : 'az önce'}</dd></div>
      </dl>
    </div>

    ${
      (data.ticketTypes ?? []).length > 1
        ? `<label class="field"><span>Bilet tipi</span>
             <select id="ticket-type">${data.ticketTypes
               .map(
                 (t) =>
                   `<option value="${attr(t.code)}"${t.code === data.ticketTypeCode ? ' selected' : ''}>${esc(
                     t.label ?? t.code,
                   )}</option>`,
               )
               .join('')}</select></label>`
        : ''
    }

    ${
      suggestions.length
        ? `<ol class="suggestions">${suggestions
            .map(
              (s, i) =>
                `<li><span class="rank${i === 0 ? ' rank-top' : ''}">${i + 1}</span>
                 <span>${esc(describe(s))}</span><span class="pct">%${Math.round(s.score * 100)}</span></li>`,
            )
            .join('')}</ol>`
        : ''
    }

    <div class="seat-scroll"><div class="seat-grid" id="seat-grid"></div></div>
    <div class="screen-bar">PERDE</div>
    <div class="legend">
      <span><i class="dot free"></i>Boş</span>
      <span><i class="dot rec"></i>Önerilen</span>
      <span><i class="dot taken"></i>Dolu</span>
      <span><i class="dot blocked"></i>Bu bilete uygun değil</span>
    </div>

    <div class="sheet-actions">
      <button type="button" class="btn-ghost" id="follow-btn">Takibe al</button>
      <button type="button" class="btn-ghost" id="refresh-btn">Yenile</button>
      <a class="btn-primary" target="_blank" rel="noopener"
         href="https://www.paribucineverse.com${attr(showtime.dataUrl)}">Bilet al</a>
    </div>`;

  drawGrid(data, rank);

  el('ticket-type')?.addEventListener('change', (e) =>
    openSeats(showtime, { ticketTypeCode: e.target.value }),
  );
  el('refresh-btn').addEventListener('click', () =>
    openSeats(showtime, { ticketTypeCode: data.ticketTypeCode }),
  );
  el('follow-btn').addEventListener('click', () => followShowtime(showtime));
}

/** Halls run from 7×9 to 15×39, so cells are sized to the hall, not fixed. */
function drawGrid(data, rank) {
  const grid = el('seat-grid');
  const avail = grid.parentElement.clientWidth - 48;
  const size = Math.max(11, Math.min(24, Math.floor(avail / (data.maxRowWidth + 2)) - 3));
  grid.style.setProperty('--seat', `${size}px`);

  grid.innerHTML = data.rows
    .map((row) => {
      if (row.isSpacer) return `<div class="srow is-spacer"></div>`;
      const cells = row.cells
        .map((c) => {
          if (!c) return `<i class="seat gap"></i>`;
          const r = rank.get(`${c.rowLetter}-${c.seatNumber}`);
          const cls =
            r !== undefined
              ? `rec${r === 0 ? ' rec-top' : ''}`
              : c.state === 'occupied'
                ? 'taken'
                : c.state === 'handicapped'
                  ? 'handicapped'
                  : c.selectable
                    ? 'free'
                    : 'blocked';
          const label = `${row.rowLetter} sırası koltuk ${c.seatNumber}`;
          return `<i class="seat ${cls}" title="${attr(label)}" aria-label="${attr(label)}"></i>`;
        })
        .join('');
      return `<div class="srow"><b>${esc(row.rowLetter ?? '')}</b>${cells}<b>${esc(row.rowLetter ?? '')}</b></div>`;
    })
    .join('');
}

async function followShowtime(s) {
  try {
    await api('/api/follows', {
      method: 'POST',
      body: JSON.stringify({
        cinemaCode: s.cinemaCode,
        sessionId: s.sessionId,
        ticketCount: state.ticketCount,
        filmId: state.film?.id,
        cinemaId: state.cinema?.id,
        filmTitle: state.film?.title,
        cinemaName: state.cinema?.name,
        date: state.date,
        time: s.time,
        startsAt: s.startsAt,
        isNextDay: s.isNextDay,
        label: s.label,
        technologies: s.technologies,
      }),
    });
    toast('Takip listesine eklendi.');
  } catch (err) {
    toast(err.message);
  }
}

// ─── Takip ────────────────────────────────────────────────────────────────────

async function loadFollows() {
  const box = el('follow-list');
  try {
    const items = await api('/api/follows');
    if (!items.length) {
      box.innerHTML = hint('Henüz takip ettiğiniz seans yok. Bir koltuk planı açıp "Takibe al" deyin.');
      return;
    }
    box.innerHTML = items
      .map(
        (f) => `
        <article class="card follow${f.expired ? ' is-expired' : ''}" data-follow="${attr(f.id)}"
                 ${f.expired ? '' : 'tabindex="0" role="button"'}>
          <div class="card-main">
            <h3>${esc(f.filmTitle ?? 'Seans')} · ${esc(f.time ?? '')}${
              f.isNextDay ? ' <span class="next-day">+1 gün</span>' : ''
            }</h3>
            <p class="muted">${esc(f.cinemaName ?? '')} · ${esc(f.date ?? '')} · ${f.ticketCount} bilet</p>
            ${
              f.expired
                ? `<p class="muted small">Bu seans geçti.</p>`
                : f.error
                  ? `<p class="err small">${esc(f.error)}</p>`
                  : f.available != null
                    ? `<p class="small">${esc(f.bestLabel ?? '')} · ${f.available}/${f.total} boş</p>`
                    : `<p class="muted small">Henüz kontrol edilmedi.</p>`
            }
          </div>
          <button type="button" class="link-btn" data-unfollow="${attr(f.id)}">Kaldır</button>
        </article>`,
      )
      .join('');

    box.querySelectorAll('.follow:not(.is-expired)').forEach((card) => {
      const open = () => openFollow(items.find((f) => f.id === card.dataset.follow));
      card.addEventListener('click', (e) => {
        if (e.target.closest('[data-unfollow]')) return;
        open();
      });
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      });
    });

    box.querySelectorAll('[data-unfollow]').forEach((b) =>
      b.addEventListener('click', async (e) => {
        e.stopPropagation();
        await api(`/api/follows/${encodeURIComponent(b.dataset.unfollow)}`, { method: 'DELETE' });
        loadFollows();
      }),
    );
  } catch (err) {
    box.innerHTML = errorBox('Takip listesi alınamadı', err.message);
  }
}

/** Tapping a follow reopens its seat map — the whole point of saving it. */
function openFollow(f) {
  if (!f) return;
  showTab('book');
  state.ticketCount = f.ticketCount ?? state.ticketCount;
  el('tc-value').textContent = state.ticketCount;

  openSeats({
    cinemaCode: f.cinemaCode,
    sessionId: f.sessionId,
    time: f.time ?? '',
    label: f.label ?? '',
    isNextDay: f.isNextDay,
    dataUrl: `/biletleme/~step~ticket~code~${f.cinemaCode}~session~${f.sessionId}`,
  });
  el('sheet-title').textContent = `${f.filmTitle ?? 'Seans'} · ${f.time ?? ''}`;
  el('sheet-sub').textContent = [f.cinemaName, f.date].filter(Boolean).join(' · ');
}

// ─── Durum ────────────────────────────────────────────────────────────────────

async function loadStatus() {
  try {
    const s = await api('/api/status');
    el('status-panel').innerHTML = `
      <div class="card block">
        <h3>Bağlantı</h3>
        ${
          s.net.demoted
            ? `<p class="err">Site istekleri sınırladı, hız düşürüldü.<br />${esc(s.net.reason ?? '')}
               <br /><span class="muted small">Normale dönüş: ${esc(s.net.resumesAt ?? '')}</span></p>`
            : `<p class="ok">Normal hızda çalışıyor.</p>`
        }
        <p class="muted small">Kuyruk: ${s.net.queues.interactive.pending + s.net.queues.interactive.queued} etkileşimli,
          ${s.net.queues.background.pending + s.net.queues.background.queued} arka plan
          ${s.net.demotions ? ` · ${s.net.demotions} kez yavaşlatıldı` : ''}</p>
      </div>
      <div class="card block">
        <h3>Ayarlar</h3>
        <label class="field row"><input type="checkbox" id="status-autoscan" ${
          s.settings.autoScan ? 'checked' : ''
        } /> <span>Koltukları otomatik tara</span></label>
        <p class="muted small">Kapatırsanız koltuklar yalnızca bir seansa tıkladığınızda alınır.</p>
      </div>
      <div class="card block">
        <h3>Yerel veri</h3>
        <p class="muted small">${esc(s.store.path)}</p>
        <p class="small">${s.store.favourites} favori · ${s.store.follows} takip ·
          ${s.store.cachedSeatMaps} önbellek koltuk planı</p>
      </div>`;

    el('status-autoscan').addEventListener('change', (e) => setAutoScan(e.target.checked));
  } catch (err) {
    el('status-panel').innerHTML = errorBox('Durum alınamadı', err.message);
  }
}

function setAutoScan(on) {
  state.autoScan = on;
  el('autoscan-toggle').checked = on;
  api('/api/settings', { method: 'POST', body: JSON.stringify({ autoScan: on }) }).catch(() => {});
  if (!on) stopScan();
}

// ─── Comboboxes ───────────────────────────────────────────────────────────────

function renderCityCombo() {
  el('city-label').textContent = state.cityFilter ?? 'Şehir seç';
  const q = (el('city-search').value ?? '').trim().toLocaleLowerCase('tr');
  const items = state.cities.filter((c) => !q || c.toLocaleLowerCase('tr').includes(q));
  el('city-list').innerHTML =
    `<li><button type="button" data-city="">Tümü</button></li>` +
    items.map((c) => `<li><button type="button" data-city="${attr(c)}">${esc(c)}</button></li>`).join('');
  el('city-list')
    .querySelectorAll('button')
    .forEach((b) =>
      b.addEventListener('click', () => {
        state.cityFilter = b.dataset.city || null;
        api('/api/settings', {
          method: 'POST',
          body: JSON.stringify({ city: state.cityFilter }),
        }).catch(() => {});
        closeCombos();
        renderCityCombo();
        renderCinemas();
      }),
    );
}

function renderTechCombo() {
  const entries = Object.entries(state.technologies);
  el('tech-label').textContent = state.techFilter
    ? (state.technologies[state.techFilter] ?? state.techFilter)
    : 'Ayrıcalıklı salon seç';
  el('tech-list').innerHTML =
    `<li><button type="button" data-tech="">Tümü</button></li>` +
    entries
      .map(([slug, label]) => `<li><button type="button" data-tech="${attr(slug)}">${esc(label)}</button></li>`)
      .join('');
  el('tech-list')
    .querySelectorAll('button')
    .forEach((b) =>
      b.addEventListener('click', () => {
        state.techFilter = b.dataset.tech || null;
        closeCombos();
        renderTechCombo();
        renderCinemas();
      }),
    );
}

function closeCombos() {
  for (const id of ['city-pop', 'tech-pop']) el(id).hidden = true;
  for (const id of ['city-btn', 'tech-btn']) el(id).setAttribute('aria-expanded', 'false');
}

function toggleCombo(popId, btnId) {
  const pop = el(popId);
  const open = pop.hidden;
  closeCombos();
  pop.hidden = !open;
  el(btnId).setAttribute('aria-expanded', String(open));
  if (open && popId === 'city-pop') el('city-search').focus();
}

// ─── Tabs, swap, misc ─────────────────────────────────────────────────────────

function showTab(name) {
  for (const t of ['book', 'follows', 'status']) el(`tab-${t}`).hidden = t !== name;
  document.querySelectorAll('.topnav-btn').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.tab === name);
  });
  if (name === 'follows') loadFollows();
  if (name === 'status') loadStatus();
}

async function swapMode() {
  state.mode = state.mode === 'cinema-first' ? 'film-first' : 'cinema-first';
  document.querySelector('.board').classList.toggle('film-first', state.mode === 'film-first');
  // Keep whichever side was already chosen; reload the other from scratch.
  state.sessions = { groups: [], showtimes: [] };
  state.scanned.clear();
  stopScan();
  await Promise.all([loadCinemas(), loadFilms()]);
  renderCinemas();
  renderFilms();
  if (state.cinema && state.film) await refreshDates();
  else renderSessions();
}

function setTicketCount(n) {
  state.ticketCount = Math.max(1, Math.min(10, n));
  el('tc-value').textContent = state.ticketCount;
  api('/api/settings', {
    method: 'POST',
    body: JSON.stringify({ ticketCount: state.ticketCount }),
  }).catch(() => {});
  state.scanned.clear();
  renderSessions();
  if (state.autoScan) startScan();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function describe(s) {
  const n = s.seats.map((x) => x.seatNumber).sort((a, b) => a - b);
  return `${s.rowLetter} sırası, koltuk ${n.length === 1 ? n[0] : `${n[0]}-${n[n.length - 1]}`}`;
}

/**
 * The two sources spell some slugs differently — the session fragment says
 * "gold-class" where the cinema list says "goldclass" — so match on letters
 * only, and fall back to the raw slug rather than showing nothing.
 */
const normTech = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
function techLabel(slug) {
  if (state.technologies[slug]) return state.technologies[slug];
  const want = normTech(slug);
  for (const [k, v] of Object.entries(state.technologies)) {
    if (normTech(k) === want) return v;
  }
  return slug;
}

const dayNum = (iso) => String(Number(iso.slice(8, 10)));
function monthName(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('tr-TR', { month: 'long' });
}
function weekday(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((date - today) / 86400000);
  if (diff === 0) return 'Bugün';
  if (diff === 1) return 'Yarın';
  return date.toLocaleDateString('tr-TR', { weekday: 'long' });
}

const hint = (t) => `<p class="hint">${esc(t)}</p>`;
const errorBox = (title, msg, retry = false) =>
  `<div class="errbox"><strong>${esc(title)}</strong><p>${esc(msg)}</p>${
    retry ? '<button type="button" class="btn-ghost retry">Tekrar dene</button>' : ''
  }</div>`;

let toastTimer;
function toast(msg) {
  const t = el('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3500);
}

function esc(s) {
  return String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}
const attr = esc;

// ─── Wiring ───────────────────────────────────────────────────────────────────

el('tc-minus').addEventListener('click', () => setTicketCount(state.ticketCount - 1));
el('tc-plus').addEventListener('click', () => setTicketCount(state.ticketCount + 1));
el('swap-btn').addEventListener('click', swapMode);
el('autoscan-toggle').addEventListener('change', (e) => {
  setAutoScan(e.target.checked);
  if (e.target.checked) startScan();
});

el('cinema-search').addEventListener('input', (e) => {
  state.cinemaQuery = e.target.value;
  renderCinemas();
});
el('film-search').addEventListener('input', (e) => {
  state.filmQuery = e.target.value;
  renderFilms();
});
el('city-search').addEventListener('input', renderCityCombo);
el('city-btn').addEventListener('click', () => toggleCombo('city-pop', 'city-btn'));
el('tech-btn').addEventListener('click', () => toggleCombo('tech-pop', 'tech-btn'));
document.addEventListener('click', (e) => {
  if (!e.target.closest('.combo')) closeCombos();
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  closeCombos();
  if (!el('seat-sheet').hidden) el('seat-sheet').hidden = true;
});

el('cinema-tabs').addEventListener('click', async (e) => {
  const b = e.target.closest('.ptab');
  if (!b) return;
  el('cinema-tabs').querySelectorAll('.ptab').forEach((x) => x.classList.toggle('is-active', x === b));
  state.cinemaScope = b.dataset.scope;
  if (state.cinemaScope === 'near' && !state.coords) await requestLocation();
  renderCinemas();
});

el('film-tabs').addEventListener('click', (e) => {
  const b = e.target.closest('.ptab');
  if (!b) return;
  el('film-tabs').querySelectorAll('.ptab').forEach((x) => x.classList.toggle('is-active', x === b));
  state.filmScope = b.dataset.scope;
  renderFilms();
});

document.querySelectorAll('.topnav-btn').forEach((b) =>
  b.addEventListener('click', () => showTab(b.dataset.tab)),
);
document.querySelectorAll('[data-close-sheet]').forEach((b) =>
  b.addEventListener('click', () => (el('seat-sheet').hidden = true)),
);
el('scan-cancel').addEventListener('click', () => {
  stopScan();
  toast('Tarama durduruldu.');
});
el('clear-expired').addEventListener('click', async () => {
  const r = await api('/api/follows/clear-expired', { method: 'POST' });
  toast(r.removed ? `${r.removed} geçmiş seans kaldırıldı.` : 'Kaldırılacak geçmiş seans yok.');
  loadFollows();
});

async function requestLocation() {
  if (!navigator.geolocation) {
    toast('Konum desteklenmiyor.');
    return;
  }
  try {
    const pos = await new Promise((resolve, reject) =>
      navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 8000 }),
    );
    state.coords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    await loadCinemas();
  } catch {
    toast('Konum alınamadı; mesafeye göre sıralanamıyor.');
  }
}

boot().catch((err) => {
  el('cinema-list').innerHTML = errorBox('Başlatılamadı', err.message);
});
