(function () {
  const data = window.DB_CATALOG_DATA || { items: [], gearDrops: [], dungeons: [], counts: {}, levels: [] };
  const state = {
    view: 'items',
    search: '',
    filters: {
      category: '',
      className: '',
      type: '',
      rarity: '',
      level: '',
      realm: '',
      dungeon: '',
      source: ''
    },
    sortKey: 'name',
    sortDir: 'asc'
  };

  const columnsByView = {
    items: [
      ['category', 'Category'],
      ['id', 'ID'],
      ['name', 'Name'],
      ['levelRank', 'Level/Rank'],
      ['rarity', 'Rarity'],
      ['className', 'Class'],
      ['type', 'Type'],
      ['realm', 'Realm/Category'],
      ['source', 'Source'],
      ['dungeons', 'Dungeons'],
      ['detailsText', 'Details']
    ],
    gear: [
      ['id', 'ID'],
      ['name', 'Gear'],
      ['className', 'Class'],
      ['type', 'Slot'],
      ['level', 'Level'],
      ['rarity', 'Rarity'],
      ['realm', 'Realm'],
      ['source', 'Drop Source'],
      ['dungeons', 'Dungeons'],
      ['detailsText', 'Runes']
    ],
    dungeons: [
      ['label', 'Dungeon'],
      ['region', 'Region'],
      ['level', 'Level'],
      ['hardLevel', 'Hard'],
      ['gearCount', 'Gear'],
      ['realms', 'Realms'],
      ['bosses', 'Bosses'],
      ['gearIds', 'Gear IDs']
    ]
  };

  const controls = {
    summary: document.getElementById('dataset-summary'),
    stats: document.getElementById('stats-row'),
    search: document.getElementById('search-input'),
    view: document.getElementById('view-filter'),
    category: document.getElementById('category-filter'),
    className: document.getElementById('class-filter'),
    type: document.getElementById('type-filter'),
    rarity: document.getElementById('rarity-filter'),
    level: document.getElementById('level-filter'),
    realm: document.getElementById('realm-filter'),
    dungeon: document.getElementById('dungeon-filter'),
    source: document.getElementById('source-filter'),
    reset: document.getElementById('reset-filters'),
    exportCsv: document.getElementById('export-csv'),
    head: document.getElementById('table-head'),
    body: document.getElementById('table-body')
  };

  function toText(value) {
    if (Array.isArray(value)) return value.join(', ');
    if (value === null || value === undefined) return '';
    return String(value);
  }

  function levelRank(row) {
    if (row.level !== null && row.level !== undefined && row.level !== '') return row.level;
    if (row.rank !== null && row.rank !== undefined && row.rank !== '') return `Rank ${row.rank}`;
    return '';
  }

  function detailsText(row) {
    if (!row || !row.details) return '';
    return Object.entries(row.details)
      .filter(([, value]) => value !== '' && value !== null && value !== undefined && value !== false)
      .map(([key, value]) => `${key}: ${value}`)
      .join('; ');
  }

  function rowValue(row, key) {
    if (key === 'levelRank') return levelRank(row);
    if (key === 'detailsText') return detailsText(row);
    return row[key];
  }

  function renderCell(row, key) {
    const value = rowValue(row, key);
    if (key === 'dungeons' || key === 'realms' || key === 'bosses') {
      const values = Array.isArray(value) ? value : toText(value).split(',').map((item) => item.trim()).filter(Boolean);
      if (!values.length) return '<span class="muted">None</span>';
      return `<div class="pill-list">${values.map((item) => `<span class="pill">${escapeHtml(item)}</span>`).join('')}</div>`;
    }
    if (key === 'gearIds') {
      return Array.isArray(value) ? value.join(', ') : escapeHtml(toText(value));
    }
    if (key === 'rarity') {
      const className = `rarity-${toText(value).toLowerCase()}`;
      return `<span class="${className}">${escapeHtml(toText(value))}</span>`;
    }
    if (key === 'detailsText' && row.details && row.details.color) {
      return `<span class="swatch" style="background:${escapeHtml(String(row.details.color))}"></span>${escapeHtml(value)}`;
    }
    return escapeHtml(toText(value));
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function uniqueValues(rows, getter) {
    return [...new Set(rows.map(getter).flat().map(toText).map((item) => item.trim()).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }

  function setOptions(select, values, label) {
    const current = select.value;
    select.innerHTML = `<option value="">All ${label}</option>` + values
      .map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`)
      .join('');
    select.value = values.includes(current) ? current : '';
  }

  function currentRowsBase() {
    if (state.view === 'gear') return data.gearDrops || [];
    if (state.view === 'dungeons') return data.dungeons || [];
    return data.items || [];
  }

  function searchHaystack(row) {
    return [
      row.category,
      row.id,
      row.code,
      row.name,
      row.label,
      row.className,
      row.type,
      row.rarity,
      row.realm,
      row.kingdom,
      row.source,
      row.region,
      row.dungeons,
      row.realms,
      row.bosses,
      row.gearIds,
      detailsText(row)
    ].map(toText).join(' ').toLowerCase();
  }

  function rowMatchesFilters(row) {
    if (state.search && !searchHaystack(row).includes(state.search)) return false;
    if (state.view !== 'dungeons') {
      if (state.filters.category && row.category !== state.filters.category) return false;
      if (state.filters.className && row.className !== state.filters.className) return false;
      if (state.filters.type && row.type !== state.filters.type) return false;
      if (state.filters.rarity && row.rarity !== state.filters.rarity) return false;
      if (state.filters.level && String(levelRank(row)) !== state.filters.level) return false;
      if (state.filters.realm && row.realm !== state.filters.realm && row.kingdom !== state.filters.realm) return false;
      if (state.filters.dungeon && !(row.dungeons || []).includes(state.filters.dungeon)) return false;
      if (state.filters.source && row.source !== state.filters.source) return false;
      return true;
    }

    if (state.filters.level && String(row.level) !== state.filters.level && String(row.hardLevel) !== state.filters.level) {
      return false;
    }
    if (state.filters.realm && !(row.realms || []).includes(state.filters.realm)) return false;
    return true;
  }

  function compareRows(a, b) {
    const aValue = rowValue(a, state.sortKey);
    const bValue = rowValue(b, state.sortKey);
    const direction = state.sortDir === 'asc' ? 1 : -1;
    if (typeof aValue === 'number' && typeof bValue === 'number') return (aValue - bValue) * direction;
    return toText(aValue).localeCompare(toText(bValue), undefined, { numeric: true }) * direction;
  }

  function filteredRows() {
    return currentRowsBase().filter(rowMatchesFilters).sort(compareRows);
  }

  function populateFilters() {
    const rows = currentRowsBase();
    setOptions(controls.category, uniqueValues(rows, (row) => row.category), 'categories');
    setOptions(controls.className, uniqueValues(rows, (row) => row.className), 'classes');
    setOptions(controls.type, uniqueValues(rows, (row) => row.type), 'types');
    setOptions(controls.rarity, uniqueValues(rows, (row) => row.rarity), 'rarities');
    setOptions(controls.level, uniqueValues(rows, (row) => state.view === 'dungeons' ? [row.level, row.hardLevel].filter(Boolean) : levelRank(row)), 'levels');
    setOptions(controls.realm, uniqueValues(rows, (row) => state.view === 'dungeons' ? row.realms : [row.realm, row.kingdom]), 'realms');
    setOptions(controls.dungeon, uniqueValues(data.gearDrops || [], (row) => row.dungeons), 'dungeons');
    setOptions(controls.source, uniqueValues(rows, (row) => row.source), 'sources');

    const itemOnly = state.view !== 'dungeons';
    controls.category.disabled = !itemOnly;
    controls.className.disabled = !itemOnly;
    controls.type.disabled = !itemOnly;
    controls.rarity.disabled = !itemOnly;
    controls.dungeon.disabled = state.view === 'dungeons';
    controls.source.disabled = !itemOnly;
  }

  function renderStats(rows) {
    const counts = state.view === 'dungeons'
      ? {
          Showing: rows.length,
          Dungeons: data.dungeons.length,
          Gear: data.gearDrops.length
        }
      : {
          Showing: rows.length,
          Gear: data.counts.Gear || 0,
          Mounts: data.counts.Mount || 0,
          Pets: data.counts.Pet || 0,
          Dyes: data.counts.Dye || 0,
          Materials: data.counts.Material || 0,
          Spells: data.counts.Spell || 0
        };

    controls.stats.innerHTML = Object.entries(counts)
      .map(([label, value]) => `<div class="stat"><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></div>`)
      .join('');
  }

  function renderTable(rows) {
    const columns = columnsByView[state.view];
    controls.head.innerHTML = `<tr>${columns.map(([key, label]) => {
      const marker = state.sortKey === key ? (state.sortDir === 'asc' ? ' ▲' : ' ▼') : '';
      return `<th data-key="${key}">${escapeHtml(label + marker)}</th>`;
    }).join('')}</tr>`;

    if (!rows.length) {
      controls.body.innerHTML = `<tr><td class="empty" colspan="${columns.length}">No rows match the current filters.</td></tr>`;
      return;
    }

    controls.body.innerHTML = rows.map((row) => `<tr>${columns.map(([key]) => `<td>${renderCell(row, key)}</td>`).join('')}</tr>`).join('');
  }

  function render() {
    populateFilters();
    const rows = filteredRows();
    renderStats(rows);
    renderTable(rows);
    controls.summary.textContent = `${data.items.length.toLocaleString()} rows from game data, ${data.gearDrops.length.toLocaleString()} mapped gear drops, generated ${new Date(data.generatedAt).toLocaleString()}`;
  }

  function updateFilter(key, value) {
    state.filters[key] = value;
    render();
  }

  function exportCsv() {
    const columns = columnsByView[state.view];
    const rows = filteredRows();
    const csvRows = [
      columns.map(([, label]) => label),
      ...rows.map((row) => columns.map(([key]) => toText(rowValue(row, key))))
    ];
    const csv = csvRows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `dungeon-blitz-${state.view}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  controls.search.addEventListener('input', () => {
    state.search = controls.search.value.trim().toLowerCase();
    render();
  });
  controls.view.addEventListener('change', () => {
    state.view = controls.view.value;
    state.sortKey = state.view === 'dungeons' ? 'level' : 'name';
    for (const key of Object.keys(state.filters)) state.filters[key] = '';
    render();
  });
  controls.category.addEventListener('change', () => updateFilter('category', controls.category.value));
  controls.className.addEventListener('change', () => updateFilter('className', controls.className.value));
  controls.type.addEventListener('change', () => updateFilter('type', controls.type.value));
  controls.rarity.addEventListener('change', () => updateFilter('rarity', controls.rarity.value));
  controls.level.addEventListener('change', () => updateFilter('level', controls.level.value));
  controls.realm.addEventListener('change', () => updateFilter('realm', controls.realm.value));
  controls.dungeon.addEventListener('change', () => updateFilter('dungeon', controls.dungeon.value));
  controls.source.addEventListener('change', () => updateFilter('source', controls.source.value));
  controls.reset.addEventListener('click', () => {
    controls.search.value = '';
    state.search = '';
    for (const key of Object.keys(state.filters)) state.filters[key] = '';
    render();
  });
  controls.exportCsv.addEventListener('click', exportCsv);
  controls.head.addEventListener('click', (event) => {
    const header = event.target.closest('th');
    if (!header) return;
    const key = header.dataset.key;
    if (!key) return;
    if (state.sortKey === key) {
      state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      state.sortKey = key;
      state.sortDir = 'asc';
    }
    render();
  });

  render();
}());
