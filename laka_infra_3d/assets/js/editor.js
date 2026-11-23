/*
 * LAKA Infra 3D – gemelo digital de data center para Zabbix 7.0 – 8.0
 * © LAKA Soluciones Tecnológicas
 * Autor: Willian Tola
 * Licencia GPLv3
 *
 * Editor de sala dentro del widget: filas y racks, ubicación de hosts y pasivos U por U,
 * plantillas e importación/exportación CSV y JSON. Guarda en la configuración del módulo.
 */

class LakaInfra3DEditor {

	static TEMPLATES = [
		{id: 'closet', title: 'Cuarto de comunicaciones', text: '1 rack de pared de 12U.', layout: 2,
			rows: [['1', 1, 12]]},
		{id: 'small', title: 'Sala pequeña', text: '1 fila de 4 racks de 42U.', layout: 2,
			rows: [['A', 4, 42]]},
		{id: 'medium', title: 'Sala mediana', text: '2 filas enfrentadas de 5 racks de 42U, con pasillo frío.', layout: 0,
			rows: [['A', 5, 42], ['B', 5, 42]]},
		{id: 'dc', title: 'Data center', text: '4 filas de 10 racks de 42U en dos pasillos fríos.', layout: 0,
			rows: [['A', 10, 42], ['B', 10, 42], ['C', 10, 42], ['D', 10, 42]]}
	];

	static TYPES = ['server', 'network', 'storage', 'ups', 'pdu', 'patch', 'other'];

	constructor(host, data, callbacks = {}) {
		this.host = host;
		this.data = data;
		this.cb = callbacks;
		this.tab = 'room';
		this.dirty = false;
		this.selectedRack = null;
		this.selectedItem = null;	// {kind: 'host'|'passive', id}
		this.armed = null;			// {kind: 'host', id} | {kind: 'passive', item}
		this.face = 'front';
		this.message = null;
		this.selectedObject = null;
		this.armedObject = null;
		this.drag = null;

		this.draft = this.initialDraft();
		this.hosts = this.knownHosts();

		// Cableado, configuración de equipos y normas (assets/js/editor-cabling.js).
		if (typeof this.cabInit === 'function') {
			this.cabInit();
		}

		this.el = document.createElement('div');
		this.el.className = 'laka3d-editor';
		this.host.appendChild(this.el);

		this.onClick = (e) => this.click(e);
		this.onChange = (e) => this.change(e);
		this.onInput = (e) => this.input(e);
		this.el.addEventListener('click', this.onClick);
		this.el.addEventListener('change', this.onChange);
		this.el.addEventListener('input', this.onInput);
		this.onKey = (e) => {
			if (e.target.dataset && e.target.dataset.field === 'ms-input') {
				this.msKey(e);
			}
			else if (e.key === 'Escape' && this.msPopup) {
				e.preventDefault();
				this.msPopup = null;
				this.render();
			}
		};
		this.el.addEventListener('keydown', this.onKey);
		// Sugerencias del selector: mousedown para elegir antes de que el campo pierda el foco.
		this.onMsDown = (e) => {
			const li = e.target.closest('[data-ms-pick]');

			if (li) {
				e.preventDefault();

				const input = li.closest('.laka3d-ms-box').querySelector('.laka3d-ms-input');
				const it = (this.msItems || [])[parseInt(li.dataset.msPick, 10)];

				if (it) {
					this.msAdd(input.dataset.context, input.dataset.ms, [it], true);
				}
			}
		};
		this.onMsOut = (e) => {
			if (e.target.classList && e.target.classList.contains('laka3d-ms-input')) {
				const box = e.target.parentElement.querySelector('.laka3d-ms-suggest');

				setTimeout(() => {
					if (document.activeElement !== e.target) {
						this.msHide(box);
					}
				}, 150);
			}
		};
		this.el.addEventListener('mousedown', this.onMsDown);
		this.el.addEventListener('focusout', this.onMsOut);
		this.onPointerDown = (e) => this.planPointerDown(e);
		this.onPointerMove = (e) => this.planPointerMove(e);
		this.onPointerUp = () => this.planPointerUp();
		this.el.addEventListener('pointerdown', this.onPointerDown);
		this.el.addEventListener('pointermove', this.onPointerMove);
		this.el.addEventListener('pointerup', this.onPointerUp);
		this.el.addEventListener('pointercancel', this.onPointerUp);

		this.render();
	}

	t(text, ...args) {
		let out = (this.data.i18n && this.data.i18n[text]) || text;

		args.forEach((arg, i) => {
			out = out.replace(`%${i + 1}$s`, arg).replace(`%${i + 1}$d`, arg);
		});

		return out;
	}

	static esc(value) {
		return String(value ?? '').replace(/[&<>"']/g, (c) => ({
			'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
		}[c]));
	}

	typeName(type) {
		return this.t({server: 'Servidor', network: 'Red', storage: 'Storage', ups: 'UPS', pdu: 'PDU',
			patch: 'Patch panel', other: 'Otro'}[type] || 'Otro');
	}

	defaultUnits() {
		return (this.data.cfg && this.data.cfg.rack_units) || 42;
	}

	// ---------------------------------------------------------------- modelo

	/**
	 * Borrador inicial: la distribución guardada más los racks que hoy se ven en la sala
	 * (por tags o por el campo de texto), para que el editor arranque con lo que el usuario ve.
	 */
	initialDraft() {
		const saved = JSON.parse(JSON.stringify(this.data.editor.layout));
		const draft = {
			rev: saved.rev || 0,
			layout: saved.layout ?? null,
			rows: saved.rows.slice(),
			racks: saved.racks.slice(),
			placements: Object.assign({}, saved.placements),
			passives: saved.passives.slice(),
			objects: (saved.objects || []).map((o) => Object.assign({}, o)),
			room: Object.assign({w: 0, d: 0}, saved.room || {}),
			site: saved.site || '',
			aisle: saved.aisle || null,
			contain: saved.contain || 'none',
			flips: (saved.flips || []).slice(),
			energy: LakaInfra3DEditor.energyOf(saved.energy)
		};
		const known = new Set(draft.racks.map((r) => r.name.toLowerCase()));
		const current = (this.data.racks || []).slice().sort((a, b) => a.row_index - b.row_index || a.index - b.index);

		for (const rack of current) {
			// Los racks de pared no tienen fila.
			if (rack.mount === 'wall') {
				continue;
			}

			if (!draft.rows.includes(rack.row_label)) {
				draft.rows.push(rack.row_label);
			}

			if (!known.has(rack.name.toLowerCase())) {
				draft.racks.push({name: rack.name, units: rack.units, row: rack.row_label, pos: rack.index + 1,
					kind: rack.kind || 'rack', width: rack.width || 0.6, hostid: '', key: ''});
				known.add(rack.name.toLowerCase());
			}
		}

		for (const rack of draft.racks) {
			if (rack.mount === 'wall') {
				rack.row = '';
				continue;
			}

			if (rack.row === '') {
				rack.row = draft.rows[0] || 'A';
			}

			if (!draft.rows.includes(rack.row)) {
				draft.rows.push(rack.row);
			}
		}

		this.renumber(draft);

		return draft;
	}

	/**
	 * Hosts que el editor conoce: los que ya están en la sala y los que todavía no tienen ubicación.
	 */
	knownHosts() {
		const map = new Map();

		for (const d of this.data.devices || []) {
			if (!d.passive) {
				map.set(d.id, {id: d.id, name: d.name, host: d.host, type: d.type, src: d.src,
					tag: d.src === 'tag' ? {rack: d.rack, u: d.u, n: d.n, face: d.face, type: d.type} : null
				});
			}
		}

		for (const h of this.data.editor.unplaced || []) {
			if (!map.has(h.id)) {
				map.set(h.id, {id: h.id, name: h.name, host: h.host, type: h.type, src: 'none', tag: null});
			}
		}

		return map;
	}

	/** Ubicación efectiva de un host: la del editor, o la de sus tags, o ninguna. */
	placementOf(id) {
		if (this.draft.placements[id]) {
			return this.draft.placements[id];
		}

		const h = this.hosts.get(id);

		return h && h.tag ? h.tag : null;
	}

	/** Equipos (hosts y pasivos) de un rack en el borrador. */
	itemsOf(rackName) {
		const items = [];

		for (const h of this.hosts.values()) {
			const p = this.placementOf(h.id);

			if (p && p.rack === rackName && p.u) {
				items.push({kind: 'host', id: h.id, name: h.name, u: p.u, n: p.n, face: p.face, type: p.type,
					w: p.w || 0, kg: p.kg || 0, src: this.draft.placements[h.id] ? 'layout' : 'tag'
				});
			}
		}

		this.draft.passives.forEach((p, i) => {
			if (p.rack === rackName) {
				items.push({kind: 'passive', id: String(i), name: p.name, u: p.u, n: p.n, face: p.face, type: p.type,
					w: p.w || 0, kg: p.kg || 0, src: 'passive'
				});
			}
		});

		return items;
	}

	unplacedHosts() {
		return [...this.hosts.values()].filter((h) => !this.placementOf(h.id))
			.sort((a, b) => a.name.localeCompare(b.name, undefined, {numeric: true}));
	}

	rack(name) {
		return this.draft.racks.find((r) => r.name === name) || null;
	}

	/** Posiciones correlativas (1, 2, 3…) dentro de cada fila. */
	renumber(draft = this.draft) {
		for (const row of draft.rows) {
			draft.racks.filter((r) => r.row === row)
				.sort((a, b) => (a.pos ?? 1e9) - (b.pos ?? 1e9))
				.forEach((r, i) => {
					r.pos = i + 1;
				});
		}
	}

	nextRackName() {
		let max = 0;
		let prefix = 'R';
		let width = 2;

		for (const r of this.draft.racks) {
			const m = /^(.*?)(\d+)$/.exec(r.name);

			if (m && parseInt(m[2], 10) >= max) {
				max = parseInt(m[2], 10);
				prefix = m[1];
				width = m[2].length;
			}
		}

		let n = max + 1;
		let name;

		do {
			name = prefix + String(n).padStart(width, '0');
			n++;
		} while (this.rack(name));

		return name;
	}

	nextRowName() {
		const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

		for (const ch of letters) {
			if (!this.draft.rows.includes(ch)) {
				return ch;
			}
		}

		return String(this.draft.rows.length + 1);
	}

	/** ¿Entra un equipo de alto n desde la U u en la cara indicada sin pisar a otro? */
	fits(rackName, u, n, face, ignore = null) {
		const rack = this.rack(rackName);
		const units = rack ? rack.units : this.defaultUnits();

		if (u < 1 || u + n - 1 > units) {
			return false;
		}

		for (const it of this.itemsOf(rackName)) {
			if (ignore && it.kind === ignore.kind && it.id === ignore.id) {
				continue;
			}

			if ((it.face === 'back') !== (face === 'back')) {
				continue;
			}

			if (u <= it.u + it.n - 1 && it.u <= u + n - 1) {
				return false;
			}
		}

		return true;
	}

	touch() {
		this.dirty = true;
	}

	// ---------------------------------------------------------------- vista

	render() {
		const esc = LakaInfra3DEditor.esc;
		const t = this.t.bind(this);
		const tabs = [['room', 'Sala'], ['devices', 'Equipos'], ['infra', 'Infraestructura'], ['import', 'Importar / Exportar'],
			['templates', 'Plantillas']];

		if (typeof this.renderNorms === 'function') {
			tabs.splice(3, 0, ['norms', 'Normas']);
		}

		// Historial, permiso por sala y respaldo completo (assets/js/editor-admin.js).
		if (typeof this.renderAdmin === 'function' && this.data.editor && this.data.editor.admin) {
			tabs.push(['admin', 'Historial y respaldo']);
		}
		// En una sala nueva (respuesta vacía) el nombre viene en "room", no en "cfg".
		const room = (this.data.cfg && this.data.cfg.room) || this.data.room || '';
		const site = this.draft.site ? `${this.draft.site} · ` : '';

		let body = '';

		switch (this.tab) {
			case 'room':
				body = this.renderRoom();
				break;

			case 'devices':
				body = this.renderDevices();
				break;

			case 'import':
				body = this.renderImport();
				break;

			case 'templates':
				body = this.renderTemplates();
				break;

			case 'infra':
				body = this.renderInfra();
				break;

			case 'norms':
				body = this.renderNorms();
				break;

			case 'admin':
				body = this.renderAdmin();
				break;
		}

		this.el.innerHTML = `
			<div class="laka3d-ed-head">
				<div class="laka3d-ed-title"><strong>${esc(t('Editor de sala'))}</strong><span class="laka3d-muted">${esc(site)}${esc(room !== '' ? room : t('Sala principal'))}${this.dirty ? ' · ' + esc(t('cambios sin guardar')) : ''}</span></div>
				<div class="laka3d-ed-actions">
					<button type="button" class="laka3d-btn" data-ed="cancel">${esc(t('Cancelar'))}</button>
					<button type="button" class="laka3d-btn laka3d-btn-primary" data-ed="save">${esc(t('Guardar'))}</button>
				</div>
			</div>
			<div class="laka3d-ed-tabs" role="tablist">
				${tabs.map(([id, label]) => `<button type="button" role="tab" data-tab="${id}" aria-selected="${this.tab === id}">${esc(t(label))}</button>`).join('')}
			</div>
			${this.message ? `<div class="laka3d-ed-msg laka3d-ed-msg-${esc(this.message.kind)}" role="status">${esc(this.message.text)}</div>` : ''}
			<div class="laka3d-ed-body">${body}</div>
			${this.renderMsPopup()}`;
	}

	// Rack de pared: hasta 27U, fondos de 350, 450 y 600 mm (igual que Layout.php).
	static WALL_MAX_U = 27;
	static WALL_DEPTHS = [0.35, 0.45, 0.6];

	/**
	 * Uso del almacenamiento del módulo (module.config) según la base de Zabbix: MySQL / MariaDB admite unos
	 * 64 KB por campo; PostgreSQL, mucho más. La configuración se guarda comprimida.
	 */
	renderStorage() {
		const esc = LakaInfra3DEditor.esc;
		const t = this.t.bind(this);
		const st = (this.data.editor || {}).storage;

		if (!st || !st.max) {
			return '';
		}

		const pct = Math.min(100, Math.round(st.bytes / st.max * 100));
		const kb = (b) => (b / 1024).toLocaleString(undefined, {maximumFractionDigits: b < 10240 ? 1 : 0});
		const db = st.db === 'postgresql' ? 'PostgreSQL' : 'MySQL / MariaDB';
		const level = pct >= 90 ? 'is-bad' : (pct >= 75 ? 'is-warn' : '');
		const ratio = st.compressed && st.bytes ? Math.max(1, Math.round(st.raw / st.bytes * 10) / 10) : 1;

		return `
			<section class="laka3d-ed-storage ${level}">
				<span>${esc(t('Almacenamiento del módulo'))} · ${esc(db)}</span>
				<span class="laka3d-ed-storage-bar"><i style="width:${Math.max(2, pct)}%"></i></span>
				<span><strong>${esc(kb(st.bytes))} KB</strong> ${esc(t('de'))} ${esc(st.max >= 1048576 ? `${Math.round(st.max / 1048576)} MB` : `${kb(st.max)} KB`)} (${st.bytes > 0 && pct < 1 ? '<1' : pct} %)${st.compressed ? ` · ${esc(t('comprimido %1$s:1', String(ratio)))}` : ` · ${esc(t('sin compresión: falta zlib en PHP'))}`}</span>
				${pct >= 75 ? `<span class="laka3d-muted">${esc(t('Cerca del límite de MySQL: quita cables, salas o sitios sin uso, o usa Zabbix sobre PostgreSQL.'))}</span>` : ''}
			</section>`;
	}

	/** Configuración de eficiencia y ambiente, con sus valores por defecto (igual que Layout::energy). */
	static energyOf(e) {
		const x = e && typeof e === 'object' ? e : {};
		const ids = (v) => (Array.isArray(v) ? v.map(String).filter((s) => /^[A-Za-z0-9_-]{1,16}$/.test(s)) : []).slice(0, 8);

		return {
			total: ids(x.total),
			it: x.it === 'ups' ? 'ups' : 'pdu',
			it_objs: ids(x.it_objs),
			ashrae: ['A1', 'A2', 'A3', 'A4', 'H1'].includes(x.ashrae) ? x.ashrae : 'A1',
			rh: Number(x.rh) === 70 ? 70 : 60,
			renew: ids(x.renew),
			reuse: ids(x.reuse),
			water: ids(x.water),
			cef: Math.max(0, Math.min(2, Number(x.cef) || 0)),
			green: Math.round(Math.max(0, Math.min(100, Number(x.green) || 0))),
			wclass: ['W17', 'W27', 'W32', 'W40', 'W45', 'W+'].includes(x.wclass) ? x.wclass : '',
			cool_n: Math.round(Math.max(0, Math.min(50, Number(x.cool_n) || 0))),
			isp_n: Math.round(Math.max(0, Math.min(10, Number(x.isp_n) || 0))),
			space: x.space === 'edge' ? 'edge' : 'dc'
		};
	}

	/**
	 * Tarjeta "Eficiencia y ambiente" de la pestaña Sala: qué mide la energía total y la de TI (PUE,
	 * ISO/IEC 30134-2) y la clase ASHRAE de los equipos con el límite de humedad.
	 */
	renderEnergyCard() {
		const esc = LakaInfra3DEditor.esc;
		const t = this.t.bind(this);
		const e = this.draft.energy = LakaInfra3DEditor.energyOf(this.draft.energy);
		// Medidores posibles: los elementos de la cadena eléctrica vinculados a Zabbix (y los ya elegidos).
		const meters = this.draft.objects.filter((o) => o.id && o.hostid
			&& (['transformer', 'generator', 'ats', 'ups', 'panel'].includes(o.kind) || e.total.includes(o.id)));
		const ups = meters.filter((o) => o.kind === 'ups');
		const check = (field, o) => `<label class="laka3d-ed-check"><input type="checkbox" data-en="${field}" value="${esc(o.id)}"${e[field].includes(o.id) ? ' checked' : ''}> ${esc(o.name || this.kindName(o.kind))} <span class="laka3d-muted">· ${esc(this.kindName(o.kind))}</span></label>`;

		return `
			<section class="laka3d-ed-card laka3d-ed-energy">
				<div class="laka3d-ed-cardhead"><strong>${esc(t('Eficiencia y ambiente'))}</strong></div>
				<p class="laka3d-muted">${esc(t('PUE = energía total de la instalación ÷ energía de TI (ISO/IEC 30134-2). Se usan los elementos de la sala vinculados a un host de Zabbix con su ítem de potencia.'))}</p>
				<div class="laka3d-ed-props laka3d-ed-props-col">
					<div><strong>${esc(t('Energía total de la instalación'))}</strong>
						${meters.length ? `<div class="laka3d-ed-checks">${meters.map((o) => check('total', o)).join('')}</div>`
							: `<p class="laka3d-muted">${esc(t('Agrega la acometida o el tablero general en Infraestructura y vincúlalo a su medidor en Zabbix.'))}</p>`}
					</div>
					<label>${esc(t('Energía de TI'))} <select data-en="it">
						<option value="pdu"${e.it === 'pdu' ? ' selected' : ''}>${esc(t('Salida de las PDU de los racks (categoría 2)'))}</option>
						<option value="ups"${e.it === 'ups' ? ' selected' : ''}>${esc(t('Salida de las UPS (categoría 1)'))}</option>
					</select></label>
					${e.it === 'ups' ? (ups.length ? `<div class="laka3d-ed-checks">${ups.map((o) => check('it_objs', o)).join('')}</div>`
						: `<p class="laka3d-muted">${esc(t('No hay UPS de sala vinculadas a Zabbix.'))}</p>`) : ''}
				</div>
				<h5>${esc(t('Otros indicadores ISO/IEC 30134'))}</h5>
				<p class="laka3d-muted">${esc(t('REF = energía renovable ÷ energía total · ERF = energía reutilizada ÷ energía total · WUE = litros de agua ÷ kWh de TI · CUE = kg de CO₂ ÷ kWh de TI.'))}</p>
				<div class="laka3d-ed-props laka3d-ed-props-col">
					${this.energyPick('renew', t('Generación renovable propia (REF)'), ['solar', 'transformer', 'generator', 'panel'], t('Agrega un "Inversor solar / renovable" en Infraestructura y vincúlalo a su medidor de potencia.'))}
					${this.energyPick('reuse', t('Energía reutilizada (ERF)'), ['panel', 'cdu', 'solar', 'transformer'], t('Vincula el medidor de calor o energía reutilizada (por ejemplo, el de una CDU o un tablero) a su ítem de potencia.'))}
					${this.energyPick('water', t('Medidor de agua (WUE)'), ['water'], t('Agrega un "Medidor de agua" en Infraestructura y vincúlalo a su ítem de caudal (L/min, m³/h) o volumen (L, m³).'))}
				</div>
				<div class="laka3d-ed-props">
					<label>${esc(t('Factor de emisión de la red (kg CO₂/kWh)'))} <input type="number" min="0" max="2" step="0.001" data-en="cef" value="${e.cef || ''}" placeholder="0.000"></label>
					<label>${esc(t('Energía de la red comprada como renovable (%)'))} <input type="number" min="0" max="100" step="1" data-en="green" value="${e.green || ''}" placeholder="0"></label>
				</div>
				<h5>${esc(t('Enfriamiento líquido y redundancia'))}</h5>
				<div class="laka3d-ed-props">
					<label>${esc(t('Clase de agua de la instalación (ASHRAE)'))} <select data-en="wclass">
						<option value="">${esc(t('Sin enfriamiento líquido'))}</option>
						${Object.entries(LakaInfra3DEnergy.WCLASS).map(([c, max]) => `<option value="${c}"${e.wclass === c ? ' selected' : ''}>${c} · ${c === 'W+' ? '> 45' : '2–' + max} °C</option>`).join('')}
					</select></label>
					<label>${esc(t('Unidades de aire necesarias para la carga (N)'))} <input type="number" min="0" max="50" step="1" data-en="cool_n" value="${e.cool_n || ''}" placeholder="0"></label>
					<label>${esc(t('Proveedores de telecomunicaciones (acometidas)'))} <input type="number" min="0" max="10" step="1" data-en="isp_n" value="${e.isp_n || ''}" placeholder="0"></label>
					<label>${esc(t('Tipo de espacio'))} <select data-en="space">
						<option value="dc"${e.space === 'dc' ? ' selected' : ''}>${esc(t('Data center / sala de cómputo'))}</option>
						<option value="edge"${e.space === 'edge' ? ' selected' : ''}>${esc(t('Micro data center de borde (edge)'))}</option>
					</select></label>
				</div>
				<div class="laka3d-ed-props">
					<label>${esc(t('Clase ASHRAE de los equipos'))} <select data-en="ashrae">
						${['A1', 'A2', 'A3', 'A4', 'H1'].map((c) => `<option value="${c}"${e.ashrae === c ? ' selected' : ''}>${c} · ${LakaInfra3DEnergy.RECOMMENDED[c].join('–')} °C${LakaInfra3DEnergy.ALLOWABLE[c] ? ` (${esc(t('permitido'))} ${LakaInfra3DEnergy.ALLOWABLE[c].join('–')} °C)` : ''}</option>`).join('')}
					</select></label>
					<label>${esc(t('Humedad máxima'))} <select data-en="rh">
						<option value="60"${e.rh === 60 ? ' selected' : ''}>60 %</option>
						<option value="70"${e.rh === 70 ? ' selected' : ''}>${esc(t('70 % (contaminantes bajos)'))}</option>
					</select></label>
				</div>
			</section>`;
	}

	/** Lista de elementos vinculados para un indicador (los de los tipos indicados y los ya elegidos). */
	energyPick(field, label, kinds, empty) {
		const esc = LakaInfra3DEditor.esc;
		const e = this.draft.energy;
		const list = this.draft.objects.filter((o) => o.id && o.hostid && (kinds.includes(o.kind) || e[field].includes(o.id)));

		return `<div><strong>${esc(label)}</strong>
			${list.length ? `<div class="laka3d-ed-checks">${list.map((o) => `<label class="laka3d-ed-check"><input type="checkbox" data-en="${field}" value="${esc(o.id)}"${e[field].includes(o.id) ? ' checked' : ''}> ${esc(o.name || this.kindName(o.kind))} <span class="laka3d-muted">· ${esc(this.kindName(o.kind))}</span></label>`).join('')}</div>`
				: `<p class="laka3d-muted">${esc(empty)}</p>`}</div>`;
	}

	/** Cambios de la tarjeta de eficiencia y ambiente. */
	energyChange(el) {
		const e = this.draft.energy = LakaInfra3DEditor.energyOf(this.draft.energy);
		const f = el.dataset.en;

		if (['cef', 'green', 'cool_n', 'isp_n'].includes(f)) {
			e[f] = el.value;
			this.draft.energy = LakaInfra3DEditor.energyOf(e);
			this.touch();

			return;
		}

		if (['wclass', 'space'].includes(f)) {
			e[f] = el.value;
			this.draft.energy = LakaInfra3DEditor.energyOf(e);
			this.touch();
			this.render();

			return;
		}

		if (['total', 'it_objs', 'renew', 'reuse', 'water'].includes(f)) {
			e[f] = el.checked ? [...new Set([...e[f], el.value])].slice(0, 8) : e[f].filter((id) => id !== el.value);
		}
		else if (f === 'it') {
			e.it = el.value === 'ups' ? 'ups' : 'pdu';
		}
		else if (f === 'ashrae') {
			e.ashrae = el.value;
		}
		else if (f === 'rh') {
			e.rh = Number(el.value) === 70 ? 70 : 60;
		}

		this.touch();
		this.render();
	}

	/** Coordenadas guardadas del sitio de la sala (texto "lat, lon"), o vacío. */
	siteCoordsText() {
		const site = (this.data.sites || []).find((x) => x.name === this.draft.site);

		return site && typeof site.lat === 'number' && typeof site.lon === 'number' ? `${site.lat}, ${site.lon}` : '';
	}

	/**
	 * Guarda al momento la ubicación exacta del sitio (no espera al botón Guardar: la ubicación es del sitio,
	 * compartida por todas sus salas). Vacío = quita la ubicación.
	 */
	async saveSiteCoords(raw) {
		const editor = this.data.editor;
		const text = String(raw || '').trim();
		const c = text === '' ? null : LakaInfra3DSites.parseCoords(text);

		if (text !== '' && !c) {
			this.flash('error', this.t('Coordenadas no válidas. Ej.: -16.4955, -68.1336 o 16°29\'44"S 68°08\'01"W.'));
			this.render();

			return;
		}

		const body = new URLSearchParams({site: this.draft.site, lat: c ? c.lat.toFixed(5) : '', lon: c ? c.lon.toFixed(5) : '',
			lang: this.data.lang || 'es', _csrf_token: editor.site_csrf || ''
		});

		try {
			const response = await fetch(editor.site_url, {method: 'POST',
				headers: {'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'}, body: body.toString()
			});
			const json = await response.json();

			if (!json.success) {
				throw new Error((json.error && json.error.messages || []).join(' '));
			}

			let site = (this.data.sites || []).find((x) => x.name === this.draft.site);

			if (!site) {
				site = {name: this.draft.site, rooms: []};
				(this.data.sites = this.data.sites || []).push(site);
			}

			site.lat = json.coords ? json.coords.lat : null;
			site.lon = json.coords ? json.coords.lon : null;
			this.flash('info', json.message);
		}
		catch (error) {
			this.flash('error', error.message || this.t('No se pudo guardar la ubicación.'));
		}

		this.render();
	}

	/** Separa un FS guardado (ej. 6B, 12AA) en piso y sala. */
	static parseFs(fs) {
		const m = /^(\d{1,3})([A-Z]{1,3})$/.exec(String(fs || '').toUpperCase());

		return m ? {floor: m[1], space: m[2]} : {floor: String(fs || ''), space: ''};
	}

	/**
	 * Arma el FS: piso (números) + sala (letras). Una sala escrita como número pasa a letra
	 * (1 = A, 2 = B … 27 = AA), así "piso 2 sala 2" queda 2B y no 22, que se confundiría con el piso 22.
	 */
	static buildFs(floor, space) {
		const f = String(floor || '').replace(/[^0-9]/g, '').slice(0, 3);
		let sp = String(space || '').toUpperCase().replace(/[^0-9A-Z]/g, '');

		if (/^\d+$/.test(sp)) {
			let n = Math.min(parseInt(sp, 10) || 0, 702);
			let out = '';

			while (n > 0) {
				out = String.fromCharCode(65 + (n - 1) % 26) + out;
				n = Math.floor((n - 1) / 26);
			}

			sp = out;
		}
		else {
			sp = sp.replace(/[0-9]/g, '');
		}

		return (f + sp.slice(0, 3)).slice(0, 8);
	}

	renderRoom() {
		const esc = LakaInfra3DEditor.esc;
		const t = this.t.bind(this);
		const layoutValue = this.draft.layout === null ? '' : String(this.draft.layout);
		let html = `
			<div class="laka3d-ed-row">
				<label>${esc(t('Disposición'))}
					<select data-field="layout">
						<option value=""${layoutValue === '' ? ' selected' : ''}>${esc(t('La del widget'))}</option>
						<option value="0"${layoutValue === '0' ? ' selected' : ''}>${esc(t('Filas enfrentadas'))}</option>
						<option value="1"${layoutValue === '1' ? ' selected' : ''}>${esc(t('Filas paralelas'))}</option>
						<option value="2"${layoutValue === '2' ? ' selected' : ''}>${esc(t('Una sola fila'))}</option>
					</select>
				</label>
				<label>${esc(t('Pasillo central'))}
					<select data-field="aisle">
						<option value=""${!this.draft.aisle ? ' selected' : ''}>${esc(t('El del widget'))}</option>
						<option value="cold"${this.draft.aisle === 'cold' ? ' selected' : ''}>${esc(t('Frío (frentes enfrentados)'))}</option>
						<option value="hot"${this.draft.aisle === 'hot' ? ' selected' : ''}>${esc(t('Caliente (espaldas enfrentadas)'))}</option>
					</select>
				</label>
				<label>${esc(t('Contención'))}
					<select data-field="contain">
						<option value="none"${(this.draft.contain || 'none') === 'none' ? ' selected' : ''}>${esc(t('Sin contención'))}</option>
						<option value="cold"${this.draft.contain === 'cold' ? ' selected' : ''}>${esc(t('Pasillo frío contenido'))}</option>
						<option value="hot"${this.draft.contain === 'hot' ? ' selected' : ''}>${esc(t('Pasillo caliente contenido'))}</option>
					</select>
				</label>
				<label>${esc(t('Medidas de la sala (m)'))}
					<input type="number" min="0" max="300" step="0.5" value="${this.draft.room.w || ''}" placeholder="${esc(t('auto'))}" data-field="room-w" class="laka3d-ed-num" aria-label="${esc(t('Ancho'))}">
					×
					<input type="number" min="0" max="300" step="0.5" value="${this.draft.room.d || ''}" placeholder="${esc(t('auto'))}" data-field="room-d" class="laka3d-ed-num" aria-label="${esc(t('Fondo'))}">
				</label>
				<label>${esc(t('Sitio o región'))}
					<input type="text" maxlength="64" list="laka3d-ed-sites" value="${esc(this.draft.site || '')}" placeholder="${esc(t('Ej.: Data center La Paz'))}" data-field="site" class="laka3d-ed-short">
				</label>
				${this.data.editor && this.data.editor.site_url && this.draft.site ? `<label>${esc(t('Coordenadas del sitio'))}
					<input type="text" maxlength="200" data-field="site-coords" value="${esc(this.siteCoordsText())}" placeholder="-16.4955, -68.1336" class="laka3d-ed-coords" title="${esc(t('Latitud, longitud en grados decimales, en grados y minutos, o un enlace de Google Maps'))}">
				</label>` : ''}
				<datalist id="laka3d-ed-sites">${(this.data.sites || []).map((x) => x.name).filter(Boolean).map((n) => `<option value="${esc(n)}"></option>`).join('')}</datalist>
				<span class="laka3d-muted">${esc(t('%1$s filas · %2$s racks', String(this.draft.rows.length), String(this.draft.racks.filter((r) => (r.kind || 'rack') === 'rack').length)))}</span>
			</div>`;

		if (this.renderFsCard) {
			html += this.renderFsCard();
			html += this.renderEnergyCard();
			html += this.renderStorage();
		}

		if (!this.draft.rows.length) {
			html += `<p class="laka3d-muted">${esc(t('La sala está vacía. Agrega una fila o usa una plantilla.'))}</p>`;
		}
		else {
			html += this.renderAisleSummary();
		}

		this.draft.rows.forEach((row, ri) => {
			const racks = this.draft.racks.filter((r) => r.row === row).sort((a, b) => a.pos - b.pos);

			html += `
				<section class="laka3d-ed-card">
					<div class="laka3d-ed-cardhead">
						<label>${esc(t('Fila'))} <input type="text" maxlength="16" value="${esc(row)}" data-field="row-name" data-row="${ri}" class="laka3d-ed-short"></label>
						<span class="laka3d-muted">${esc(this.rowFacingText(row))}</span>
						<span class="laka3d-ed-grow"></span>
						<button type="button" class="laka3d-btn" data-ed="row-flip" data-row="${ri}" aria-pressed="${(this.draft.flips || []).includes(row)}" title="${esc(t('Gira la fila 180°: el frente pasa a mirar al otro lado'))}">⇅ ${esc(t('Invertir fila'))}</button>
						<button type="button" class="laka3d-btn laka3d-btn-icon" data-ed="row-up" data-row="${ri}" aria-label="${esc(t('Subir fila'))}"${ri === 0 ? ' disabled' : ''}>↑</button>
						<button type="button" class="laka3d-btn laka3d-btn-icon" data-ed="row-down" data-row="${ri}" aria-label="${esc(t('Bajar fila'))}"${ri === this.draft.rows.length - 1 ? ' disabled' : ''}>↓</button>
						<button type="button" class="laka3d-btn laka3d-btn-icon" data-ed="row-del" data-row="${ri}" aria-label="${esc(t('Eliminar fila'))}">✕</button>
					</div>
					<div class="laka3d-ed-strip">
						${racks.map((r) => (r.kind || 'rack') !== 'rack'
							? `<button type="button" class="laka3d-ed-rack laka3d-ed-cooler laka3d-ed-slot-${esc(r.kind)}${this.selectedRack === r.name ? ' is-selected' : ''}" data-ed="rack-select" data-rack="${esc(r.name)}"><strong>${LakaInfra3DEditor.slotIcon(r)} ${esc(r.name)}</strong><span>${esc(this.slotName(r))}</span></button>`
							: `<button type="button" class="laka3d-ed-rack${this.selectedRack === r.name ? ' is-selected' : ''}" data-ed="rack-select" data-rack="${esc(r.name)}"><strong>${esc(r.name)}</strong><span>${r.units}U · ${this.itemsOf(r.name).length}</span></button>`).join('')}
						<button type="button" class="laka3d-ed-rack laka3d-ed-add" data-ed="rack-add" data-row="${ri}">+ ${esc(t('Rack'))}</button>
						<button type="button" class="laka3d-ed-rack laka3d-ed-add" data-ed="slot-add" data-kind="cooler" data-row="${ri}">+ ${esc(t('Aire'))}</button>
						<button type="button" class="laka3d-ed-rack laka3d-ed-add" data-ed="slot-add" data-kind="ups" data-row="${ri}">+ ${esc(t('UPS'))}</button>
						<button type="button" class="laka3d-ed-rack laka3d-ed-add" data-ed="slot-add" data-kind="battery" data-row="${ri}">+ ${esc(t('Baterías'))}</button>
					</div>
					${racks.some((r) => r.name === this.selectedRack) ? this.renderRackProps(this.rack(this.selectedRack)) : ''}
				</section>`;
		});

		html += `<button type="button" class="laka3d-btn" data-ed="row-add">+ ${esc(t('Fila'))}</button>`;

		// Racks de pared: gabinetes colgados fuera de las filas (ej. llegada de un proveedor de internet).
		const wallRacks = this.draft.racks.filter((r) => r.mount === 'wall');
		const selWall = wallRacks.find((r) => r.name === this.selectedRack);

		html += `
			<section class="laka3d-ed-card laka3d-ed-wallracks">
				<div class="laka3d-ed-cardhead">
					<strong>${esc(t('Racks de pared'))}</strong>
					<span class="laka3d-muted">${esc(t('Gabinetes colgados en la pared, fuera de las filas: por ejemplo la llegada de un proveedor de internet o un rack de piso.'))}</span>
				</div>
				<div class="laka3d-ed-strip">
					${wallRacks.map((r) => `<button type="button" class="laka3d-ed-rack laka3d-ed-wall${this.selectedRack === r.name ? ' is-selected' : ''}" data-ed="rack-select" data-rack="${esc(r.name)}"><strong>▤ ${esc(r.name)}</strong><span>${r.units}U · ${this.itemsOf(r.name).length}</span></button>`).join('')}
					<button type="button" class="laka3d-ed-rack laka3d-ed-add" data-ed="wall-rack-add">+ ${esc(t('Rack de pared'))}</button>
				</div>
				${selWall ? this.renderRackProps(selWall) : ''}
			</section>`;

		return html;
	}

	renderRackProps(rack) {
		const esc = LakaInfra3DEditor.esc;
		const t = this.t.bind(this);
		const sameRow = this.draft.racks.filter((r) => r.row === rack.row);

		return `
			<div class="laka3d-ed-props">
				<label>${esc(t('Nombre'))} <input type="text" maxlength="32" value="${esc(rack.name)}" data-field="rack-name" class="laka3d-ed-short"></label>
				${rack.kind === 'cooler' ? `<label>${esc(t('Tipo de aire'))}
					<select data-field="slot-model">
						<option value="inrow"${rack.model !== 'crac' ? ' selected' : ''}>${esc(t('En fila (tipo rack, entre racks)'))}</option>
						<option value="crac"${rack.model === 'crac' ? ' selected' : ''}>${esc(t('Perimetral grande (fin de pasillo)'))}</option>
					</select></label>` : ''}
				${rack.kind === 'cooler' && rack.model === 'crac' ? '' : `<label>${esc(t('Alto (U)'))} <input type="number" min="4" max="${rack.mount === 'wall' ? LakaInfra3DEditor.WALL_MAX_U : 60}" value="${rack.units}" data-field="rack-units" class="laka3d-ed-num"></label>`}
				<label>${esc(t('Ancho'))}
					<select data-field="rack-width">${LakaInfra3DEditor.slotWidths(rack).map((w) => `<option value="${w}"${Math.abs((rack.width || 0.6) - w) < 0.01 ? ' selected' : ''}>${Math.round(w * 1000)} mm</option>`).join('')}</select>
				</label>
				${rack.mount === 'wall' ? this.renderWallRackFields(rack) : `<label>${esc(t('Fila'))}
					<select data-field="rack-row">${this.draft.rows.map((r) => `<option value="${esc(r)}"${r === rack.row ? ' selected' : ''}>${esc(r)}</option>`).join('')}</select>
				</label>`}
				<div class="laka3d-ed-btns">
					${rack.mount === 'wall' ? '' : `<button type="button" class="laka3d-btn laka3d-btn-icon" data-ed="rack-left" aria-label="${esc(t('Mover a la izquierda'))}"${rack.pos <= 1 ? ' disabled' : ''}>◀</button>
					<button type="button" class="laka3d-btn laka3d-btn-icon" data-ed="rack-right" aria-label="${esc(t('Mover a la derecha'))}"${rack.pos >= sameRow.length ? ' disabled' : ''}>▶</button>`}
					${(rack.kind || 'rack') !== 'rack' ? '' : `<button type="button" class="laka3d-btn" data-ed="rack-devices">${esc(t('Ver equipos'))}</button>`}
					<button type="button" class="laka3d-btn laka3d-btn-danger" data-ed="rack-del">${esc((rack.kind || 'rack') !== 'rack' ? t('Eliminar') : t('Eliminar rack'))}</button>
				</div>
			</div>
			${(rack.kind || 'rack') !== 'rack' ? '' : this.renderRackCapacity(rack)}
			${(rack.kind || 'rack') !== 'rack' ? `
				<div class="laka3d-ed-props laka3d-ed-props-col">
					<label>${esc(t('Host de Zabbix'))} <span class="laka3d-ed-hostname">${esc(this.hostName(rack.hostid) || t('Sin vincular'))}</span></label>
					<label>${esc(t('Clave del ítem'))} <input type="text" maxlength="255" value="${esc(rack.key || '')}" placeholder="${esc(this.defaultKey(rack.kind === 'cooler' ? 'inrow' : rack.kind))}" data-field="rack-key"></label>
				</div>
				${this.renderHostSearch('cooler')}` : ''}`;
	}

	/** Campos del rack de pared: pared, distancia desde la esquina, altura de la base y fondo. */
	renderWallRackFields(rack) {
		const esc = LakaInfra3DEditor.esc;
		const t = this.t.bind(this);
		const walls = [['n', 'Pared de arriba'], ['s', 'Pared de abajo'], ['w', 'Pared izquierda'], ['e', 'Pared derecha']];
		const H = rack.units * 0.04445 + 0.1;
		const base = rack.height > 0 ? rack.height : Math.max(0.3, 2.0 - H);

		return `
				<label>${esc(t('Pared'))} <select data-field="rack-wall">${walls.map(([v, l]) => `<option value="${v}"${(rack.wall || 'n') === v ? ' selected' : ''}>${esc(t(l))}</option>`).join('')}</select></label>
				<label>${esc(t('Distancia desde la esquina (m)'))} <input type="number" min="0" max="300" step="0.1" value="${rack.offset || 0}" data-field="rack-offset" class="laka3d-ed-num"></label>
				<label>${esc(t('Altura de la base (m)'))} <input type="number" min="0" max="2.5" step="0.05" value="${rack.height || ''}" placeholder="${base.toFixed(2)}" data-field="rack-height" class="laka3d-ed-num"></label>
				<label>${esc(t('Fondo'))} <select data-field="rack-depth">${LakaInfra3DEditor.WALL_DEPTHS.map((v) => `<option value="${v}"${Math.abs((rack.depth || 0.45) - v) < 0.01 ? ' selected' : ''}>${Math.round(v * 1000)} mm</option>`).join('')}</select></label>
				<span class="laka3d-muted">${esc(t('Techo del gabinete a %1$s m del piso.', (base + H).toFixed(2)))}</span>`;
	}

	/** Capacidad del rack: potencia disponible, carga máxima y PDU de 0U (verticales) que lo alimentan. */
	renderRackCapacity(rack) {
		const esc = LakaInfra3DEditor.esc;
		const t = this.t.bind(this);
		const pdus = rack.pdus || [];

		return `
			<div class="laka3d-ed-props">
				<label>${esc(t('Capacidad eléctrica (kW)'))} <input type="number" min="0" max="100" step="0.5" value="${rack.power_kw || ''}" placeholder="0" data-field="rack-kw" class="laka3d-ed-num"></label>
				<label>${esc(t('Carga máxima (kg)'))} <input type="number" min="0" max="3000" step="50" value="${rack.max_kg || ''}" placeholder="0" data-field="rack-kg" class="laka3d-ed-num"></label>
			</div>
			<div class="laka3d-ed-props">
				<label>${esc(t('PDU verticales dibujadas'))}
					<select data-field="rack-vpdu">${[0, 1, 2, 3, 4].map((n) => `<option value="${n}"${(rack.vpdu || 0) === n ? ' selected' : ''}>${n}</option>`).join('')}</select>
				</label>
				${rack.vpdu > 0 ? `<label>${esc(t('Tomas por PDU'))}
					<select data-field="rack-outlets">${[8, 12, 16, 20, 24, 30, 36, 42, 48].map((n) => `<option value="${n}"${(rack.outlets || 24) === n ? ' selected' : ''}>${n}</option>`).join('')}</select>
				</label>` : ''}
			</div>
			${this.renderPowerFields ? Array.from({length: rack.vpdu || 0}, (_, i) => this.renderPowerFields(`v:${rack.name.toLowerCase()}:${'ABCD'[i]}`, `${t('PDU vertical')} ${'ABCD'[i]}`)).join('') : ''}
			<div class="laka3d-ed-props laka3d-ed-props-col">
				<label>${esc(t('Hosts de las PDU verticales (energía medida)'))}
					<span class="laka3d-ed-chips">${pdus.map((id) => `<span class="laka3d-ed-chip">${esc(this.hostName(id))} <button type="button" class="laka3d-link" data-ed="pdu-del" data-id="${esc(id)}" aria-label="${esc(t('Quitar'))}">✕</button></span>`).join('') || `<span class="laka3d-muted">${esc(t('Ninguna. Las PDU ubicadas en U con tipo PDU se cuentan solas.'))}</span>`}</span>
				</label>
			</div>
			${pdus.length < 8 ? this.renderHostSearch('pdu') : ''}`;
	}

	renderDevices() {
		const esc = LakaInfra3DEditor.esc;
		const t = this.t.bind(this);

		if (!this.draft.racks.length) {
			return `<p class="laka3d-muted">${esc(t('Primero crea los racks en la pestaña Sala.'))}</p>`;
		}

		const realRacks = this.draft.racks.filter((r) => (r.kind || 'rack') === 'rack');

		if (!realRacks.length) {
			return `<p class="laka3d-muted">${esc(t('Primero crea los racks en la pestaña Sala.'))}</p>`;
		}

		if (!this.rack(this.selectedRack) || (this.rack(this.selectedRack).kind || 'rack') !== 'rack') {
			this.selectedRack = realRacks[0].name;
		}

		const rack = this.rack(this.selectedRack);
		const items = this.itemsOf(rack.name);
		const px = rack.units > 45 ? 14 : 16;
		let grid = '';

		for (let u = rack.units; u >= 1; u--) {
			grid += `<button type="button" class="laka3d-ed-u" data-ed="u" data-u="${u}" style="height:${px}px" aria-label="U${u}"><span>${u}</span></button>`;
		}

		let blocks = '';

		for (const it of items) {
			const own = (it.face === 'back') === (this.face === 'back');
			const top = (rack.units - (it.u + it.n - 1)) * px;
			const sel = this.selectedItem && this.selectedItem.kind === it.kind && this.selectedItem.id === it.id;

			blocks += `<button type="button" class="laka3d-ed-dev laka3d-ed-k-${it.kind}${own ? '' : ' is-other'}${sel ? ' is-selected' : ''}" data-ed="item" data-kind="${it.kind}" data-id="${esc(it.id)}" style="top:${top}px;height:${it.n * px - 2}px"><span>${esc(it.name)}</span><em>${esc(this.typeName(it.type))}${it.src === 'tag' ? ' · tag' : ''}</em></button>`;
		}

		const unplaced = this.unplacedHosts();
		const filter = (this.filterText || '').toLowerCase();
		const shown = unplaced.filter((h) => !filter || h.name.toLowerCase().includes(filter) || h.host.toLowerCase().includes(filter))
			.slice(0, 300);

		const armedText = this.armed
			? (this.armed.kind === 'host'
				? t('Elige la U de abajo donde va %1$s.', this.hosts.get(this.armed.id).name)
				: t('Elige la U de abajo donde va %1$s.', this.armed.item.name))
			: t('Elige un host sin ubicar o un equipo del rack.');

		return `
			<div class="laka3d-ed-row">
				<label>${esc(t('Rack'))}
					<select data-field="dev-rack">${realRacks.map((r) => `<option value="${esc(r.name)}"${r.name === rack.name ? ' selected' : ''}>${esc(r.name)} · ${esc(t('Fila'))} ${esc(r.row)}</option>`).join('')}</select>
				</label>
				<div class="laka3d-seg laka3d-seg-sm" role="group" aria-label="${esc(t('Cara del rack'))}">
					<button type="button" data-ed="face" data-face="front" aria-pressed="${this.face === 'front'}">${esc(t('Frente'))}</button>
					<button type="button" data-ed="face" data-face="back" aria-pressed="${this.face === 'back'}">${esc(t('Atrás'))}</button>
				</div>
			</div>
			<p class="laka3d-ed-hint${this.armed ? ' is-armed' : ''}">${esc(armedText)}${this.armed ? ` <button type="button" class="laka3d-link" data-ed="disarm">${esc(t('Cancelar'))}</button>` : ''}</p>
			<div class="laka3d-ed-devices">
				<div class="laka3d-ed-elev">
					<div class="laka3d-ed-ugrid">${grid}</div>
					<div class="laka3d-ed-blocks" style="height:${rack.units * px}px">${blocks}</div>
				</div>
				<div class="laka3d-ed-sidecol">
					${this.selectedItem ? this.renderItemProps(rack) : ''}
					<div class="laka3d-seg laka3d-seg-sm" role="group">
						<button type="button" data-ed="src" data-src="unplaced" aria-pressed="${this.hostSrc !== 'zabbix'}">${esc(t('Sin ubicar'))} (${unplaced.length})</button>
						<button type="button" data-ed="src" data-src="zabbix" aria-pressed="${this.hostSrc === 'zabbix'}">${esc(t('Buscar en Zabbix'))}</button>
					</div>
					${this.hostSrc === 'zabbix' ? this.renderHostSearch('device') : `
					<div class="laka3d-ed-card">
						<div class="laka3d-ed-cardhead"><strong>${esc(t('Sin ubicar'))} (${unplaced.length})</strong></div>
						<input type="search" class="laka3d-ed-search" data-field="filter" placeholder="${esc(t('Buscar host…'))}" value="${esc(this.filterText || '')}">
						<div class="laka3d-ed-list">
							${shown.map((h) => `<button type="button" class="laka3d-ed-host${this.armed && this.armed.kind === 'host' && this.armed.id === h.id ? ' is-armed' : ''}" data-ed="arm-host" data-id="${esc(h.id)}"><span>${esc(h.name)}</span><em>${esc(this.typeName(h.type))}</em></button>`).join('') || `<p class="laka3d-muted">${esc(t('Todos los hosts tienen ubicación.'))}</p>`}
						</div>
						${(this.data.editor.unplaced_total || 0) > (this.data.editor.unplaced || []).length ? `<p class="laka3d-muted">${esc(t('Se muestran los primeros %1$s hosts. Filtra por grupo en el widget para ver el resto.', String((this.data.editor.unplaced || []).length)))}</p>` : ''}
					</div>`}
					<div class="laka3d-ed-card">
						<div class="laka3d-ed-cardhead"><strong>${esc(t('Agregar pasivo'))}</strong></div>
						<div class="laka3d-ed-props">
							<label>${esc(t('Nombre'))} <input type="text" maxlength="64" data-field="new-passive-name" value="${esc(this.newPassive?.name || '')}" placeholder="pp-01" class="laka3d-ed-short"></label>
							<label>${esc(t('Tipo'))} <select data-field="new-passive-type">${[['patch', 'Patch panel'], ['cable', 'Organizador de cables'], ['blank', 'Panel ciego'], ['pdu', 'PDU'], ['other', 'Otro']].map(([ty, label]) => `<option value="${ty}"${(this.newPassive?.type || 'patch') === ty ? ' selected' : ''}>${esc(t(label))}</option>`).join('')}</select></label>
							<label>${esc(t('Alto (U)'))} <input type="number" min="1" max="20" data-field="new-passive-n" value="${this.newPassive?.n || 1}" class="laka3d-ed-num"></label>
							<button type="button" class="laka3d-btn" data-ed="arm-passive">${esc(t('Ubicar en el rack'))}</button>
						</div>
					</div>
				</div>
			</div>
			${this.pc && typeof this.renderPanelConfig === 'function' ? this.renderPanelConfig() : ''}`;
	}

	renderItemProps(rack) {
		const esc = LakaInfra3DEditor.esc;
		const t = this.t.bind(this);
		const it = this.itemsOf(rack.name).find((x) => x.kind === this.selectedItem.kind && x.id === this.selectedItem.id);

		if (!it) {
			this.selectedItem = null;

			return '';
		}

		const types = it.kind === 'passive' ? ['patch', 'pdu', 'other'] : LakaInfra3DEditor.TYPES;

		return `
			<div class="laka3d-ed-card laka3d-ed-selected">
				<div class="laka3d-ed-cardhead"><strong>${esc(it.name)}</strong><span class="laka3d-muted">${it.kind === 'passive' ? esc(t('Equipo pasivo')) : (it.src === 'tag' ? esc(t('Ubicado por tags')) : esc(t('Ubicado en el editor')))}</span></div>
				<div class="laka3d-ed-props">
					<label>U <input type="number" min="1" max="${rack.units}" value="${it.u}" data-field="item-u" class="laka3d-ed-num"></label>
					<label>${esc(t('Alto (U)'))} <input type="number" min="1" max="20" value="${it.n}" data-field="item-n" class="laka3d-ed-num"></label>
					<label>${esc(t('Cara'))} <select data-field="item-face"><option value="front"${it.face !== 'back' ? ' selected' : ''}>${esc(t('Frente'))}</option><option value="back"${it.face === 'back' ? ' selected' : ''}>${esc(t('Atrás'))}</option></select></label>
					<label>${esc(t('Tipo'))} <select data-field="item-type">${types.map((ty) => `<option value="${ty}"${it.type === ty ? ' selected' : ''}>${esc(this.typeName(ty))}</option>`).join('')}</select></label>
					${it.kind === 'passive' ? `<label>${esc(t('Nombre'))} <input type="text" maxlength="64" value="${esc(it.name)}" data-field="item-name" class="laka3d-ed-short"></label>` : ''}
					<label>${esc(t('Consumo (W)'))} <input type="number" min="0" max="50000" step="10" value="${it.w || ''}" placeholder="0" data-field="item-w" class="laka3d-ed-num"></label>
					<label>${esc(t('Peso (kg)'))} <input type="number" min="0" max="2000" step="0.5" value="${it.kg || ''}" placeholder="0" data-field="item-kg" class="laka3d-ed-num"></label>
				</div>
				<div class="laka3d-ed-btns">
					<button type="button" class="laka3d-btn" data-ed="item-move">${esc(t('Mover a otra U'))}</button>
					${it.src === 'tag' ? '' : `<button type="button" class="laka3d-btn laka3d-btn-danger" data-ed="item-remove">${esc(it.kind === 'passive' ? t('Eliminar') : t('Quitar del rack'))}</button>`}
				</div>
				${it.src === 'tag' ? `<p class="laka3d-muted">${esc(t('Si lo cambias aquí, el editor manda sobre sus tags.'))}</p>` : ''}
				${typeof this.renderItemConfig === 'function' ? this.renderItemConfig(it, rack) : ''}
			</div>`;
	}

	renderImport() {
		const esc = LakaInfra3DEditor.esc;
		const t = this.t.bind(this);

		return `
			<div class="laka3d-ed-card">
				<div class="laka3d-ed-cardhead"><strong>${esc(t('Importar CSV'))}</strong></div>
				<p class="laka3d-muted">${esc(t('Una línea por equipo:'))} <code>rack;u;alto;host;tipo;cara;fila;consumo_w;peso_kg</code> ${esc(t('(consumo y peso son opcionales).'))} ${esc(t('Separador ; , o tabulación. La primera línea puede ser el encabezado. Sin host, o con tipo patch, se crea un pasivo.'))}</p>
				<textarea class="laka3d-ed-text" data-field="csv" rows="8" placeholder="R01;42;1;sw-core01;red&#10;R01;30;2;srv-app01;servidor&#10;R01;41;1;;patch;;A">${esc(this.csvText || '')}</textarea>
				<div class="laka3d-ed-btns">
					<label class="laka3d-btn laka3d-file">${esc(t('Abrir archivo…'))}<input type="file" accept=".csv,.txt,.json,text/csv,application/json" data-field="file"></label>
					<button type="button" class="laka3d-btn" data-ed="csv-add">${esc(t('Importar y agregar'))}</button>
					<button type="button" class="laka3d-btn" data-ed="csv-replace">${esc(t('Importar y reemplazar'))}</button>
				</div>
				${this.importReport ? `<ul class="laka3d-ed-report">${this.importReport.map((r) => `<li class="${r.ok ? '' : 'is-error'}">${esc(r.text)}</li>`).join('')}</ul>` : ''}
			</div>
			<div class="laka3d-ed-card">
				<div class="laka3d-ed-cardhead"><strong>${esc(t('Exportar'))}</strong></div>
				<p class="laka3d-muted">${esc(t('El CSV incluye todos los equipos de la sala (también los ubicados por tags). El JSON es la distribución completa del editor, para respaldo o para copiarla a otra sala.'))}</p>
				<div class="laka3d-ed-btns">
					<button type="button" class="laka3d-btn" data-ed="export-csv">${esc(t('Descargar CSV'))}</button>
					<button type="button" class="laka3d-btn" data-ed="export-json">${esc(t('Descargar JSON'))}</button>
				</div>
			</div>`;
	}

	renderTemplates() {
		const esc = LakaInfra3DEditor.esc;
		const t = this.t.bind(this);

		return `
			<p class="laka3d-muted">${esc(t('Una plantilla reemplaza las filas y los racks. Los equipos ya ubicados se conservan si su rack sigue existiendo.'))}</p>
			<div class="laka3d-ed-templates">
				${LakaInfra3DEditor.TEMPLATES.map((tpl) => `
					<button type="button" class="laka3d-ed-tpl" data-ed="template" data-id="${tpl.id}">
						<span class="laka3d-ed-tplpic">${tpl.rows.map(([, count]) => `<i style="width:${Math.min(100, count * 10)}%"></i>`).join('')}</span>
						<strong>${esc(t(tpl.title))}</strong>
						<span class="laka3d-muted">${esc(t(tpl.text))}</span>
					</button>`).join('')}
			</div>`;
	}

	// ---------------------------------------------------------------- infraestructura (plano)

	static KINDS = ['crac', 'inrow', 'split', 'ups', 'battery', 'panel', 'sensor', 'door', 'access', 'camera', 'motion', 'smoke',
		'vesda', 'firepanel', 'suppression', 'extinguisher', 'epo', 'light', 'leak', 'ground', 'cdu', 'rdhx', 'wap', 'water',
		'solar'];

	// Paleta de la pestaña Infraestructura por grupos, como los sistemas de un data center (ANSI/TIA-942).
	static KIND_GROUPS = [
		['Climatización y energía', ['crac', 'inrow', 'split', 'transformer', 'generator', 'ats', 'ups', 'battery', 'panel', 'ground',
			'solar']],
		['Enfriamiento líquido', ['cdu', 'rdhx']],
		['Seguridad física', ['door', 'access', 'camera', 'motion', 'wap']],
		['Protección contra incendio', ['smoke', 'vesda', 'firepanel', 'suppression', 'extinguisher', 'epo', 'light']],
		['Ambiente', ['sensor', 'leak', 'water']]
	];

	// Letra del símbolo en el plano de los elementos chicos.
	static KIND_GLYPHS = {sensor: 'T', access: 'A', camera: 'C', motion: 'M', smoke: 'H', vesda: 'V', firepanel: 'F',
		extinguisher: 'E', epo: 'P', light: 'L', ground: '⏚', wap: 'W', water: 'H₂O'};

	/** Medidas en planta (ancho × fondo, en metros) de un objeto, las mismas que usa la vista 3D. */
	static footprint(o) {
		if (LakaInfra3DScene.SMALL_KINDS.includes(o.kind)) {
			return [0.3, 0.3];
		}

		if (o.kind === 'door') {
			return [LakaInfra3DEditor.doorWidth(o) + 0.14, 0.2];
		}

		const dim = LakaInfra3DScene.objectDims(o, null);

		return [dim.w, Math.max(0.2, dim.d)];
	}

	/** Anchos posibles de un lugar de la fila según su tipo. */
	static slotWidths(r) {
		if (r.kind === 'cooler') {
			return r.model === 'crac' ? [1.0, 1.5, 1.8, 2.0, 2.5] : [0.3, 0.6];
		}

		return {ups: [0.6, 0.8, 1.2], battery: [0.6, 0.8, 1.0]}[r.kind] || [0.6, 0.8];
	}

	static slotIcon(r) {
		return {cooler: '❄', ups: '⚡', battery: '▮'}[r.kind] || '';
	}

	slotName(r) {
		if (r.kind === 'cooler') {
			return this.t(r.model === 'crac' ? 'Aire perimetral' : 'Aire en fila');
		}

		return this.t({ups: 'UPS modular', battery: 'Baterías'}[r.kind] || 'Rack');
	}

	kindName(kind) {
		return this.t(LakaInfra3DScene.KIND_NAMES[kind] || kind);
	}

	defaultKey(kind) {
		const temp = (this.data.cfg && this.data.cfg.temp_key) || '*temp*';

		return {ups: '*battery*', battery: '*battery*', panel: '*power*', door: '*door*', camera: 'icmpping', access: 'icmpping',
			motion: 'icmpping', smoke: '*smoke*', vesda: '*smoke*', firepanel: '*alarm*', suppression: '*pressure*',
			leak: '*leak*', extinguisher: '', epo: '', light: '', ground: '', generator: '*fuel*', ats: '*power*',
			transformer: '*power*', wap: 'icmpping', water: '*water*', solar: '*power*'}[kind] ?? temp;
	}

	/** Todos los hosts que se pueden vincular a la infraestructura. */
	infraHosts() {
		const map = new Map();

		for (const h of this.hosts.values()) {
			map.set(h.id, h);
		}

		for (const h of this.data.editor.object_hosts || []) {
			if (!map.has(h.id)) {
				map.set(h.id, h);
			}
		}

		return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, {numeric: true}));
	}

	/**
	 * Posición de los racks del borrador con las mismas reglas que la vista 3D
	 * (filas enfrentadas, paralelas o una sola fila), para dibujar el plano.
	 */
	plan() {
		const W = 0.6;
		const DEP = 1.0;
		const GAP = 0.03;
		const d = this.draft;
		const layout = d.layout ?? ((this.data.cfg && this.data.cfg.layout) || 0);
		const rows = layout === 2 ? ['1'] : d.rows.filter((r) => d.racks.some((x) => x.row === r));
		const racks = [];

		// Mismo plan de filas y pasillos que la vista 3D (sentido de cada fila, pasillos fríos y calientes).
		const rp = LakaInfra3DScene.rowPlan(rows, layout, this.aisleMode(), d.flips || []);
		const extents = [];

		rows.forEach((row, k) => {
			const list = layout === 2
				? d.racks.filter((x) => x.mount !== 'wall').sort((a, b) => d.rows.indexOf(a.row) - d.rows.indexOf(b.row) || a.pos - b.pos)
				: d.racks.filter((r) => r.row === row).sort((a, b) => a.pos - b.pos);
			const {z, facing} = rp.rows[k];

			// Cada lugar suma su ancho (rack 600/800 mm, aire en fila 300 mm, aire perimetral hasta 2,5 m).
			let x = 0;

			for (const r of list) {
				const width = r.width || W;

				racks.push({name: r.name, units: r.units, kind: r.kind || 'rack', width, x: x + width / 2, z, facing});
				x += width + GAP;
			}

			extents.push({x0: 0, x1: Math.max(W, x - GAP)});
		});

		const aisles = rp.aisles.map((a) => {
			const ea = extents[a.a];
			const eb = a.b !== null ? extents[a.b] : ea;

			return Object.assign({}, a, {x0: Math.min(ea.x0, eb.x0), x1: Math.max(ea.x1, eb.x1)});
		});

		// Límites: racks + elementos sueltos + margen, o medidas fijas centradas en los racks.
		const xs = racks.flatMap((r) => [r.x - r.width / 2, r.x + r.width / 2]);
		const zs = racks.flatMap((r) => [r.z - DEP / 2, r.z + DEP / 2]).concat(racks.length ? aisles.flatMap((a) => [a.z0, a.z1]) : []);
		const rb = xs.length
			? {minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs)}
			: {minX: -1, maxX: 1, minZ: -1, maxZ: 1};
		const b = Object.assign({}, rb);

		for (const o of d.objects) {
			if ((o.mount || 'floor') === 'floor') {
				b.minX = Math.min(b.minX, o.x);
				b.maxX = Math.max(b.maxX, o.x);
				b.minZ = Math.min(b.minZ, o.z);
				b.maxZ = Math.max(b.maxZ, o.z);
			}
		}

		b.minX -= 1.5;
		b.maxX += 1.5;
		b.minZ -= 1.5;
		b.maxZ += 1.5;

		const cx = (rb.minX + rb.maxX) / 2;
		const cz = (rb.minZ + rb.maxZ) / 2;

		if (d.room.w > 0) {
			b.minX = cx - d.room.w / 2;
			b.maxX = cx + d.room.w / 2;
		}

		if (d.room.d > 0) {
			b.minZ = cz - d.room.d / 2;
			b.maxZ = cz + d.room.d / 2;
		}

		// Racks de pared: pegados a su pared, con su fondo (no cuentan para los límites de la sala).
		for (const r of d.racks.filter((x) => x.mount === 'wall')) {
			const width = r.width || W;
			const depth = r.depth || 0.45;
			const pos = this.placeObject({mount: 'wall', wall: r.wall || 'n', offset: Math.max(r.offset || 0, width / 2),
				kind: 'rack-wall', _depth: depth}, {bounds: b});
			const facing = {0: 1, 180: -1}[pos.rot] ?? 1;

			racks.push({name: r.name, units: r.units, kind: 'rack', width, depth, x: pos.x, z: pos.z, rot: pos.rot, facing, wall: true});
		}

		return {racks, aisles, bounds: b, W, DEP};
	}

	/**
	 * Resumen de pasillos de la sala (fríos, calientes, contenidos y mixtos). Si hay filas invertidas a mano
	 * que dejan pasillos mixtos en filas enfrentadas, avisa y ofrece volver al patrón uniforme.
	 */
	renderAisleSummary() {
		const esc = LakaInfra3DEditor.esc;
		const t = this.t.bind(this);
		const plan = this.plan();
		const inner = plan.aisles.filter((a) => a.b !== null);
		const contain = this.draft.contain || 'none';
		const count = (type) => plan.aisles.filter((a) => a.type === type).length;
		const contained = inner.filter((a) => a.type === contain).length;
		const mixed = inner.filter((a) => a.type === 'mixed').length;
		const layout = this.draft.layout ?? ((this.data.cfg && this.data.cfg.layout) || 0);
		const flips = (this.draft.flips || []).filter((f) => this.draft.rows.includes(f));
		let html = `<p class="laka3d-muted laka3d-ed-aisles">${esc(t('Pasillos: %1$s fríos · %2$s calientes · %3$s mixtos', String(count('cold')), String(count('hot')), String(count('mixed'))))}${contain !== 'none' ? ' · ' + esc(t('%1$s contenidos', String(contained))) : ''}</p>`;

		if (flips.length && (layout === 0 && mixed > 0 || layout !== 0)) {
			html += `
				<div class="laka3d-ed-msg laka3d-ed-msg-warn">
					<span>${esc(layout === 0 && mixed > 0
						? t('Las filas invertidas (%1$s) dejan pasillos mixtos (frente con espalda): los pasillos no quedan uniformes.', flips.join(', '))
						: t('Filas invertidas a mano: %1$s.', flips.join(', ')))}</span>
					<button type="button" class="laka3d-btn" data-ed="flips-reset">${esc(t('Restablecer sentido de las filas'))}</button>
				</div>`;
		}

		return html;
	}

	/** Hacia dónde mira el frente de una fila en el plano (arriba o abajo), según el plan de filas. */
	rowFacingText(row) {
		const layout = this.draft.layout ?? ((this.data.cfg && this.data.cfg.layout) || 0);

		if (layout === 2) {
			return '';
		}

		const rows = this.draft.rows.filter((r) => this.draft.racks.some((x) => x.row === r));
		const k = rows.indexOf(row);

		if (k < 0) {
			return '';
		}

		const facing = LakaInfra3DScene.rowPlan(rows, layout, this.aisleMode(), this.draft.flips || []).rows[k].facing;

		return facing === 1 ? this.t('Frente hacia abajo ↓') : this.t('Frente hacia arriba ↑');
	}

	/** Pasillo central de la sala: el elegido en el editor o, si no, el del widget. */
	aisleMode() {
		return this.draft.aisle || (this.data.cfg && this.data.cfg.aisle_default) || 'cold';
	}

	/**
	 * Posición de un elemento en el plano según su montaje (igual que en la vista 3D).
	 */
	placeObject(o, plan) {
		const b = plan.bounds;

		if (o.mount === 'rack') {
			const r = plan.racks.find((x) => x.name === o.rack);

			if (r) {
				const side = (o.face === 'back' ? -1 : 1) * r.facing;

				return {x: r.x + 0.2 * r.facing, z: r.z + side * (plan.DEP / 2 + 0.12), rot: 0, fixed: true};
			}
		}

		if (o.mount === 'wall') {
			const depth = o._depth || LakaInfra3DScene.objectDims(o, null).d;
			const inset = depth / 2 + (o.kind === 'door' ? 0 : 0.02);
			const len = o.wall === 'n' || o.wall === 's' ? b.maxX - b.minX : b.maxZ - b.minZ;
			const half = o.kind === 'door' ? LakaInfra3DEditor.doorWidth(o) / 2 + 0.07 : 0;
			const off = Math.min(Math.max(o.offset || 0, half), len - half);

			switch (o.wall) {
				case 's':
					return {x: b.minX + off, z: b.maxZ - inset, rot: 180};

				case 'w':
					return {x: b.minX + inset, z: b.minZ + off, rot: 270};

				case 'e':
					return {x: b.maxX - inset, z: b.minZ + off, rot: 90};

				default:
					return {x: b.minX + off, z: b.minZ + inset, rot: 0};
			}
		}

		return {x: o.x, z: o.z, rot: o.rot};
	}

	static sizeOptions(kind) {
		return {
			suppression: [[1, '1 cilindro'], [2, '2 cilindros'], [3, '3 cilindros']],
			leak: [[1, 'Cable de 2 m'], [2, 'Cable de 5 m'], [3, 'Cable de 10 m']],
			crac: [[1, 'Chico (1,0 m)'], [2, 'Mediano (1,8 m)'], [3, 'Grande (2,5 m)']],
			ups: [[1, 'Torre (0,45 m)'], [2, 'Gabinete (0,8 m)'], [3, 'Modular grande (1,6 m)']],
			battery: [[1, '1 gabinete (0,6 m)'], [2, '2 gabinetes (1,2 m)'], [3, '3 gabinetes (1,8 m)']]
		}[kind] || [[1, '1']];
	}

	static doorWidth(o) {
		return o.leaves === 2 ? 1.8 : 1.0;
	}

	/** Vanos de las puertas empotradas en una pared, medidos desde su esquina. */
	wallOpenings(wall, len) {
		return this.draft.objects
			.filter((o) => o.kind === 'door' && o.mount === 'wall' && (o.wall || 'n') === wall)
			.map((o) => {
				const half = LakaInfra3DEditor.doorWidth(o) / 2 + 0.07;
				const off = Math.min(Math.max(o.offset || 0, half), len - half);

				return [Math.max(0, off - half), Math.min(len, off + half)];
			})
			.sort((a, c) => a[0] - c[0])
			.reduce((acc, h) => {
				const last = acc[acc.length - 1];

				if (last && h[0] <= last[1]) {
					last[1] = Math.max(last[1], h[1]);
				}
				else {
					acc.push(h.slice());
				}

				return acc;
			}, []);
	}

	/**
	 * Símbolo de plano de la puerta: marco en el vano, hoja abierta a 90° y el arco de su recorrido.
	 * En el sistema del objeto, +y es hacia la sala.
	 */
	doorSymbol(o) {
		const W = LakaInfra3DEditor.doorWidth(o);
		const side = o.face === 'back' ? -1 : 1;
		const hinges = o.leaves === 2 ? ['l', 'r'] : [o.hinge || 'l'];
		const r = o.leaves === 2 ? W / 2 : W;
		let out = `<rect class="laka3d-pl-doorframe" x="${-W / 2 - 0.07}" y="-0.1" width="${W + 0.14}" height="0.2"></rect>`;

		for (const h of hinges) {
			const hx = h === 'l' ? -W / 2 : W / 2;
			const dir = h === 'l' ? 1 : -1;
			const pts = [];

			for (let k = 0; k <= 12; k++) {
				const a = (Math.PI / 2) * k / 12;

				pts.push(`${(hx + dir * r * Math.cos(a)).toFixed(3)},${(side * r * Math.sin(a)).toFixed(3)}`);
			}

			out += `<line class="laka3d-pl-leaf" x1="${hx}" y1="0" x2="${hx}" y2="${side * r}"></line>`
				+ `<polyline class="laka3d-pl-swing" points="${pts.join(' ')}"></polyline>`;
		}

		// Área para tocar y arrastrar la puerta.
		return out + `<rect class="laka3d-pl-hit" x="${-W / 2 - 0.1}" y="${Math.min(0, side * r) - 0.1}" width="${W + 0.2}" height="${r + 0.2}"></rect>`;
	}

	/** Pared más cercana a un punto del plano y distancia desde su esquina. */
	nearestWall(p, b) {
		const opts = [
			['n', Math.abs(p.z - b.minZ), p.x - b.minX],
			['s', Math.abs(p.z - b.maxZ), p.x - b.minX],
			['w', Math.abs(p.x - b.minX), p.z - b.minZ],
			['e', Math.abs(p.x - b.maxX), p.z - b.minZ]
		].sort((a, c) => a[1] - c[1]);
		const [wall, , offset] = opts[0];
		const len = wall === 'n' || wall === 's' ? b.maxX - b.minX : b.maxZ - b.minZ;

		return {wall, offset: Math.round(Math.min(Math.max(offset, 0), len) * 10) / 10};
	}

	renderInfra() {
		const esc = LakaInfra3DEditor.esc;
		const t = this.t.bind(this);
		const plan = this.plan();
		const b = plan.bounds;
		const pad = 0.6;

		// La vista incluye la sala y cualquier objeto que haya quedado fuera de sus medidas.
		const view = {minX: b.minX, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ};

		for (const o of this.draft.objects) {
			if ((o.mount || 'floor') === 'floor') {
				view.minX = Math.min(view.minX, o.x - 0.8);
				view.maxX = Math.max(view.maxX, o.x + 0.8);
				view.minZ = Math.min(view.minZ, o.z - 0.8);
				view.maxZ = Math.max(view.maxZ, o.z + 0.8);
			}
		}

		let svg = '';

		svg += `<rect class="laka3d-pl-room" x="${b.minX}" y="${b.minZ}" width="${b.maxX - b.minX}" height="${b.maxZ - b.minZ}"></rect>`;

		// Paredes con el vano de cada puerta empotrada (igual que en la vista 3D).
		for (const wall of ['n', 's', 'w', 'e']) {
			const along = wall === 'n' || wall === 's';
			const len = along ? b.maxX - b.minX : b.maxZ - b.minZ;
			const line = (from, to) => {
				if (to - from < 0.01) {
					return;
				}

				svg += along
					? `<line class="laka3d-pl-wall" x1="${b.minX + from}" y1="${wall === 'n' ? b.minZ : b.maxZ}" x2="${b.minX + to}" y2="${wall === 'n' ? b.minZ : b.maxZ}"></line>`
					: `<line class="laka3d-pl-wall" x1="${wall === 'w' ? b.minX : b.maxX}" y1="${b.minZ + from}" x2="${wall === 'w' ? b.minX : b.maxX}" y2="${b.minZ + to}"></line>`;
			};
			let cursor = 0;

			for (const [h0, h1] of this.wallOpenings(wall, len)) {
				line(cursor, h0);
				cursor = h1;
			}

			line(cursor, len);
		}

		// Pasillos fríos (azul), calientes (rojo) y mixtos; los contenidos llevan borde de contención.
		const contain = this.draft.contain || 'none';

		for (const a of plan.aisles) {
			const contained = a.b !== null && contain === a.type;

			svg += `<rect class="laka3d-pl-aisle laka3d-pl-aisle-${a.type}${contained ? ' is-contained' : ''}" x="${a.x0}" y="${a.z0}" width="${a.x1 - a.x0}" height="${a.z1 - a.z0}"></rect>`;
		}

		for (const r of plan.racks) {
			if (r.wall) {
				// Rack de pared: rectángulo con su fondo, girado según la pared; la línea gruesa marca el frente.
				const hw = r.width / 2;
				const hd = r.depth / 2;

				svg += `<g class="laka3d-pl-rack laka3d-pl-wallrack${this.selectedRack === r.name ? ' is-selected' : ''}" transform="translate(${r.x} ${r.z}) rotate(${r.rot})"><rect x="${-hw}" y="${-hd}" width="${r.width}" height="${r.depth}"></rect>`
					+ `<line x1="${-hw}" y1="${hd}" x2="${hw}" y2="${hd}"></line>`
					+ `<text x="0" y="0.06" transform="rotate(${-r.rot})">${esc(r.name)}</text></g>`;

				continue;
			}

			const front = r.facing === 1 ? r.z + plan.DEP / 2 : r.z - plan.DEP / 2;
			const hw = r.width / 2;

			svg += `<g class="laka3d-pl-rack${r.kind !== 'rack' ? ` laka3d-pl-cooler laka3d-pl-slot-${r.kind}` : ''}"><rect x="${r.x - hw}" y="${r.z - plan.DEP / 2}" width="${r.width}" height="${plan.DEP}"></rect>`
				+ `<line x1="${r.x - hw}" y1="${front}" x2="${r.x + hw}" y2="${front}"></line>`
				+ `<text x="${r.x}" y="${r.z + 0.06}">${esc(r.kind === 'rack' ? r.name : LakaInfra3DEditor.slotIcon(r) + (r.width >= 0.6 ? ' ' + r.name : ''))}</text></g>`;
		}

		this.draft.objects.forEach((o, i) => {
			const [fw, fd] = LakaInfra3DEditor.footprint(o);
			const sel = this.selectedObject === i;
			const {x, z, rot, fixed = false} = this.placeObject(o, plan);

			const glyph = LakaInfra3DEditor.KIND_GLYPHS[o.kind];
			// Cámara: cuña con su campo de visión hacia la sala.
			const fov = o.kind === 'camera' ? `<path class="laka3d-pl-fov" d="M0 0 L-1.4 2.6 A3 3 0 0 0 1.4 2.6 Z"></path>` : '';
			const shape = glyph
				? `${fov}<circle cx="0" cy="0" r="0.16"${o.mount === 'ceiling' ? ' class="is-ceiling"' : ''}></circle><text class="laka3d-pl-glyph" x="0" y="0.06" transform="rotate(${-rot})">${esc(glyph)}</text>`
				: o.kind === 'door' ? this.doorSymbol(o) : `<rect x="${-fw / 2}" y="${-fd / 2}" width="${fw}" height="${fd}"></rect><line x1="${-fw / 2}" y1="${fd / 2}" x2="${fw / 2}" y2="${fd / 2}" class="laka3d-pl-front"></line>`;

			svg += `<g class="laka3d-pl-obj laka3d-pl-${o.kind}${o.mount === 'wall' ? ' is-wall' : ''}${sel ? ' is-selected' : ''}${fixed ? ' is-fixed' : ''}" data-obj="${i}" transform="translate(${x} ${z}) rotate(${rot})">${shape}</g>`
				+ `<text class="laka3d-pl-label" x="${x}" y="${z - Math.max(fw, fd) / 2 - 0.12}">${esc(o.name || this.kindName(o.kind))}</text>`;
		});

		const armedText = this.armedObject
			? t('Toca el plano donde va: %1$s.', this.kindName(this.armedObject))
			: t('Elige un elemento para agregarlo, o arrastra uno del plano para moverlo.');

		return `
			<div class="laka3d-ed-palette laka3d-ed-palgroups">
				${LakaInfra3DEditor.KIND_GROUPS.map(([g, kinds]) => `<div class="laka3d-ed-palgroup"><span class="laka3d-muted">${esc(t(g))}</span><div>${kinds.map((k) => `<button type="button" class="laka3d-btn${this.armedObject === k ? ' is-armed' : ''}" data-ed="obj-arm" data-kind="${k}">+ ${esc(this.kindName(k))}</button>`).join('')}</div></div>`).join('')}
			</div>
			<p class="laka3d-ed-hint${this.armedObject ? ' is-armed' : ''}">${esc(armedText)}${this.armedObject ? ` <button type="button" class="laka3d-link" data-ed="obj-disarm">${esc(t('Cancelar'))}</button>` : ''}</p>
			<div class="laka3d-ed-devices laka3d-ed-infra">
				<div class="laka3d-ed-plan">
					<svg class="laka3d-pl" viewBox="${view.minX - pad} ${view.minZ - pad} ${view.maxX - view.minX + pad * 2} ${view.maxZ - view.minZ + pad * 2}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${esc(t('Plano de la sala'))}">${svg}</svg>
					<p class="laka3d-muted">${esc(t('Vista desde arriba. La línea gruesa marca el frente. Medidas en metros.'))}</p>
				</div>
				<div class="laka3d-ed-sidecol">
					${this.selectedObject !== null && this.draft.objects[this.selectedObject] ? this.renderObjectProps(this.draft.objects[this.selectedObject]) : `<p class="laka3d-muted">${esc(t('%1$s elementos de infraestructura.', String(this.draft.objects.length)))}</p>`}
				</div>
			</div>`;
	}

	renderObjectProps(o) {
		const esc = LakaInfra3DEditor.esc;
		const t = this.t.bind(this);
		const mounts = o.kind === 'sensor' ? [['wall', 'En la pared'], ['rack', 'En un rack'], ['floor', 'Suelto en la sala']]
			: (['smoke', 'camera', 'motion', 'light', 'wap'].includes(o.kind) ? [['ceiling', 'En el techo'], ['wall', 'En la pared']]
				: (['suppression', 'leak'].includes(o.kind) ? [['floor', 'En el piso'], ['wall', 'En la pared']]
					: [['wall', 'En la pared'], ['floor', 'Suelto en la sala']]));
		const small = LakaInfra3DScene.SMALL_KINDS.includes(o.kind);
		const heightInput = `<label>${esc(t('Altura (m)'))} <input type="number" min="0" max="5" step="0.1" value="${o.height || (small ? LakaInfra3DScene.DEFAULT_HEIGHT[o.kind] : 2.35)}" data-field="obj-height" class="laka3d-ed-num"></label>`;
		const walls = [['n', 'Pared de arriba'], ['s', 'Pared de abajo'], ['w', 'Pared izquierda'], ['e', 'Pared derecha']];
		const mount = o.mount || 'floor';
		let place = '';

		if (mount === 'wall') {
			place = `
				<label>${esc(t('Pared'))} <select data-field="obj-wall">${walls.map(([v, l]) => `<option value="${v}"${o.wall === v ? ' selected' : ''}>${esc(t(l))}</option>`).join('')}</select></label>
				<label>${esc(t('Distancia desde la esquina (m)'))} <input type="number" min="0" step="0.1" value="${o.offset || 0}" data-field="obj-offset" class="laka3d-ed-num"></label>
				${small || o.kind === 'split' ? heightInput : ''}`;
		}
		else if (mount === 'rack') {
			place = `
				<label>${esc(t('Rack'))}
					<select data-field="obj-rack">${this.draft.racks.filter((r) => (r.kind || 'rack') === 'rack').map((r) => `<option value="${esc(r.name)}"${r.name === o.rack ? ' selected' : ''}>${esc(r.name)}</option>`).join('')}</select>
				</label>
				<label>${esc(t('Altura'))} <select data-field="obj-level">${[['top', 'Arriba'], ['mid', 'Al medio'], ['bottom', 'Abajo']].map(([v, l]) => `<option value="${v}"${o.level === v ? ' selected' : ''}>${esc(t(l))}</option>`).join('')}</select></label>
				<label>${esc(t('Cara'))} <select data-field="obj-face"><option value="front"${o.face !== 'back' ? ' selected' : ''}>${esc(t('Frente'))}</option><option value="back"${o.face === 'back' ? ' selected' : ''}>${esc(t('Atrás'))}</option></select></label>`;
		}
		else {
			place = `
				<label>x (m) <input type="number" step="0.1" value="${o.x}" data-field="obj-x" class="laka3d-ed-num"></label>
				<label>z (m) <input type="number" step="0.1" value="${o.z}" data-field="obj-z" class="laka3d-ed-num"></label>
				${(mount === 'ceiling' || (small && o.kind !== 'sensor')) ? heightInput : ''}`;
		}

		return `
			<div class="laka3d-ed-card laka3d-ed-selected">
				<div class="laka3d-ed-cardhead"><strong>${esc(this.kindName(o.kind))}</strong></div>
				<div class="laka3d-ed-props laka3d-ed-props-col">
					<label>${esc(t('Nombre'))} <input type="text" maxlength="64" value="${esc(o.name)}" data-field="obj-name"></label>
					<label>${esc(t('Ubicación'))} <select data-field="obj-mount">${mounts.map(([v, l]) => `<option value="${v}"${mount === v ? ' selected' : ''}>${esc(t(l))}</option>`).join('')}</select></label>
					${place}
					${LakaInfra3DScene.VARIANTS[o.kind] ? `
						<label>${esc(t('Tipo'))} <select data-field="obj-variant">${LakaInfra3DScene.VARIANTS[o.kind].map((l, i) => `<option value="${i + 1}"${(o.batt || 1) === i + 1 ? ' selected' : ''}>${esc(t(l))}</option>`).join('')}</select></label>` : ''}
					${['crac', 'ups', 'battery', 'suppression', 'leak'].includes(o.kind) ? `
						<label>${esc(t('Tamaño'))} <select data-field="obj-size">${LakaInfra3DEditor.sizeOptions(o.kind).map(([v, l]) => `<option value="${v}"${(o.size || 1) === v ? ' selected' : ''}>${esc(t(l))}</option>`).join('')}</select></label>` : ''}
					${o.kind === 'ups' ? `
						<label>${esc(t('Gabinetes de baterías al lado'))} <select data-field="obj-batt">${[0, 1, 2, 3, 4, 5, 6, 7, 8].map((n) => `<option value="${n}"${(o.batt || 0) === n ? ' selected' : ''}>${n}</option>`).join('')}</select></label>` : ''}
					${o.kind === 'door' ? `
						<label>${esc(t('Hojas'))} <select data-field="obj-leaves"><option value="1"${o.leaves !== 2 ? ' selected' : ''}>${esc(t('Una hoja (1,0 m)'))}</option><option value="2"${o.leaves === 2 ? ' selected' : ''}>${esc(t('Doble hoja (1,8 m)'))}</option></select></label>
						${o.leaves === 2 ? '' : `<label>${esc(t('Bisagra'))} <select data-field="obj-hinge"><option value="l"${o.hinge !== 'r' ? ' selected' : ''}>${esc(t('Izquierda'))}</option><option value="r"${o.hinge === 'r' ? ' selected' : ''}>${esc(t('Derecha'))}</option></select></label>`}
						<label>${esc(t('Abre hacia'))} <select data-field="obj-swing"><option value="front"${o.face !== 'back' ? ' selected' : ''}>${esc(t('Adentro de la sala'))}</option><option value="back"${o.face === 'back' ? ' selected' : ''}>${esc(t('Afuera de la sala'))}</option></select></label>` : ''}
					<label>${esc(t('Host de Zabbix'))} <span class="laka3d-ed-hostname">${esc(this.hostName(o.hostid) || t('Sin vincular'))}</span></label>
					<label>${esc(t('Clave del ítem'))} <input type="text" maxlength="255" value="${esc(o.key)}" placeholder="${esc(this.defaultKey(o.kind))}" data-field="obj-key"></label>
				</div>
				${this.renderObjectNet ? this.renderObjectNet(o) : ''}
				${this.renderPowerFields && o.id && LakaInfra3DPower.FED_KINDS.includes(o.kind) ? this.renderPowerFields(`x:${o.id}`, t('Energía')) : ''}
				<div class="laka3d-ed-btns">
					${mount === 'floor' ? `
						<button type="button" class="laka3d-btn laka3d-btn-icon" data-ed="obj-rot" data-dir="-90" aria-label="${esc(t('Girar a la izquierda'))}">⟲</button>
						<button type="button" class="laka3d-btn laka3d-btn-icon" data-ed="obj-rot" data-dir="90" aria-label="${esc(t('Girar a la derecha'))}">⟳</button>` : ''}
					${o.hostid ? `<button type="button" class="laka3d-btn" data-ed="obj-unlink">${esc(t('Desvincular host'))}</button>` : ''}
					<button type="button" class="laka3d-btn laka3d-btn-danger" data-ed="obj-del">${esc(t('Eliminar'))}</button>
				</div>
			</div>
			${this.renderHostSearch('object')}`;
	}

	// ---------------------------------------------------------------- búsqueda de hosts en Zabbix

	/** Nombre visible de un host conocido por el editor (sala, sin ubicar, infraestructura o búsquedas). */
	hostName(id) {
		if (!id) {
			return '';
		}

		if (this.hosts.has(id)) {
			return this.hosts.get(id).name;
		}

		const extra = (this.data.editor.object_hosts || []).find((h) => h.id === id);

		return extra ? extra.name : (this.foundHosts && this.foundHosts.get(id) ? this.foundHosts.get(id).name : `#${id}`);
	}

	/**
	 * Buscador igual a los selectores de Zabbix (CMultiSelect): "Grupos de hosts" y "Hosts" con fichas,
	 * "escribe aquí para buscar" con sugerencias y botón "Seleccionar" que abre la lista completa.
	 * Usa la acción laka_infra_3d.hosts.search, con los permisos del usuario.
	 */
	renderHostSearch(context) {
		const esc = LakaInfra3DEditor.esc;
		const t = this.t.bind(this);
		const hs = this.hsFor(context);
		const results = hs.results;
		const title = context === 'device' ? t('Buscar hosts en Zabbix') : (context === 'pdu' ? t('Agregar PDU de 0U') : t('Vincular host de Zabbix'));
		let list = '';

		if (hs.loading) {
			list = `<p class="laka3d-muted">${esc(t('Buscando…'))}</p>`;
		}
		else if (results) {
			list = `<div class="laka3d-ed-list">${results.map((h) => {
				const where = this.placementOf(h.id);
				const note = where && where.rack ? ` · ${where.rack}` : '';

				return `<button type="button" class="laka3d-ed-host" data-ed="hs-pick" data-context="${context}" data-id="${esc(h.id)}"><span>${esc(h.name)}</span><em>${esc(this.typeName(h.type))}${esc(note)}</em></button>`;
			}).join('') || `<p class="laka3d-muted">${esc(t('No se encontraron hosts.'))}</p>`}</div>
			${results.length >= (hs.limit || 200) ? `<p class="laka3d-muted">${esc(t('Hay más resultados: escribe más del nombre o elige un grupo.'))}</p>` : ''}`;
		}
		else {
			list = `<p class="laka3d-muted">${esc(t('Elige grupos de hosts o hosts para ver la lista.'))}</p>`;
		}

		return `
			<div class="laka3d-ed-card laka3d-ed-search-card">
				<div class="laka3d-ed-cardhead"><strong>${esc(title)}</strong></div>
				<div class="laka3d-ms-form">
					${this.renderMulti(context, 'groups', hs.groups, t('Grupos de hosts'))}
					${this.renderMulti(context, 'hosts', hs.hosts, t('Hosts'))}
				</div>
				${list}
			</div>`;
	}

	/** Estado del buscador por contexto (equipos, PDU, aire, objeto). */
	hsFor(context) {
		this.hsMap = this.hsMap || {};

		if (!this.hsMap[context]) {
			this.hsMap[context] = {context, groups: [], hosts: [], results: null, loading: false, limit: 200};
		}

		return this.hsMap[context];
	}

	/** Un selector múltiple: fichas con ✕, campo de búsqueda y botón "Seleccionar". */
	renderMulti(context, what, items, label) {
		const esc = LakaInfra3DEditor.esc;
		const t = this.t.bind(this);
		const attrs = `data-ms="${what}" data-context="${context}"`;

		return `
			<div class="laka3d-ms-row">
				<span class="laka3d-ms-label">${esc(label)}</span>
				<div class="laka3d-ms" ${attrs}>
					<div class="laka3d-ms-box">
						${items.length ? `<ul class="laka3d-ms-list">${items.map((it) => `
							<li><span class="laka3d-ms-chip"><span title="${esc(it.name)}">${esc(it.name)}</span><button type="button" class="laka3d-ms-x" data-ed="ms-remove" ${attrs} data-id="${esc(it.id)}" title="${esc(t('Quitar'))}" aria-label="${esc(t('Quitar'))}">✕</button></span></li>`).join('')}
						</ul>` : ''}
						<input type="text" class="laka3d-ms-input" autocomplete="off" data-field="ms-input" ${attrs} placeholder="${esc(t('escribe aquí para buscar'))}" aria-label="${esc(label)}">
						<div class="laka3d-ms-suggest" hidden></div>
					</div>
					<button type="button" class="laka3d-btn laka3d-ms-select" data-ed="ms-popup" ${attrs}>${esc(t('Seleccionar'))}</button>
				</div>
			</div>`;
	}

	async searchCall(params) {
		const body = new URLSearchParams();

		for (const [k, v] of Object.entries(params)) {
			if (Array.isArray(v)) {
				v.forEach((x) => body.append(`${k}[]`, x));
			}
			else {
				body.append(k, v);
			}
		}

		const response = await fetch(this.data.editor.search_url, {
			method: 'POST',
			headers: {'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'},
			body: body.toString()
		});

		return response.json();
	}

	/** Parámetros de búsqueda: los hosts se filtran por los grupos elegidos, como en Zabbix. */
	msParams(hs, what, search, limit) {
		const params = {what, search};

		if (what === 'hosts' && hs.groups.length) {
			params.groupids = hs.groups.map((g) => g.id);
		}

		if (limit) {
			params.limit = limit;
		}

		return params;
	}

	/** Sugerencias mientras se escribe (sin redibujar el editor, para no perder el foco). */
	async msSuggest(input) {
		const {ms: what, context} = input.dataset;
		const hs = this.hsFor(context);
		const text = input.value.trim();
		const box = input.parentElement.querySelector('.laka3d-ms-suggest');

		if (text === '') {
			this.msHide(box);

			return;
		}

		const seq = this.msSeq = (this.msSeq || 0) + 1;

		try {
			const json = await this.searchCall(this.msParams(hs, what, text, 16));

			if (seq !== this.msSeq || !box.isConnected) {
				return;
			}

			const chosen = new Set(hs[what].map((x) => x.id));
			const list = (json[what] || []).filter((x) => !chosen.has(x.id));
			const more = list.length > 15;

			this.msItems = list.slice(0, 15);
			this.msHover = 0;
			this.msBox = box;
			this.msRenderSuggest(box, more);
		}
		catch (error) {
			console.error(error);
		}
	}

	msRenderSuggest(box, more) {
		const esc = LakaInfra3DEditor.esc;
		const t = this.t.bind(this);
		const items = this.msItems || [];

		box.innerHTML = items.length
			? `<ul>${items.map((x, i) => `<li data-ms-pick="${i}" class="${i === this.msHover ? 'is-hover' : ''}" title="${esc(x.name)}">${esc(x.name)}${x.host && x.host !== x.name ? ` <em>${esc(x.host)}</em>` : ''}</li>`).join('')}</ul>${more ? `<div class="laka3d-ms-more">${esc(t('Hay más coincidencias…'))}</div>` : ''}`
			: `<div class="laka3d-ms-more">${esc(t('No se encontraron coincidencias'))}</div>`;
		box.hidden = false;
	}

	msHide(box) {
		if (box) {
			box.hidden = true;
			box.innerHTML = '';
		}

		this.msItems = [];
	}

	/** Agrega elementos al selector, redibuja y devuelve el foco al campo. */
	msAdd(context, what, items, refocus) {
		const hs = this.hsFor(context);
		const chosen = new Set(hs[what].map((x) => x.id));

		this.foundHosts = this.foundHosts || new Map();

		for (const it of items) {
			if (!chosen.has(it.id)) {
				hs[what].push(what === 'hosts' ? {id: it.id, name: it.name, host: it.host, type: it.type} : {id: it.id, name: it.name});
				chosen.add(it.id);
			}

			if (what === 'hosts') {
				this.foundHosts.set(it.id, it);
			}
		}

		this.msItems = [];
		this.refreshResults(context);

		if (refocus) {
			this.msFocus(context, what);
		}
	}

	msFocus(context, what) {
		const input = this.el.querySelector(`.laka3d-ms-input[data-context="${context}"][data-ms="${what}"]`);

		if (input) {
			input.focus();
		}
	}

	msRemove(context, what, id) {
		const hs = this.hsFor(context);

		hs[what] = hs[what].filter((x) => x.id !== id);
		this.refreshResults(context);
	}

	/**
	 * Lista de hosts para ubicar o vincular: los hosts elegidos o, si no hay, los hosts de los grupos elegidos.
	 */
	async refreshResults(context) {
		const hs = this.hsFor(context);

		if (hs.hosts.length) {
			hs.results = hs.hosts.slice();
			hs.loading = false;
			this.render();

			return;
		}

		if (!hs.groups.length) {
			hs.results = null;
			hs.loading = false;
			this.render();

			return;
		}

		const seq = hs.seq = (hs.seq || 0) + 1;

		hs.loading = true;
		this.render();

		try {
			const json = await this.searchCall(this.msParams(hs, 'hosts', ''));

			if (seq !== hs.seq) {
				return;
			}

			hs.results = Array.isArray(json.hosts) ? json.hosts : [];
			hs.limit = json.limit || 200;
			this.foundHosts = this.foundHosts || new Map();

			for (const h of hs.results) {
				this.foundHosts.set(h.id, h);
			}
		}
		catch (error) {
			hs.results = [];
			this.flash('error', this.t('No se pudo buscar en Zabbix.'));
		}

		hs.loading = false;

		// Conserva el foco si el usuario sigue escribiendo en un selector.
		const active = document.activeElement;
		const keep = active && active.classList && active.classList.contains('laka3d-ms-input') ? active.dataset : null;

		this.render();

		if (keep) {
			this.msFocus(keep.context, keep.ms);
		}
	}

	/** Ventana "Seleccionar", como el popup de Zabbix: lista con casillas y filtro por nombre. */
	async msOpenPopup(context, what) {
		const hs = this.hsFor(context);

		this.msPopup = {context, what, items: [], checked: new Set(), filter: '', loading: true, limit: 200};
		this.render();

		try {
			const json = await this.searchCall(this.msParams(hs, what, ''));

			if (!this.msPopup || this.msPopup.context !== context || this.msPopup.what !== what) {
				return;
			}

			const chosen = new Set(hs[what].map((x) => x.id));

			this.msPopup.items = json[what] || [];
			this.msPopup.limit = json.limit || 200;
			this.msPopup.checked = new Set(this.msPopup.items.filter((x) => chosen.has(x.id)).map((x) => x.id));
		}
		catch (error) {
			this.flash('error', this.t('No se pudo buscar en Zabbix.'));
		}

		if (this.msPopup) {
			this.msPopup.loading = false;
		}

		this.render();
	}

	renderMsPopup() {
		const p = this.msPopup;

		if (!p) {
			return '';
		}

		const esc = LakaInfra3DEditor.esc;
		const t = this.t.bind(this);
		const hs = this.hsFor(p.context);
		const title = p.what === 'groups' ? t('Grupos de hosts') : t('Hosts');
		const filterNote = p.what === 'hosts' && hs.groups.length
			? `<p class="laka3d-muted">${esc(t('Filtrado por grupos: %1$s').replace('%1$s', hs.groups.map((g) => g.name).join(', ')))}</p>` : '';
		const all = p.items.length > 0 && p.items.every((x) => p.checked.has(x.id));
		let body;

		if (p.loading) {
			body = `<p class="laka3d-muted">${esc(t('Buscando…'))}</p>`;
		}
		else if (!p.items.length) {
			body = `<p class="laka3d-muted">${esc(t('No se encontraron coincidencias'))}</p>`;
		}
		else {
			body = `
				<table class="laka3d-msp-table">
					<thead><tr>
						<th class="laka3d-msp-cb"><input type="checkbox" data-field="msp-all"${all ? ' checked' : ''} aria-label="${esc(t('Seleccionar todo'))}"></th>
						<th>${esc(t('Nombre'))}</th>
					</tr></thead>
					<tbody>${p.items.map((x) => `
						<tr data-name="${esc((x.name + ' ' + (x.host || '')).toLowerCase())}">
							<td class="laka3d-msp-cb"><input type="checkbox" data-field="msp-check" data-id="${esc(x.id)}"${p.checked.has(x.id) ? ' checked' : ''}></td>
							<td><a href="#" data-ed="msp-one" data-id="${esc(x.id)}">${esc(x.name)}</a>${x.host && x.host !== x.name ? ` <span class="laka3d-muted">${esc(x.host)}</span>` : ''}</td>
						</tr>`).join('')}
					</tbody>
				</table>
				${p.items.length >= p.limit ? `<p class="laka3d-muted">${esc(t('Hay más resultados: escribe más del nombre o elige un grupo.'))}</p>` : ''}`;
		}

		return `
			<div class="laka3d-msp-overlay" data-ed="msp-close">
				<div class="laka3d-msp" role="dialog" aria-modal="true" aria-label="${esc(title)}">
					<div class="laka3d-msp-head">
						<strong>${esc(title)}</strong>
						<button type="button" class="laka3d-msp-x" data-ed="msp-close" title="${esc(t('Cerrar'))}" aria-label="${esc(t('Cerrar'))}">✕</button>
					</div>
					<div class="laka3d-msp-filter">
						<label>${esc(t('Nombre'))} <input type="text" data-field="msp-filter" value="${esc(p.filter)}" placeholder="${esc(t('Filtrar por nombre'))}" autocomplete="off"></label>
						${filterNote}
					</div>
					<div class="laka3d-msp-body">${body}</div>
					<div class="laka3d-msp-foot">
						<button type="button" class="laka3d-btn laka3d-btn-primary" data-ed="msp-apply"${p.loading ? ' disabled' : ''}>${esc(t('Seleccionar'))}</button>
						<button type="button" class="laka3d-btn" data-ed="msp-close">${esc(t('Cancelar'))}</button>
					</div>
				</div>
			</div>`;
	}

	/** Filtra las filas de la ventana sin redibujar (mantiene el foco en el campo). */
	msPopupFilter(text) {
		const p = this.msPopup;

		if (!p) {
			return;
		}

		p.filter = text;

		const q = text.trim().toLowerCase();

		this.el.querySelectorAll('.laka3d-msp-table tbody tr').forEach((tr) => {
			tr.hidden = q !== '' && !tr.dataset.name.includes(q);
		});
	}

	/** Teclado del selector, como en Zabbix: flechas, Enter, Escape y Retroceso para quitar la última ficha. */
	msKey(e) {
		const input = e.target;
		const box = input.parentElement.querySelector('.laka3d-ms-suggest');
		const items = this.msItems || [];
		const open = box && !box.hidden && items.length > 0;

		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			if (open) {
				e.preventDefault();
				this.msHover = (this.msHover + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
				this.msRenderSuggest(box, false);
			}
		}
		else if (e.key === 'Enter') {
			e.preventDefault();

			if (open) {
				this.msAdd(input.dataset.context, input.dataset.ms, [items[this.msHover] || items[0]], true);
			}
		}
		else if (e.key === 'Escape') {
			if (open) {
				e.preventDefault();
				e.stopPropagation();
				this.msHide(box);
			}
		}
		else if (e.key === 'Backspace' && input.value === '') {
			const hs = this.hsFor(input.dataset.context);
			const list = hs[input.dataset.ms];

			if (list.length) {
				e.preventDefault();
				list.pop();
				this.refreshResults(input.dataset.context);
				this.msFocus(input.dataset.context, input.dataset.ms);
			}
		}
	}

	/** Usa el host elegido en la búsqueda según dónde se buscó. */
	pickHost(context, id) {
		const h = this.foundHosts.get(id);

		if (!h) {
			return;
		}

		if (context === 'device') {
			if (!this.hosts.has(id)) {
				this.hosts.set(id, {id, name: h.name, host: h.host, type: h.type, src: 'none', tag: null});
			}

			this.armed = {kind: 'host', id};
			this.selectedItem = null;
		}
		else if (context === 'object') {
			const o = this.draft.objects[this.selectedObject];

			if (o) {
				o.hostid = id;

				if (o.name === '' || /\s\d+$/.test(o.name)) {
					o.name = h.name.slice(0, 64);
				}

				this.touch();
			}
		}
		else if (context === 'pdu') {
			const r = this.rack(this.selectedRack);

			if (r && !(r.pdus || []).includes(id)) {
				r.pdus = (r.pdus || []).concat([id]).slice(0, 8);
				this.touch();
			}
		}
		else if (context === 'cooler') {
			const r = this.rack(this.selectedRack);

			if (r) {
				r.hostid = id;
				this.touch();
			}
		}
	}

	/** Convierte un punto de la pantalla a metros del plano. */
	planPoint(svg, e) {
		const pt = svg.createSVGPoint();

		pt.x = e.clientX;
		pt.y = e.clientY;

		const p = pt.matrixTransform(svg.getScreenCTM().inverse());

		return {x: Math.round(p.x * 10) / 10, z: Math.round(p.y * 10) / 10};
	}

	planPointerDown(e) {
		const svg = e.target.closest('svg.laka3d-pl');

		if (!svg || this.tab !== 'infra') {
			return;
		}

		const g = e.target.closest('[data-obj]');

		if (this.armedObject) {
			const p = this.planPoint(svg, e);
			const kind = this.armedObject;
			const count = this.draft.objects.filter((o) => o.kind === kind).length + 1;
			// Puertas, aires de precisión, splits, tableros y sensores van pegados a la pared más cercana.
			const mount = ['smoke', 'wap'].includes(kind) ? 'ceiling'
				: (['door', 'crac', 'split', 'panel', 'sensor', 'access', 'camera', 'motion', 'vesda', 'firepanel', 'extinguisher', 'epo',
					'light', 'ground', 'ats', 'water', 'solar'].includes(kind) ? 'wall' : 'floor');
			const near = this.nearestWall(p, this.plan().bounds);

			// Identificador propio desde el alta: así se puede documentar su cable antes de guardar.
			const used = new Set(this.draft.objects.map((x) => x.id));
			let id = '';

			do {
				id = 'o' + Math.random().toString(36).slice(2, 9);
			} while (used.has(id));

			this.draft.objects.push({id, kind, name: `${this.kindName(kind)} ${count}`, x: p.x, z: p.z, rot: 0, rack: '',
				level: 'top', face: 'front', hostid: '', key: '', mount, wall: near.wall, offset: near.offset,
				height: LakaInfra3DScene.DEFAULT_HEIGHT[kind] || 0, hinge: 'l', leaves: 1,
				size: ['crac', 'ups', 'suppression'].includes(kind) ? 2 : 1, batt: LakaInfra3DScene.VARIANTS[kind] ? (kind === 'access' ? 3 : 1) : 0
			});
			this.selectedObject = this.draft.objects.length - 1;
			this.armedObject = null;
			this.touch();
			this.render();

			return;
		}

		if (g) {
			const i = parseInt(g.dataset.obj, 10);
			const o = this.draft.objects[i];

			this.selectedObject = i;

			if (!g.classList.contains('is-fixed')) {
				const start = this.planPoint(svg, e);

				this.drag = {i, svg, g, dx: o.x - start.x, dz: o.z - start.z, moved: false, plan: this.plan()};
				svg.setPointerCapture(e.pointerId);
				e.preventDefault();
			}
			else {
				this.render();
			}
		}
	}

	planPointerMove(e) {
		if (!this.drag) {
			return;
		}

		const p = this.planPoint(this.drag.svg, e);
		const o = this.draft.objects[this.drag.i];

		if (o.mount === 'wall') {
			// Pegado a la pared: se desliza por la pared más cercana al puntero.
			const near = this.nearestWall(p, this.drag.plan.bounds);

			o.wall = near.wall;
			o.offset = near.offset;
		}
		else {
			o.x = Math.round((p.x + this.drag.dx) * 10) / 10;
			o.z = Math.round((p.z + this.drag.dz) * 10) / 10;
		}

		const at = this.placeObject(o, this.drag.plan);

		this.drag.moved = true;
		this.drag.g.setAttribute('transform', `translate(${at.x} ${at.z}) rotate(${at.rot})`);
	}

	planPointerUp() {
		if (!this.drag) {
			return;
		}

		if (this.drag.moved) {
			this.touch();
		}

		this.drag = null;
		this.render();
	}

	// ---------------------------------------------------------------- eventos

	click(e) {
		if ((this.cabClick && this.cabClick(e)) || (this.normClick && this.normClick(e))
				|| (this.adminClick && this.adminClick(e))) {
			return;
		}

		const tab = e.target.closest('[data-tab]');

		if (tab) {
			this.tab = tab.dataset.tab;
			this.message = null;
			this.render();

			return;
		}

		const btn = e.target.closest('[data-ed]');

		if (!btn || btn.disabled) {
			return;
		}

		const act = btn.dataset.ed;
		const row = btn.dataset.row !== undefined ? parseInt(btn.dataset.row, 10) : null;
		const d = this.draft;

		switch (act) {
			case 'cancel':
				if (!this.dirty || window.confirm(this.t('¿Descartar los cambios sin guardar?'))) {
					this.close();
				}

				return;

			case 'save':
				this.save();

				return;

			case 'row-add': {
				const name = this.nextRowName();

				d.rows.push(name);
				d.racks.push({name: this.nextRackName(), units: this.defaultUnits(), row: name, pos: 1});
				this.touch();
				break;
			}

			case 'row-up':
			case 'row-down': {
				const j = act === 'row-up' ? row - 1 : row + 1;

				[d.rows[row], d.rows[j]] = [d.rows[j], d.rows[row]];
				this.touch();
				break;
			}

			case 'row-del': {
				const name = d.rows[row];
				const racks = d.racks.filter((r) => r.row === name);

				if (racks.length && !window.confirm(this.t('La fila %1$s tiene %2$s racks. ¿Eliminarla con sus racks?', name,
						String(racks.length)))) {
					return;
				}

				for (const r of racks) {
					this.deleteRack(r.name);
				}

				d.rows.splice(row, 1);
				d.flips = (d.flips || []).filter((x) => x !== name);
				this.touch();
				break;
			}

			case 'rack-add': {
				const rowName = d.rows[row];
				const count = d.racks.filter((r) => r.row === rowName).length;
				const name = this.nextRackName();

				d.racks.push({name, units: this.defaultUnits(), row: rowName, pos: count + 1, kind: 'rack', width: 0.6,
					hostid: '', key: ''});
				this.selectedRack = name;
				this.touch();
				break;
			}

			case 'wall-rack-add': {
				// Gabinete de pared de 12U y 450 mm, en la pared de arriba, después del último rack de pared.
				const name = this.nextRackName();
				const others = d.racks.filter((r) => r.mount === 'wall' && (r.wall || 'n') === 'n');
				const offset = others.length ? Math.max(...others.map((r) => (r.offset || 0))) + 0.8 : 1.0;

				d.racks.push({name, units: 12, row: '', pos: null, kind: 'rack', width: 0.6, hostid: '', key: '',
					mount: 'wall', wall: 'n', offset: Math.round(offset * 10) / 10, height: 0, depth: 0.45});
				this.selectedRack = name;
				this.touch();
				break;
			}

			case 'slot-add': {
				// Aire, UPS modular o gabinete de baterías: ocupa un lugar de la fila (entre racks o al final).
				const kind = btn.dataset.kind;
				const rowName = d.rows[row];
				const count = d.racks.filter((r) => r.row === rowName).length;
				const prefix = {cooler: 'AC', ups: 'UPS', battery: 'BAT'}[kind] || 'X';
				let k = d.racks.filter((r) => r.kind === kind).length + 1;

				while (this.rack(`${prefix}${String(k).padStart(2, '0')}`)) {
					k++;
				}

				const name = `${prefix}${String(k).padStart(2, '0')}`;

				d.racks.push({name, units: this.defaultUnits(), row: rowName, pos: count + 1, kind,
					model: kind === 'cooler' ? 'inrow' : '', width: kind === 'cooler' ? 0.3 : 0.6, hostid: '', key: ''});
				this.selectedRack = name;
				this.touch();
				break;
			}

			case 'src':
				this.hostSrc = btn.dataset.src;
				break;

			case 'flips-reset':
				// Vuelve todas las filas al patrón de la sala (pasillos fríos y calientes alternados).
				d.flips = [];
				this.touch();
				break;

			case 'row-flip': {
				// Invierte el sentido de una fila: su frente pasa al otro lado y cambian sus pasillos.
				const name = d.rows[row];
				const flips = new Set(d.flips || []);

				if (flips.has(name)) {
					flips.delete(name);
				}
				else {
					flips.add(name);
				}

				d.flips = [...flips];
				this.touch();
				break;
			}

			case 'pdu-del': {
				const r = this.rack(this.selectedRack);

				if (r) {
					r.pdus = (r.pdus || []).filter((x) => x !== btn.dataset.id);
					this.touch();
				}

				break;
			}

			case 'ms-remove':
				this.msRemove(btn.dataset.context, btn.dataset.ms, btn.dataset.id);

				return;

			case 'ms-popup':
				this.msOpenPopup(btn.dataset.context, btn.dataset.ms);

				return;

			case 'msp-close':
				// El fondo solo cierra si se hace clic fuera de la ventana.
				if (btn.classList.contains('laka3d-msp-overlay') && e.target !== btn) {
					return;
				}

				this.msPopup = null;
				break;

			case 'msp-one': {
				// Clic en el nombre: elige solo ese elemento, como en Zabbix.
				e.preventDefault();

				const p = this.msPopup;
				const it = p && p.items.find((x) => x.id === btn.dataset.id);

				this.msPopup = null;

				if (it) {
					this.msAdd(p.context, p.what, [it], false);
				}

				return;
			}

			case 'msp-apply': {
				const p = this.msPopup;

				this.msPopup = null;

				if (p) {
					this.msAdd(p.context, p.what, p.items.filter((x) => p.checked.has(x.id)), false);
				}

				return;
			}

			case 'hs-pick':
				this.pickHost(btn.dataset.context, btn.dataset.id);
				break;

			case 'obj-unlink': {
				const o = d.objects[this.selectedObject];

				if (o) {
					o.hostid = '';
					this.touch();
				}

				break;
			}

			case 'rack-select':
				this.selectedRack = this.selectedRack === btn.dataset.rack ? null : btn.dataset.rack;
				break;

			case 'rack-left':
			case 'rack-right': {
				const r = this.rack(this.selectedRack);
				const other = d.racks.find((x) => x.row === r.row && x.pos === r.pos + (act === 'rack-left' ? -1 : 1));

				if (other) {
					[r.pos, other.pos] = [other.pos, r.pos];
					this.touch();
				}

				break;
			}

			case 'rack-devices':
				this.tab = 'devices';
				break;

			case 'rack-del': {
				const r = this.rack(this.selectedRack);
				const n = this.itemsOf(r.name).filter((x) => x.src !== 'tag').length;

				if (n && !window.confirm(this.t('El rack %1$s tiene %2$s equipos ubicados en el editor. Quedarán sin ubicar. ¿Eliminarlo?',
						r.name, String(n)))) {
					return;
				}

				this.deleteRack(r.name);
				this.selectedRack = null;
				this.touch();
				break;
			}

			case 'face':
				this.face = btn.dataset.face;
				break;

			case 'arm-host':
				this.armed = this.armed && this.armed.kind === 'host' && this.armed.id === btn.dataset.id
					? null : {kind: 'host', id: btn.dataset.id};
				this.selectedItem = null;
				break;

			case 'arm-passive': {
				const np = this.newPassive || {};
				const role = ['cable', 'blank'].includes(np.type) ? np.type : '';
				const prefix = {cable: 'org', blank: 'blank'}[role] || 'patch';
				const name = (np.name || '').trim() || `${prefix}-${d.passives.length + 1}`;

				// Organizador y panel ciego se guardan como pasivo con su papel en la configuración del equipo.
				this.armed = {kind: 'passive', item: {name, type: role ? 'patch' : (np.type || 'patch'), role,
					n: Math.max(1, Math.min(20, np.n || 1))}};
				this.selectedItem = null;
				break;
			}

			case 'disarm':
				this.armed = null;
				break;

			case 'u':
				this.placeAt(parseInt(btn.dataset.u, 10));
				break;

			case 'item':
				this.selectedItem = {kind: btn.dataset.kind, id: btn.dataset.id};
				this.armed = null;
				break;

			case 'item-move': {
				const it = this.itemsOf(this.selectedRack).find((x) => x.kind === this.selectedItem.kind && x.id === this.selectedItem.id);

				this.armed = it.kind === 'host' ? {kind: 'host', id: it.id, move: true}
					: {kind: 'passive', index: parseInt(it.id, 10), item: d.passives[parseInt(it.id, 10)], move: true};
				break;
			}

			case 'item-remove': {
				const sel = this.selectedItem;

				if (sel.kind === 'host') {
					delete d.placements[sel.id];
				}
				else {
					d.passives.splice(parseInt(sel.id, 10), 1);
				}

				this.selectedItem = null;
				this.touch();
				break;
			}

			case 'csv-add':
			case 'csv-replace':
				this.importCsv(this.csvText || '', act === 'csv-replace');
				break;

			case 'export-csv':
				this.download(`laka-infra-3d-${this.fileRoom()}.csv`, this.exportCsv(), 'text/csv;charset=utf-8');

				return;

			case 'export-json':
				this.download(`laka-infra-3d-${this.fileRoom()}.json`, JSON.stringify(this.draft, null, 2), 'application/json');

				return;

			case 'template':
				this.applyTemplate(btn.dataset.id);
				break;

			case 'obj-arm':
				this.armedObject = this.armedObject === btn.dataset.kind ? null : btn.dataset.kind;
				break;

			case 'obj-disarm':
				this.armedObject = null;
				break;

			case 'obj-rot': {
				const o = d.objects[this.selectedObject];

				o.rot = ((o.rot + parseInt(btn.dataset.dir, 10)) % 360 + 360) % 360;
				this.touch();
				break;
			}

			case 'obj-del':
				// Su cable de red se va con él.
				if (d.objects[this.selectedObject] && d.objects[this.selectedObject].id && this.cabInit) {
					this.cabInit();
					LakaInfra3DCabling.drop(this.cab, `x:${d.objects[this.selectedObject].id}`);
					this.cabTouch();
				}

				d.objects.splice(this.selectedObject, 1);
				this.selectedObject = null;
				this.touch();
				break;
		}

		this.render();
	}

	change(e) {
		if ((this.cabChange && this.cabChange(e)) || (this.adminChange && this.adminChange(e))) {
			return;
		}

		if (e.target.dataset.en) {
			this.energyChange(e.target);

			return;
		}

		const f = e.target.dataset.field;

		if (!f) {
			return;
		}

		const value = e.target.value;
		const d = this.draft;

		switch (f) {
			case 'site-coords':
				this.saveSiteCoords(value);

				return;

			case 'layout':
				d.layout = value === '' ? null : parseInt(value, 10);
				this.touch();
				break;

			case 'row-name': {
				const ri = parseInt(e.target.dataset.row, 10);
				const old = d.rows[ri];
				const name = value.trim().slice(0, 16);

				if (name === '' || (name !== old && d.rows.includes(name))) {
					this.flash('error', this.t('Ese nombre de fila ya existe o está vacío.'));
					break;
				}

				d.rows[ri] = name;
				d.flips = (d.flips || []).map((x) => (x === old ? name : x));

				for (const r of d.racks) {
					if (r.row === old) {
						r.row = name;
					}
				}

				this.touch();
				break;
			}

			case 'rack-name': {
				const r = this.rack(this.selectedRack);
				const name = value.trim().slice(0, 32);

				if (name === '' || (name.toLowerCase() !== r.name.toLowerCase()
						&& d.racks.some((x) => x.name.toLowerCase() === name.toLowerCase()))) {
					this.flash('error', this.t('Ese nombre de rack ya existe o está vacío.'));
					break;
				}

				this.renameRack(r.name, name);
				this.selectedRack = name;
				this.touch();
				break;
			}

			case 'rack-units': {
				const r = this.rack(this.selectedRack);

				r.units = Math.max(4, Math.min(r.mount === 'wall' ? LakaInfra3DEditor.WALL_MAX_U : 60, parseInt(value, 10) || this.defaultUnits()));
				this.touch();
				break;
			}

			case 'rack-wall': {
				const r = this.rack(this.selectedRack);

				r.wall = ['n', 's', 'e', 'w'].includes(value) ? value : 'n';
				this.touch();
				break;
			}

			case 'rack-offset': {
				const r = this.rack(this.selectedRack);

				r.offset = Math.max(0, Math.min(300, Math.round((parseFloat(value) || 0) * 100) / 100));
				this.touch();
				break;
			}

			case 'rack-height': {
				const r = this.rack(this.selectedRack);

				r.height = Math.max(0, Math.min(2.5, Math.round((parseFloat(value) || 0) * 100) / 100));
				this.touch();
				break;
			}

			case 'rack-depth': {
				const r = this.rack(this.selectedRack);
				const v = parseFloat(value);

				r.depth = LakaInfra3DEditor.WALL_DEPTHS.includes(v) ? v : 0.45;
				this.touch();
				break;
			}

			case 'rack-width': {
				const r = this.rack(this.selectedRack);

				r.width = Math.max(0.3, Math.min(3, parseFloat(value) || 0.6));
				this.touch();
				break;
			}

			case 'slot-model': {
				// Al cambiar el tipo de aire se ajusta el ancho a uno válido para ese tipo.
				const r = this.rack(this.selectedRack);

				r.model = value === 'crac' ? 'crac' : 'inrow';
				r.width = r.model === 'crac' ? 1.8 : 0.3;
				this.touch();
				break;
			}

			case 'rack-vpdu': {
				const r = this.rack(this.selectedRack);

				r.vpdu = Math.max(0, Math.min(4, parseInt(value, 10) || 0));
				r.outlets = r.vpdu > 0 ? (r.outlets || 24) : 0;
				this.touch();
				break;
			}

			case 'rack-outlets': {
				const r = this.rack(this.selectedRack);

				r.outlets = parseInt(value, 10) || 24;
				this.touch();
				break;
			}

			case 'site':
				d.site = value.trim().slice(0, 64);
				this.touch();

				return;

			case 'aisle':
				d.aisle = value === 'cold' || value === 'hot' ? value : null;
				this.touch();
				break;

			case 'contain':
				d.contain = value === 'cold' || value === 'hot' ? value : 'none';
				this.touch();
				break;

			case 'rack-kw': {
				const r = this.rack(this.selectedRack);

				r.power_kw = Math.max(0, Math.min(100, Math.round((parseFloat(value) || 0) * 10) / 10));
				this.touch();
				break;
			}

			case 'rack-kg': {
				const r = this.rack(this.selectedRack);

				r.max_kg = Math.max(0, Math.min(3000, parseInt(value, 10) || 0));
				this.touch();
				break;
			}

			case 'rack-key': {
				const r = this.rack(this.selectedRack);

				r.key = value.trim().slice(0, 255);
				this.touch();
				break;
			}

			case 'obj-mount': {
				const o = d.objects[this.selectedObject];

				if (!o) {
					break;
				}

				const plan = this.plan();
				const at = this.placeObject(o, plan);

				o.mount = value;

				if (value === 'wall') {
					const near = this.nearestWall(at, plan.bounds);

					o.wall = near.wall;
					o.offset = near.offset;
					o.rack = '';
				}
				else if (value === 'rack') {
					const first = d.racks.find((r) => (r.kind || 'rack') === 'rack');

					if (!first) {
						o.mount = 'wall';
						this.flash('error', this.t('Primero crea los racks en la pestaña Sala.'));
						break;
					}

					o.rack = o.rack || first.name;
				}
				else {
					o.x = Math.round(at.x * 10) / 10;
					o.z = Math.round(at.z * 10) / 10;
					o.rot = at.rot;
					o.rack = '';

					// En el techo: a 3 m si no tenía una altura de techo.
					if (value === 'ceiling' && !(o.height >= 2)) {
						o.height = 3;
					}
				}

				this.touch();
				break;
			}

			case 'obj-variant': {
				const o = d.objects[this.selectedObject];

				if (o) {
					o.batt = Math.max(1, parseInt(value, 10) || 1);
					this.touch();
				}

				break;
			}

			case 'obj-size':
			case 'obj-batt': {
				const o = d.objects[this.selectedObject];

				if (o) {
					if (f === 'obj-size') {
						o.size = Math.max(1, Math.min(3, parseInt(value, 10) || 1));
					}
					else {
						o.batt = Math.max(0, Math.min(8, parseInt(value, 10) || 0));
					}

					this.touch();
				}

				break;
			}

			case 'obj-leaves':
			case 'obj-hinge':
			case 'obj-swing': {
				const o = d.objects[this.selectedObject];

				if (!o) {
					break;
				}

				if (f === 'obj-leaves') {
					o.leaves = value === '2' ? 2 : 1;
				}
				else if (f === 'obj-hinge') {
					o.hinge = value === 'r' ? 'r' : 'l';
				}
				else {
					o.face = value === 'back' ? 'back' : 'front';
				}

				this.touch();
				break;
			}

			case 'obj-wall':
			case 'obj-offset':
			case 'obj-height': {
				const o = d.objects[this.selectedObject];

				if (!o) {
					break;
				}

				if (f === 'obj-wall') {
					o.wall = ['n', 's', 'e', 'w'].includes(value) ? value : 'n';
				}
				else if (f === 'obj-offset') {
					o.offset = Math.max(0, Math.round((parseFloat(value) || 0) * 10) / 10);
				}
				else {
					o.height = Math.max(0, Math.min(5, Math.round((parseFloat(value) || 0) * 100) / 100));
				}

				this.touch();
				break;
			}

			case 'ms-input':
			case 'msp-filter':
				return;

			case 'msp-check':
			case 'msp-all': {
				// Casillas de la ventana "Seleccionar": se guardan sin redibujar.
				const p = this.msPopup;

				if (p) {
					if (f === 'msp-all') {
						const rows = [...this.el.querySelectorAll('.laka3d-msp-table tbody tr')].filter((tr) => !tr.hidden);

						rows.forEach((tr) => {
							const cb = tr.querySelector('[data-field="msp-check"]');

							cb.checked = e.target.checked;
							e.target.checked ? p.checked.add(cb.dataset.id) : p.checked.delete(cb.dataset.id);
						});
					}
					else {
						e.target.checked ? p.checked.add(e.target.dataset.id) : p.checked.delete(e.target.dataset.id);
					}
				}

				return;
			}

			case 'rack-row': {
				const r = this.rack(this.selectedRack);

				r.row = value;
				r.pos = d.racks.filter((x) => x.row === value).length + 1;
				this.renumber();
				this.touch();
				break;
			}

			case 'dev-rack':
				this.selectedRack = value;
				this.selectedItem = null;
				break;

			case 'item-u':
			case 'item-n':
			case 'item-face':
			case 'item-type':
			case 'item-name':
			case 'item-w':
			case 'item-kg':
				this.updateItem(f.slice(5), value);
				break;

			case 'new-passive-type':
				this.newPassive = Object.assign(this.newPassive || {}, {type: value});

				return;

			case 'new-passive-n':
				this.newPassive = Object.assign(this.newPassive || {}, {n: parseInt(value, 10) || 1});

				return;

			case 'file':
				this.readFile(e.target.files && e.target.files[0]);

				return;

			case 'room-w':
			case 'room-d': {
				const v = parseFloat(value);

				d.room[f === 'room-w' ? 'w' : 'd'] = v >= 2 ? Math.min(300, Math.round(v * 10) / 10) : 0;
				this.touch();
				break;
			}

			case 'obj-name':
			case 'obj-host':
			case 'obj-key':
			case 'obj-rack':
			case 'obj-level':
			case 'obj-face':
			case 'obj-x':
			case 'obj-z': {
				const o = d.objects[this.selectedObject];
				const prop = {'obj-name': 'name', 'obj-host': 'hostid', 'obj-key': 'key', 'obj-rack': 'rack',
					'obj-level': 'level', 'obj-face': 'face', 'obj-x': 'x', 'obj-z': 'z'}[f];

				if (!o) {
					break;
				}

				o[prop] = prop === 'x' || prop === 'z' ? Math.round((parseFloat(value) || 0) * 10) / 10 : value.slice(0, prop === 'key' ? 255 : 64);

				if (prop === 'hostid' && value && (o.name === '' || /\s\d+$/.test(o.name))) {
					const h = this.infraHosts().find((x) => x.id === value);

					if (h) {
						o.name = h.name.slice(0, 64);
					}
				}

				this.touch();
				break;
			}

			default:
				return;
		}

		this.render();
	}

	input(e) {
		if ((this.cabInput && this.cabInput(e)) || (this.adminInput && this.adminInput(e))) {
			return;
		}

		const f = e.target.dataset.field;

		if (f === 'filter') {
			this.filterText = e.target.value;

			const pos = e.target.selectionStart;

			this.render();

			const again = this.el.querySelector('[data-field="filter"]');

			again.focus();
			again.setSelectionRange(pos, pos);
		}
		else if (f === 'csv') {
			this.csvText = e.target.value;
		}
		else if (f === 'ms-input') {
			// Como en Zabbix: sugerencias mientras se escribe.
			const target = e.target;

			clearTimeout(this.msTimer);
			this.msTimer = setTimeout(() => this.msSuggest(target), 250);
		}
		else if (f === 'msp-filter') {
			this.msPopupFilter(e.target.value);
		}
		else if (f === 'new-passive-name') {
			this.newPassive = Object.assign(this.newPassive || {}, {name: e.target.value});
		}
	}

	flash(kind, text) {
		this.message = {kind, text};
	}

	// ---------------------------------------------------------------- operaciones

	deleteRack(name) {
		const d = this.draft;

		for (const o of d.objects) {
			if (o.rack === name) {
				// El sensor pierde su rack: queda en la pared más cercana.
				o.rack = '';
				o.mount = 'wall';
			}
		}

		d.racks = d.racks.filter((r) => r.name !== name);
		d.passives = d.passives.filter((p) => p.rack !== name);

		for (const [id, p] of Object.entries(d.placements)) {
			if (p.rack === name) {
				delete d.placements[id];
			}
		}

		this.renumber();
	}

	renameRack(old, name) {
		const d = this.draft;
		const r = this.rack(old);

		r.name = name;

		for (const p of Object.values(d.placements)) {
			if (p.rack === old) {
				p.rack = name;
			}
		}

		for (const p of d.passives) {
			if (p.rack === old) {
				p.rack = name;
			}
		}

		for (const o of d.objects) {
			if (o.rack === old) {
				o.rack = name;
			}
		}

		// Los hosts ubicados por tags en ese rack pasan al editor para no perderlos.
		for (const h of this.hosts.values()) {
			if (!d.placements[h.id] && h.tag && h.tag.rack === old) {
				d.placements[h.id] = Object.assign({}, h.tag, {rack: name});
			}
		}
	}

	/** Ubica el equipo preparado (host o pasivo) con su U de abajo en u. */
	placeAt(u) {
		const rackName = this.selectedRack;
		const d = this.draft;

		if (!this.armed) {
			this.flash('info', this.t('Elige primero un host sin ubicar o un equipo del rack.'));

			return;
		}

		if (this.armed.kind === 'host') {
			const id = this.armed.id;
			const h = this.hosts.get(id);
			const current = this.placementOf(id);
			const n = current ? current.n : 1;
			const type = current ? current.type : h.type;

			if (!this.fits(rackName, u, n, this.face, {kind: 'host', id})) {
				this.flash('error', this.t('No entra: esa U está ocupada o el equipo se sale del rack.'));

				return;
			}

			d.placements[id] = {rack: rackName, u, n, face: this.face, type, w: current ? current.w || 0 : 0,
				kg: current ? current.kg || 0 : 0};
			this.selectedItem = {kind: 'host', id};
		}
		else {
			const item = this.armed.item;

			if (this.armed.move) {
				const index = this.armed.index;

				if (!this.fits(rackName, u, item.n, this.face, {kind: 'passive', id: String(index)})) {
					this.flash('error', this.t('No entra: esa U está ocupada o el equipo se sale del rack.'));

					return;
				}

				Object.assign(d.passives[index], {rack: rackName, u, face: this.face});
				this.selectedItem = {kind: 'passive', id: String(index)};
			}
			else {
				if (!this.fits(rackName, u, item.n, this.face)) {
					this.flash('error', this.t('No entra: esa U está ocupada o el equipo se sale del rack.'));

					return;
				}

				d.passives.push({rack: rackName, u, n: item.n, face: this.face, type: item.type, name: item.name});
				this.selectedItem = {kind: 'passive', id: String(d.passives.length - 1)};

				if (item.role && this.setDevCfg) {
					this.setDevCfg(this.pkey(d.passives[d.passives.length - 1]), 'role', item.role);
				}
				this.newPassive = null;
			}
		}

		this.armed = null;
		this.message = null;
		this.touch();
	}

	updateItem(prop, value) {
		const sel = this.selectedItem;
		const rackName = this.selectedRack;
		const it = this.itemsOf(rackName).find((x) => x.kind === sel.kind && x.id === sel.id);

		if (!it) {
			return;
		}

		const next = {u: it.u, n: it.n, face: it.face, type: it.type, name: it.name, w: it.w, kg: it.kg};

		if (prop === 'u' || prop === 'n') {
			next[prop] = Math.max(1, parseInt(value, 10) || 1);
		}
		else if (prop === 'w') {
			next.w = Math.max(0, Math.min(50000, parseInt(value, 10) || 0));
		}
		else if (prop === 'kg') {
			next.kg = Math.max(0, Math.min(2000, Math.round((parseFloat(value) || 0) * 10) / 10));
		}
		else {
			next[prop] = value;
		}

		if ((prop === 'u' || prop === 'n' || prop === 'face')
				&& !this.fits(rackName, next.u, next.n, next.face, {kind: sel.kind, id: sel.id})) {
			this.flash('error', this.t('No entra: esa U está ocupada o el equipo se sale del rack.'));

			return;
		}

		if (sel.kind === 'host') {
			this.draft.placements[sel.id] = {rack: rackName, u: next.u, n: Math.min(20, next.n), face: next.face,
				type: next.type, w: next.w, kg: next.kg
			};
		}
		else {
			Object.assign(this.draft.passives[parseInt(sel.id, 10)], {u: next.u, n: Math.min(20, next.n), face: next.face,
				type: next.type, name: String(next.name).slice(0, 64), w: next.w, kg: next.kg
			});
		}

		this.message = null;
		this.touch();
	}

	applyTemplate(id) {
		const tpl = LakaInfra3DEditor.TEMPLATES.find((x) => x.id === id);

		if (!tpl || (this.draft.racks.length && !window.confirm(this.t('¿Reemplazar las filas y racks actuales por la plantilla "%1$s"?', this.t(tpl.title))))) {
			return;
		}

		const d = this.draft;
		let n = 1;

		d.rows = [];
		d.racks = [];
		d.layout = tpl.layout;
		// La plantilla arranca con el patrón uniforme: ninguna fila invertida a mano.
		d.flips = [];

		for (const [row, count, units] of tpl.rows) {
			d.rows.push(row);

			for (let i = 0; i < count; i++) {
				d.racks.push({name: 'R' + String(n).padStart(2, '0'), units, row, pos: i + 1});
				n++;
			}
		}

		// Equipos del editor que quedaron sin rack: pasan a "sin ubicar".
		const names = new Set(d.racks.map((r) => r.name));

		for (const [hid, p] of Object.entries(d.placements)) {
			if (!names.has(p.rack)) {
				delete d.placements[hid];
			}
		}

		d.passives = d.passives.filter((p) => names.has(p.rack));

		for (const o of d.objects) {
			if (o.rack && !names.has(o.rack)) {
				o.rack = '';
				o.mount = 'wall';
			}
		}

		this.selectedRack = null;
		this.flash('info', this.t('Plantilla aplicada. Revisa la sala y pulsa Guardar.'));
		this.touch();
	}

	readFile(file) {
		if (!file) {
			return;
		}

		const reader = new FileReader();

		reader.onload = () => {
			const text = String(reader.result || '');

			if (/\.json$/i.test(file.name) || text.trim().startsWith('{')) {
				try {
					const json = JSON.parse(text);

					if (!Array.isArray(json.racks) || typeof json.placements !== 'object') {
						throw new Error('format');
					}

					if (this.draft.racks.length && !window.confirm(this.t('¿Reemplazar toda la distribución por la del archivo?'))) {
						return;
					}

					this.draft = {
						rev: this.draft.rev,
						layout: json.layout ?? null,
						rows: Array.isArray(json.rows) ? json.rows.map(String) : [],
						racks: json.racks.filter((r) => r && r.name).map((r) => Object.assign({}, r, {
							name: String(r.name).slice(0, 32), units: Math.max(4, Math.min(60, parseInt(r.units, 10) || 42)),
							row: String(r.row || 'A').slice(0, 16), pos: parseInt(r.pos, 10) || null
						})),
						placements: json.placements || {},
						passives: Array.isArray(json.passives) ? json.passives : [],
						objects: Array.isArray(json.objects) ? json.objects.filter((o) => o && LakaInfra3DEditor.KINDS.includes(o.kind)) : [],
						room: Object.assign({w: 0, d: 0}, json.room || {}),
						site: String(json.site ?? this.draft.site ?? '').slice(0, 64),
						aisle: ['cold', 'hot'].includes(json.aisle) ? json.aisle : null,
						contain: ['cold', 'hot'].includes(json.contain) ? json.contain : 'none',
						flips: Array.isArray(json.flips) ? json.flips.map(String) : [],
						energy: LakaInfra3DEditor.energyOf(json.energy)
					};

					for (const r of this.draft.racks) {
						if (!this.draft.rows.includes(r.row)) {
							this.draft.rows.push(r.row);
						}
					}

					this.renumber();
					this.flash('info', this.t('Distribución cargada desde el archivo. Pulsa Guardar para aplicarla.'));
					this.touch();
				}
				catch (error) {
					this.flash('error', this.t('El archivo JSON no tiene el formato de LAKA Infra 3D.'));
				}
			}
			else {
				this.csvText = text;
				this.flash('info', this.t('Archivo cargado. Elige si agregar o reemplazar.'));
			}

			this.render();
		};

		reader.readAsText(file);
	}

	/**
	 * Importa líneas "rack;u;alto;host;tipo;cara;fila". Crea los racks que falten.
	 */
	importCsv(text, replace) {
		const d = this.draft;
		const report = [];
		const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#'));

		if (!lines.length) {
			this.flash('error', this.t('No hay líneas para importar.'));

			return;
		}

		const sep = lines[0].includes(';') ? ';' : (lines[0].includes('\t') ? '\t' : ',');
		const byName = new Map();

		for (const h of this.hosts.values()) {
			byName.set(h.host.toLowerCase(), h);
			byName.set(h.name.toLowerCase(), h);
		}

		if (replace) {
			d.placements = {};
			d.passives = [];
		}

		const typeMap = {
			servidor: 'server', server: 'server', red: 'network', rede: 'network', network: 'network', switch: 'network',
			router: 'network', firewall: 'network', storage: 'storage', nas: 'storage', san: 'storage', ups: 'ups',
			nobreak: 'ups', pdu: 'pdu', patch: 'patch', odf: 'patch', pasivo: 'patch', otro: 'other', other: 'other',
			outro: 'other'
		};
		let ok = 0;

		lines.forEach((line, i) => {
			const c = line.split(sep).map((x) => x.trim().replace(/^"|"$/g, ''));

			if (i === 0 && /^rack$/i.test(c[0]) && !/^\d+$/.test(c[1] || '')) {
				return;
			}

			const [rackName, uText, nText, hostName = '', typeText = '', faceText = '', rowName = '', wText = '', kgText = ''] = c;
			// Columnas opcionales de capacidad: consumo nominal (W) y peso (kg).
			const w = Math.max(0, Math.min(50000, parseInt(wText, 10) || 0));
			const kg = Math.max(0, Math.min(2000, Math.round((parseFloat(String(kgText).replace(',', '.')) || 0) * 10) / 10));
			const u = parseInt(uText, 10);
			const n = Math.max(1, Math.min(20, parseInt(nText, 10) || 1));
			const face = /^(atr[aá]s|back|trasera|posterior)$/i.test(faceText) ? 'back' : 'front';
			const type = typeMap[typeText.toLowerCase()] || null;

			if (!rackName || !(u > 0)) {
				report.push({ok: false, text: this.t('Línea %1$s: falta el rack o la U.', String(i + 1))});

				return;
			}

			if (!this.rack(rackName)) {
				const row = rowName || d.rows[0] || 'A';

				if (!d.rows.includes(row)) {
					d.rows.push(row);
				}

				d.racks.push({name: rackName.slice(0, 32), units: Math.max(this.defaultUnits(), u + n - 1), row,
					pos: d.racks.filter((r) => r.row === row).length + 1
				});
			}

			const rack = this.rack(rackName.slice(0, 32));

			if (u + n - 1 > rack.units) {
				rack.units = Math.min(60, u + n - 1);
			}

			if (hostName === '' || type === 'patch') {
				d.passives.push({rack: rack.name, u, n, face, type: type || 'patch',
					name: (hostName || `patch-${d.passives.length + 1}`).slice(0, 64), w, kg
				});
				ok++;

				return;
			}

			const h = byName.get(hostName.toLowerCase());

			if (!h && (type === 'pdu' || type === 'other')) {
				d.passives.push({rack: rack.name, u, n, face, type, name: hostName.slice(0, 64), w, kg});
				ok++;

				return;
			}

			if (!h) {
				report.push({ok: false, text: this.t('Línea %1$s: no se encontró el host %2$s en los grupos del widget.',
					String(i + 1), hostName)
				});

				return;
			}

			d.placements[h.id] = {rack: rack.name, u, n, face, type: type || h.type, w, kg};
			ok++;
		});

		this.renumber();
		report.unshift({ok: true, text: this.t('%1$s equipos importados.', String(ok))});
		this.importReport = report;
		this.touch();
	}

	exportCsv() {
		const lines = ['rack;u;alto;host;tipo;cara;fila;consumo_w;peso_kg'];
		const typeEs = {server: 'servidor', network: 'red', storage: 'storage', ups: 'ups', pdu: 'pdu', patch: 'patch',
			other: 'otro'};

		for (const rack of this.draft.racks.slice().sort((a, b) => a.row.localeCompare(b.row) || a.pos - b.pos)) {
			for (const it of this.itemsOf(rack.name).sort((a, b) => b.u - a.u)) {
				const name = it.kind === 'host' ? this.hosts.get(it.id).host : it.name;
				const type = typeEs[it.type] || 'otro';

				lines.push([rack.name, it.u, it.n, name, type, it.face === 'back' ? 'atras' : 'frente', rack.row, it.w || '',
					it.kg || '']
					.map((v) => String(v).replace(/;/g, ',')).join(';')
				);
			}
		}

		return lines.join('\n') + '\n';
	}

	fileRoom() {
		const room = (this.data.cfg && this.data.cfg.room) || this.data.room || 'sala';

		return room.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'sala';
	}

	download(name, text, mime) {
		const url = URL.createObjectURL(new Blob(['﻿' + text], {type: mime}));
		const a = document.createElement('a');

		a.href = url;
		a.download = name;
		document.body.appendChild(a);
		a.click();
		a.remove();
		setTimeout(() => URL.revokeObjectURL(url), 2000);
	}

	// ---------------------------------------------------------------- guardar

	async save() {
		const ed = this.data.editor;
		const body = new URLSearchParams();

		this.renumber();
		body.set('_csrf_token', ed.csrf);
		body.set('room_key', ed.room_key);
		body.set('rev', String(this.draft.rev));
		body.set('lang', this.data.lang || 'es');
		body.set('layout', JSON.stringify(this.draft));

		const btn = this.el.querySelector('[data-ed="save"]');

		btn.disabled = true;
		btn.textContent = this.t('Guardando…');

		try {
			const response = await fetch(ed.save_url, {
				method: 'POST',
				headers: {'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'},
				body: body.toString()
			});
			const json = await response.json();

			if (json.success) {
				if (json.storage) {
					this.data.editor.storage = json.storage;
				}

				if (json.rev !== undefined) {
					this.draft.rev = json.rev;
				}

				// Después de la sala: cableado, configuración de equipos y componentes de modelos.
				const error = this.saveCabling ? await this.saveCabling() : null;

				if (error) {
					this.flash('error', `${this.t('La sala se guardó, pero no el cableado:')} ${error}`);
					btn.disabled = false;
					btn.textContent = this.t('Guardar');
					this.render();

					return;
				}

				this.dirty = false;
				this.close(true, json.message || this.t('Distribución guardada.'));

				return;
			}

			const msg = json.error && json.error.messages ? json.error.messages.join(' ') : this.t('No se pudo guardar la distribución.');

			this.flash('error', msg);
		}
		catch (error) {
			this.flash('error', this.t('No se pudo guardar la distribución.') + ' ' + (error.message || ''));
		}

		this.render();
	}

	close(saved = false, message = '') {
		// Sin guardar: la vista vuelve a los papeles guardados.
		if (!saved && typeof LakaInfra3DCabling === 'function') {
			LakaInfra3DCabling.applyRoles(this.data.cabling);
		}

		this.el.removeEventListener('click', this.onClick);
		this.el.removeEventListener('change', this.onChange);
		this.el.removeEventListener('input', this.onInput);
		this.el.removeEventListener('keydown', this.onKey);
		this.el.removeEventListener('mousedown', this.onMsDown);
		this.el.removeEventListener('focusout', this.onMsOut);
		this.el.removeEventListener('pointerdown', this.onPointerDown);
		this.el.removeEventListener('pointermove', this.onPointerMove);
		this.el.removeEventListener('pointerup', this.onPointerUp);
		this.el.removeEventListener('pointercancel', this.onPointerUp);
		this.el.remove();

		if (this.cb.onClose) {
			this.cb.onClose(saved, message);
		}
	}
}
