/*
 * LAKA Infra 3D – gemelo digital de data center para Zabbix 7.0 – 8.0
 * © LAKA Soluciones Tecnológicas
 * Autor: Willian Tola
 * Licencia GPLv3
 *
 * Ventana "Operación" (0.22.0):
 * - Órdenes de trabajo de la sala (instalar, mover, retirar, mantenimiento) con su periodo de mantenimiento
 *   en Zabbix: mientras dura, Zabbix no genera problemas para esos hosts y la vista 3D los muestra en
 *   mantenimiento.
 * - Ciclo de vida de los equipos con las fechas del inventario de Zabbix (compra, fin de garantía, retiro).
 * - Etiquetas QR para racks y equipos: el QR del rack abre este dashboard con el rack seleccionado; el del
 *   equipo abre sus últimos datos en Zabbix.
 */

class LakaInfra3DOps {

	static TYPES = {install: 'Instalar', move: 'Mover', remove: 'Retirar', maint: 'Mantenimiento', other: 'Otro'};
	static STATUS = {open: 'Abierta', progress: 'En curso', done: 'Terminada', cancelled: 'Cancelada'};
	static DAY = 86400;

	constructor(scene) {
		this.scene = scene;
		this.el = null;
		this.tab = 'wo';
		this.woFilter = 'open';
		this.form = null;
		this.lifeDays = 90;
		this.lifeFilter = 'soon';
		this.qr = {what: 'racks', racks: null, size: 'm'};
	}

	t(...args) {
		return this.scene.t(...args);
	}

	get data() {
		return this.scene.data;
	}

	get cfg() {
		return (this.data && this.data.cfg) || {};
	}

	canEdit() {
		return !!this.cfg.wo_url;
	}

	orders() {
		return Array.isArray(this.cfg.wo) ? this.cfg.wo : [];
	}

	// ================================================================ datos derivados

	/** Órdenes abiertas o en curso; con rack, solo las que lo incluyen. */
	activeOrders(rack = null) {
		return this.orders().filter((o) => ['open', 'progress'].includes(o.status) && (!rack || (o.racks || []).includes(rack)));
	}

	/** true si la orden está dentro de su ventana de trabajo ahora. */
	static isNow(o) {
		const now = Date.now() / 1000;

		return o.start <= now && now <= o.end;
	}

	devices() {
		return ((this.scene.world && this.scene.world.devices) || []).map((x) => x.d);
	}

	/** Estado de garantía de un equipo: expired, soon, ok o none. */
	lifeState(d) {
		const inv = d.inv || {};
		const now = Date.now() / 1000;

		if (inv.decomm_ts && inv.decomm_ts < now) {
			return 'decomm';
		}

		if (!inv.exp_ts) {
			return 'none';
		}

		if (inv.exp_ts < now) {
			return 'expired';
		}

		return inv.exp_ts - now <= this.lifeDays * LakaInfra3DOps.DAY ? 'soon' : 'ok';
	}

	lifeCounts() {
		const c = {expired: 0, soon: 0, ok: 0, none: 0, decomm: 0};

		this.devices().forEach((d) => {
			if (/^\d+$/.test(String(d.id))) {
				c[this.lifeState(d)]++;
			}
		});

		return c;
	}

	/** Chips para la barra de estado (los agrega scene.renderLegend). */
	legendChips() {
		const esc = LakaInfra3DScene.esc;
		const active = this.activeOrders();
		const life = this.lifeCounts();
		let html = '';

		if (active.length) {
			const now = active.filter((o) => LakaInfra3DOps.isNow(o)).length;

			html += `<button type="button" class="laka3d-chip laka3d-chip-btn" data-act="ops-wo" title="${esc(this.t('Órdenes de trabajo abiertas'))}">${LakaInfra3DScene.icon('wrench')} ${esc(this.t('Órdenes'))} <strong>${active.length}</strong>${now ? ` <span class="laka3d-muted">(${esc(this.t('%1$s en curso ahora', String(now)))})</span>` : ''}</button>`;
		}

		if (life.expired + life.soon > 0) {
			html += `<button type="button" class="laka3d-chip laka3d-chip-btn" data-act="ops-life" title="${esc(this.t('Garantías vencidas o por vencer en %1$s días (inventario de Zabbix)', String(this.lifeDays)))}"><i style="background:#ffa059"></i>${esc(this.t('Garantías'))} <strong>${life.expired + life.soon}</strong></button>`;
		}

		return html;
	}

	/** Sección del panel del rack: órdenes del rack y accesos a nueva orden y etiqueta QR. */
	rackHtml(name) {
		const esc = LakaInfra3DScene.esc;
		const t = this.t.bind(this);
		const list = this.activeOrders(name);

		return `
			<div class="laka3d-ops-rack">
				${list.length ? `<h4>${esc(t('Órdenes de trabajo'))}</h4>${list.map((o) => `<button type="button" class="laka3d-ops-mini" data-act="ops-open-wo" data-wo="${esc(o.id)}"><strong>${esc(o.id)}</strong> ${esc(o.title)} <span class="laka3d-badge${LakaInfra3DOps.isNow(o) ? '' : ' laka3d-badge-muted'}">${esc(LakaInfra3DOps.isNow(o) ? t('Ahora') : this.when(o.start))}</span></button>`).join('')}` : ''}
				<div class="laka3d-ops-rackbtns">
					${this.canEdit() ? `<button type="button" class="laka3d-btn" data-act="ops-new-wo" data-rack="${esc(name)}">${LakaInfra3DScene.icon('wrench')}<span>${esc(t('Nueva orden de trabajo'))}</span></button>` : ''}
					<button type="button" class="laka3d-btn" data-act="ops-qr-rack" data-rack="${esc(name)}">${LakaInfra3DScene.icon('qr')}<span>${esc(t('Etiquetas QR'))}</span></button>
				</div>
			</div>`;
	}

	// ================================================================ ventana

	open(tab = null, opts = {}) {
		const s = this.scene;

		if (!s.world || (s.noc && s.noc.active)) {
			return;
		}

		if (tab) {
			this.tab = tab;
		}

		if (opts.newOrder) {
			this.tab = 'wo';
			this.form = this.blankOrder(opts.rack ? [opts.rack] : []);
		}

		if (opts.order) {
			this.tab = 'wo';
			this.woFilter = 'all';
			this.focusId = opts.order;
		}

		if (opts.qrRack) {
			this.tab = 'qr';
			this.qr.racks = [opts.qrRack];
			this.qr.what = 'both';
		}

		if (!this.el) {
			this.el = document.createElement('div');
			this.el.className = 'laka3d-msp-overlay laka3d-ops-overlay';
			this.el.addEventListener('click', (e) => this.click(e));
			this.el.addEventListener('change', (e) => this.change(e));
			this.el.addEventListener('keydown', (e) => {
				if (e.key === 'Escape') {
					e.stopPropagation();
					this.close();
				}
			});
			s.root.appendChild(this.el);
		}

		this.el.hidden = false;
		this.message = null;
		this.render();
		this.el.querySelector('.laka3d-msp').focus();
	}

	close() {
		if (this.el) {
			this.el.hidden = true;
		}

		this.form = null;
	}

	render() {
		const esc = LakaInfra3DScene.esc;
		const t = this.t.bind(this);
		const tabs = [['wo', 'Órdenes de trabajo'], ['life', 'Ciclo de vida'], ['qr', 'Etiquetas QR']];
		let body = '';

		if (this.tab === 'wo') {
			body = this.form ? this.renderForm() : this.renderOrders();
		}
		else if (this.tab === 'life') {
			body = this.renderLife();
		}
		else {
			body = this.renderQr();
		}

		this.el.innerHTML = `
			<div class="laka3d-msp laka3d-ops" role="dialog" aria-modal="true" tabindex="-1" aria-label="${esc(t('Operación'))}">
				<div class="laka3d-msp-head">
					<strong>${esc(t('Operación'))}</strong>
					<button type="button" class="laka3d-msp-x" data-ops="close" aria-label="${esc(t('Cerrar'))}">✕</button>
				</div>
				<div class="laka3d-ed-tabs" role="tablist">
					${tabs.map(([id, label]) => `<button type="button" role="tab" data-ops-tab="${id}" aria-selected="${this.tab === id}">${esc(t(label))}</button>`).join('')}
				</div>
				${this.message ? `<div class="laka3d-ed-msg laka3d-ed-msg-${esc(this.message.kind)}" role="status">${esc(this.message.text)}</div>` : ''}
				<div class="laka3d-ops-body">${body}</div>
				<div class="laka3d-ops-foot laka3d-muted">© LAKA Soluciones Tecnológicas</div>
			</div>`;

		if (this.focusId) {
			const card = this.el.querySelector(`[data-wo-card="${CSS.escape(this.focusId)}"]`);

			if (card) {
				card.classList.add('is-focus');
				card.scrollIntoView({block: 'nearest'});
			}

			this.focusId = null;
		}
	}

	when(ts) {
		const lang = this.data.lang === 'pt' ? 'pt-BR' : (this.data.lang === 'en' ? 'en-US' : 'es');

		return ts ? new Date(ts * 1000).toLocaleString(lang, {dateStyle: 'short', timeStyle: 'short'}) : '—';
	}

	day(ts) {
		const lang = this.data.lang === 'pt' ? 'pt-BR' : (this.data.lang === 'en' ? 'en-US' : 'es');

		return ts ? new Date(ts * 1000).toLocaleDateString(lang) : '—';
	}

	// ================================================================ órdenes de trabajo

	renderOrders() {
		const esc = LakaInfra3DScene.esc;
		const t = this.t.bind(this);
		const all = this.orders();
		const open = all.filter((o) => ['open', 'progress'].includes(o.status));
		const list = (this.woFilter === 'open' ? open : (this.woFilter === 'closed' ? all.filter((o) => !open.includes(o)) : all))
			.slice().sort((a, b) => (a.start - b.start) * (this.woFilter === 'closed' ? -1 : 1));

		return `
			<div class="laka3d-ed-row">
				<span class="laka3d-seg laka3d-seg-sm" role="group">
					${[['open', 'Abiertas'], ['closed', 'Cerradas'], ['all', 'Todas']].map(([k, l]) => `<button type="button" data-ops="wo-filter" data-v="${k}" aria-pressed="${this.woFilter === k}">${esc(t(l))}</button>`).join('')}
				</span>
				${this.canEdit() ? `<button type="button" class="laka3d-btn laka3d-btn-primary" data-ops="wo-new">${esc(t('Nueva orden de trabajo'))}</button>` : `<span class="laka3d-muted">${esc(t('Solo quien puede editar la sala crea órdenes de trabajo.'))}</span>`}
			</div>
			<p class="laka3d-muted">${esc(t('Con "Mantenimiento en Zabbix", la orden crea un periodo de mantenimiento oficial para sus equipos: Zabbix no genera problemas mientras dura y la vista 3D los muestra en mantenimiento. Al terminar o cancelar la orden, el periodo se cierra.'))}</p>
			<div class="laka3d-ops-list">
				${list.length ? list.map((o) => this.orderCard(o)).join('') : `<p class="laka3d-muted">${esc(t('No hay órdenes en esta lista.'))}</p>`}
			</div>`;
	}

	orderCard(o) {
		const esc = LakaInfra3DScene.esc;
		const t = this.t.bind(this);
		const active = ['open', 'progress'].includes(o.status);
		const names = new Map(this.devices().map((d) => [String(d.id), d.name]));
		const hosts = (o.hostids || []).map((id) => names.get(String(id)) || `#${id}`);
		const now = active && LakaInfra3DOps.isNow(o);
		const maint = o.maint ? (o.maint === 2 ? t('sin recolección de datos') : t('con recolección de datos')) : '';
		const btn = (act, label, primary = false) => `<button type="button" class="laka3d-btn${primary ? ' laka3d-btn-primary' : ''}" data-ops="${act}" data-wo="${esc(o.id)}">${esc(t(label))}</button>`;

		return `
			<div class="laka3d-ops-card st-${esc(o.status)}" data-wo-card="${esc(o.id)}">
				<div class="laka3d-ops-cardhead">
					<strong>${esc(o.id)}</strong>
					<span>${esc(o.title)}</span>
					<span class="laka3d-badge laka3d-badge-muted">${esc(t(LakaInfra3DOps.TYPES[o.type] || 'Otro'))}</span>
					<span class="laka3d-badge${o.status === 'progress' || now ? '' : ' laka3d-badge-muted'}">${esc(t(LakaInfra3DOps.STATUS[o.status] || o.status))}${now && o.status === 'open' ? ' · ' + esc(t('Ahora')) : ''}</span>
				</div>
				<div class="laka3d-muted">${esc(this.when(o.start))} → ${esc(this.when(o.end))}${o.who ? ` · ${esc(t('Responsable'))}: ${esc(o.who)}` : ''}${o.ticket ? ` · ${esc(t('Ticket'))}: ${esc(o.ticket)}` : ''}</div>
				${(o.racks || []).length ? `<div>${esc(t('Racks'))}: ${o.racks.map((r) => `<button type="button" class="laka3d-linkbtn" data-ops="go-rack" data-rack="${esc(r)}">${esc(r)}</button>`).join(', ')}</div>` : ''}
				${hosts.length ? `<div class="laka3d-muted">${esc(t('Equipos'))} (${hosts.length}): ${esc(hosts.slice(0, 12).join(', '))}${hosts.length > 12 ? ' …' : ''}</div>` : ''}
				${maint ? `<div>${LakaInfra3DScene.icon('wrench')} ${esc(t('Mantenimiento en Zabbix'))}: ${esc(maint)}${o.mid ? ` <span class="laka3d-muted">(#${esc(o.mid)})</span>` : ''}</div>` : ''}
				${o.notes ? `<div class="laka3d-ops-notes">${esc(o.notes)}</div>` : ''}
				<div class="laka3d-muted">${esc(t('Creada por %1$s el %2$s', o.by || '—', this.when(o.created)))}${o.closed ? ` · ${esc(t('Cerrada el %1$s', this.when(o.closed)))}` : ''}</div>
				${active && this.canEdit() ? `<div class="laka3d-ed-row">
					${btn('wo-edit', 'Editar')}
					${o.status === 'open' ? btn('wo-progress', 'Iniciar') : ''}
					${btn('wo-done', 'Terminar', true)}
					${btn('wo-cancel', 'Cancelar orden')}
				</div>` : ''}
				${!active && this.canEdit() ? `<div class="laka3d-ed-row">${this.confirmDel === o.id ? btn('wo-delete', 'Confirmar: borrar', true) : btn('wo-delete', 'Borrar')}</div>` : ''}
			</div>`;
	}

	blankOrder(racks = []) {
		const now = Math.ceil(Date.now() / 1000 / 900) * 900;
		const hostids = this.devices().filter((d) => racks.includes(d.rack) && /^\d+$/.test(String(d.id))).map((d) => String(d.id));

		return {id: '', title: '', type: 'maint', racks, hostids, start: now, end: now + 2 * 3600, who: '', ticket: '',
			notes: '', maint: 1};
	}

	static localInput(ts) {
		const d = new Date(ts * 1000);
		const p = (n) => String(n).padStart(2, '0');

		return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
	}

	renderForm() {
		const esc = LakaInfra3DScene.esc;
		const t = this.t.bind(this);
		const f = this.form;
		const racks = [...this.scene.world.racks.entries()].filter(([, r]) => !r.cooler).map(([n]) => n);
		const devs = this.devices().filter((d) => f.racks.includes(d.rack) && /^\d+$/.test(String(d.id)));

		return `
			<div class="laka3d-ops-form">
				<h4>${esc(f.id ? t('Editar %1$s', f.id) : t('Nueva orden de trabajo'))}</h4>
				<label>${esc(t('Título'))}<input type="text" maxlength="120" data-wo-f="title" value="${esc(f.title)}" placeholder="${esc(t('Ej.: Cambio de fuente en srv-web02'))}"></label>
				<div class="laka3d-ed-row">
					<label>${esc(t('Tipo'))}<select data-wo-f="type">${Object.entries(LakaInfra3DOps.TYPES).map(([k, l]) => `<option value="${k}"${f.type === k ? ' selected' : ''}>${esc(t(l))}</option>`).join('')}</select></label>
					<label>${esc(t('Inicio'))}<input type="datetime-local" data-wo-f="start" value="${LakaInfra3DOps.localInput(f.start)}"></label>
					<label>${esc(t('Fin'))}<input type="datetime-local" data-wo-f="end" value="${LakaInfra3DOps.localInput(f.end)}"></label>
				</div>
				<div class="laka3d-ed-row">
					<label>${esc(t('Responsable'))}<input type="text" maxlength="64" data-wo-f="who" value="${esc(f.who)}"></label>
					<label>${esc(t('Ticket'))}<input type="text" maxlength="64" data-wo-f="ticket" value="${esc(f.ticket)}" placeholder="${esc(t('Ej.: INC-1234'))}"></label>
					<label>${esc(t('Mantenimiento en Zabbix'))}<select data-wo-f="maint">
						<option value="0"${f.maint === 0 ? ' selected' : ''}>${esc(t('No crear'))}</option>
						<option value="1"${f.maint === 1 ? ' selected' : ''}>${esc(t('Con recolección de datos'))}</option>
						<option value="2"${f.maint === 2 ? ' selected' : ''}>${esc(t('Sin recolección de datos'))}</option>
					</select></label>
				</div>
				<fieldset><legend>${esc(t('Racks'))}</legend>
					<div class="laka3d-ed-grouplist">${racks.map((n) => `<label><input type="checkbox" data-wo-rack="${esc(n)}"${f.racks.includes(n) ? ' checked' : ''}> ${esc(n)}</label>`).join('')}</div>
				</fieldset>
				<fieldset><legend>${esc(t('Equipos (hosts de Zabbix)'))} · ${f.hostids.length}/${devs.length}</legend>
					${devs.length ? `<div class="laka3d-ed-grouplist">${devs.map((d) => `<label><input type="checkbox" data-wo-host="${esc(d.id)}"${f.hostids.includes(String(d.id)) ? ' checked' : ''}> ${esc(d.name)} <span class="laka3d-muted">${esc(d.rack)}${d.u ? ' U' + d.u : ''}</span></label>`).join('')}</div>` : `<p class="laka3d-muted">${esc(t('Elige uno o más racks para ver sus equipos.'))}</p>`}
				</fieldset>
				<label>${esc(t('Notas'))}<textarea maxlength="1000" rows="3" data-wo-f="notes">${esc(f.notes)}</textarea></label>
				${f.maint && !f.hostids.length ? `<p class="laka3d-muted">${esc(t('Sin equipos elegidos no se crea el mantenimiento en Zabbix.'))}</p>` : ''}
				<div class="laka3d-ed-row">
					<button type="button" class="laka3d-btn" data-ops="wo-form-cancel">${esc(t('Cancelar'))}</button>
					<button type="button" class="laka3d-btn laka3d-btn-primary" data-ops="wo-save">${esc(t('Guardar orden'))}</button>
				</div>
			</div>`;
	}

	readForm() {
		const f = this.form;
		const q = (k) => this.el.querySelector(`[data-wo-f="${k}"]`);
		const ts = (v) => {
			const d = new Date(v);

			return isNaN(d.getTime()) ? 0 : Math.round(d.getTime() / 1000);
		};

		if (!q('title')) {
			return;
		}

		f.title = q('title').value;
		f.type = q('type').value;
		f.start = ts(q('start').value) || f.start;
		f.end = ts(q('end').value) || f.end;
		f.who = q('who').value;
		f.ticket = q('ticket').value;
		f.maint = parseInt(q('maint').value, 10) || 0;
		f.notes = q('notes').value;
	}

	async post(fields) {
		const body = new URLSearchParams({lang: this.data.lang || 'es', room_key: this.cfg.wo_room || '', _csrf_token: this.cfg.wo_csrf || '', ...fields});

		try {
			const response = await fetch(this.cfg.wo_url, {method: 'POST',
				headers: {'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'}, body: body.toString()
			});
			const json = await response.json();

			if (!json.success) {
				throw new Error((json.error && json.error.messages || []).join(' ') || this.t('No se pudo completar la operación.'));
			}

			this.cfg.wo = json.orders;
			this.message = json.warning ? {kind: 'error', text: json.warning} : {kind: 'info', text: json.message};
			this.scene.renderLegend && this.scene.renderLegend();

			return json;
		}
		catch (error) {
			this.message = {kind: 'error', text: error.message || this.t('No se pudo completar la operación.')};

			return null;
		}
	}

	async saveForm() {
		this.readForm();

		const json = await this.post({op: 'save', id: this.form.id, order: JSON.stringify(this.form)});

		if (json) {
			this.focusId = json.order && json.order.id;
			this.form = null;
			this.woFilter = 'open';
		}

		this.render();
	}

	// ================================================================ ciclo de vida

	renderLife() {
		const esc = LakaInfra3DScene.esc;
		const t = this.t.bind(this);
		const c = this.lifeCounts();
		const order = {expired: 0, soon: 1, decomm: 2, none: 3, ok: 4};
		const rows = this.devices().filter((d) => /^\d+$/.test(String(d.id)))
			.map((d) => ({d, st: this.lifeState(d)}))
			.filter((x) => this.lifeFilter === 'all' || (this.lifeFilter === 'soon' ? ['expired', 'soon'].includes(x.st) : x.st === this.lifeFilter))
			.sort((a, b) => order[a.st] - order[b.st] || ((a.d.inv || {}).exp_ts || 0) - ((b.d.inv || {}).exp_ts || 0));
		const label = {expired: t('Vencida'), soon: t('Por vencer'), ok: t('Vigente'), none: t('Sin dato'), decomm: t('Retirado')};
		const days = (d) => {
			const e = (d.inv || {}).exp_ts;

			if (!e) {
				return '';
			}

			const n = Math.round((e - Date.now() / 1000) / LakaInfra3DOps.DAY);

			return n >= 0 ? t('en %1$s días', String(n)) : t('hace %1$s días', String(-n));
		};

		return `
			<div class="laka3d-ed-row">
				<span class="laka3d-chip"><i style="background:#e45959"></i>${esc(t('Vencidas'))} <strong>${c.expired}</strong></span>
				<span class="laka3d-chip"><i style="background:#ffa059"></i>${esc(t('Por vencer'))} <strong>${c.soon}</strong></span>
				<span class="laka3d-chip"><i style="background:#59db8f"></i>${esc(t('Vigentes'))} <strong>${c.ok}</strong></span>
				<span class="laka3d-chip"><i style="background:#97aab3"></i>${esc(t('Sin fecha'))} <strong>${c.none}</strong></span>
				<label>${esc(t('Aviso con'))} <select data-ops-f="days">${[30, 60, 90, 180, 365].map((n) => `<option value="${n}"${this.lifeDays === n ? ' selected' : ''}>${n} ${esc(t('días'))}</option>`).join('')}</select></label>
				<span class="laka3d-seg laka3d-seg-sm" role="group">
					${[['soon', 'Vencidas y por vencer'], ['none', 'Sin fecha'], ['all', 'Todos']].map(([k, l]) => `<button type="button" data-ops="life-filter" data-v="${k}" aria-pressed="${this.lifeFilter === k}">${esc(t(l))}</button>`).join('')}
				</span>
			</div>
			<p class="laka3d-muted">${esc(t('Datos del inventario de cada host en Zabbix (Fecha de compra del HW, Fecha de expiración de garantía del HW, Fecha de baja del HW). Formatos aceptados: AAAA-MM-DD, DD/MM/AAAA o AAAA-MM. El inventario se completa en la configuración del host o con ítems que lo llenan automáticamente.'))}</p>
			<table class="laka3d-ed-table laka3d-ops-life">
				<thead><tr><th>${esc(t('Equipo'))}</th><th>${esc(t('Ubicación'))}</th><th>${esc(t('Marca / modelo'))}</th><th>${esc(t('Serie'))}</th><th>${esc(t('Compra'))}</th><th>${esc(t('Garantía hasta'))}</th><th>${esc(t('Estado'))}</th><th></th></tr></thead>
				<tbody>${rows.map(({d, st}) => `<tr class="lf-${st}">
					<td>${esc(d.name)}</td>
					<td>${esc(d.rack)}${d.u ? ' · U' + d.u : ''}</td>
					<td>${esc([d.inv && d.inv.vendor, d.inv && d.inv.model].filter(Boolean).join(' ') || '—')}</td>
					<td>${esc((d.inv && d.inv.serial) || '—')}</td>
					<td>${esc(d.inv && d.inv.buy_ts ? this.day(d.inv.buy_ts) : ((d.inv && d.inv.buy) || '—'))}</td>
					<td>${esc(d.inv && d.inv.exp_ts ? this.day(d.inv.exp_ts) : ((d.inv && d.inv.exp) || '—'))}</td>
					<td><span class="laka3d-lf laka3d-lf-${st}">${esc(label[st])}</span> <span class="laka3d-muted">${esc(st === 'decomm' ? '' : days(d))}</span></td>
					<td><button type="button" class="laka3d-linkbtn" data-ops="go-dev" data-dev="${esc(d.id)}">${esc(t('Ver'))}</button></td>
				</tr>`).join('') || `<tr><td colspan="8" class="laka3d-muted">${esc(t('No hay equipos en esta lista.'))}</td></tr>`}</tbody>
			</table>
			<div class="laka3d-ed-row"><button type="button" class="laka3d-btn" data-ops="life-csv">${esc(t('CSV de ciclo de vida'))}</button></div>`;
	}

	lifeCsv() {
		const t = this.t.bind(this);
		const rows = [[t('Equipo'), t('Host'), t('Rack'), 'U', t('Marca'), t('Modelo'), t('Serie'), t('Compra'), t('Instalación'),
			t('Garantía hasta'), t('Retiro'), t('Estado')]];
		const label = {expired: t('Vencida'), soon: t('Por vencer'), ok: t('Vigente'), none: t('Sin dato'), decomm: t('Retirado')};

		this.devices().filter((d) => /^\d+$/.test(String(d.id))).forEach((d) => {
			const i = d.inv || {};

			rows.push([d.name, d.host, d.rack, d.u || '', i.vendor || '', i.model || '', i.serial || '', i.buy || '', i.inst || '',
				i.exp || '', i.decomm || '', label[this.lifeState(d)]]);
		});

		const csv = '﻿' + rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(';')).join('\r\n');

		this.scene.report
			? this.scene.report.download(`laka-infra3d-ciclo-de-vida-${new Date().toISOString().slice(0, 10)}.csv`, csv)
			: null;
	}

	// ================================================================ etiquetas QR

	rackUrl(name) {
		const base = window.location.href.split('#')[0];

		return `${base}#laka3d-rack=${encodeURIComponent(name)}`;
	}

	hostUrl(id) {
		const dir = window.location.href.split('#')[0].split('?')[0].replace(/[^/]*$/, '');

		return `${dir}${this.cfg.host_url || 'zabbix.php?action=latest.view&filter_set=1&hostids%5B%5D='}${encodeURIComponent(id)}`;
	}

	rackLabelId(name) {
		const cab = this.data.cabling;

		return cab && cab.fs && typeof LakaInfra3DCabling !== 'undefined' ? LakaInfra3DCabling.rackId(cab, name) : name;
	}

	renderQr() {
		const esc = LakaInfra3DScene.esc;
		const t = this.t.bind(this);
		const racks = [...this.scene.world.racks.entries()].filter(([, r]) => !r.cooler).map(([n]) => n);

		if (!Array.isArray(this.qr.racks)) {
			this.qr.racks = racks.slice();
		}

		const chosen = racks.filter((n) => this.qr.racks.includes(n));
		const devs = this.devices().filter((d) => chosen.includes(d.rack) && /^\d+$/.test(String(d.id)));
		const count = (this.qr.what !== 'devices' ? chosen.length : 0) + (this.qr.what !== 'racks' ? devs.length : 0);
		const sample = chosen[0] ? LakaInfra3DQR.svg(this.rackUrl(chosen[0]), 96) : '';

		return `
			<div class="laka3d-ops-qr">
				<div>
					<fieldset><legend>${esc(t('Qué imprimir'))}</legend>
						${[['racks', 'Racks'], ['devices', 'Equipos'], ['both', 'Racks y equipos']].map(([k, l]) => `<label><input type="radio" name="laka3d-qr-what" data-ops-f="what" value="${k}"${this.qr.what === k ? ' checked' : ''}> ${esc(t(l))}</label>`).join('')}
					</fieldset>
					<fieldset><legend>${esc(t('Tamaño de etiqueta'))}</legend>
						${[['s', 'Chica (50 × 25 mm)'], ['m', 'Mediana (70 × 35 mm)']].map(([k, l]) => `<label><input type="radio" name="laka3d-qr-size" data-ops-f="size" value="${k}"${this.qr.size === k ? ' checked' : ''}> ${esc(t(l))}</label>`).join('')}
					</fieldset>
					<fieldset><legend>${esc(t('Racks'))} · <button type="button" class="laka3d-linkbtn" data-ops="qr-all">${esc(t('Todos'))}</button> · <button type="button" class="laka3d-linkbtn" data-ops="qr-none">${esc(t('Ninguno'))}</button></legend>
						<div class="laka3d-ed-grouplist">${racks.map((n) => `<label><input type="checkbox" data-qr-rack="${esc(n)}"${chosen.includes(n) ? ' checked' : ''}> ${esc(n)}</label>`).join('')}</div>
					</fieldset>
				</div>
				<div class="laka3d-ops-qrprev">
					${sample ? `<div class="laka3d-qr-label size-${esc(this.qr.size)}">${sample}<div><strong>${esc(this.rackLabelId(chosen[0]))}</strong><span>${esc(t('Rack'))} ${esc(chosen[0])}</span><span>${esc(this.roomLine())}</span></div></div>` : ''}
					<p class="laka3d-muted">${esc(t('El QR del rack abre este dashboard con el rack seleccionado. El QR del equipo abre sus últimos datos en Zabbix. Se generan aquí mismo, sin servicios externos.'))}</p>
					<button type="button" class="laka3d-btn laka3d-btn-primary" data-ops="qr-print"${count ? '' : ' disabled'}>${esc(t('Imprimir %1$s etiquetas', String(count)))}</button>
				</div>
			</div>`;
	}

	roomLine() {
		const site = (this.cfg.site || '').trim();
		const room = (this.cfg.room || '').trim() || this.t('Sala principal');

		return site ? `${site} · ${room}` : room;
	}

	printLabels() {
		const t = this.t.bind(this);
		const esc = LakaInfra3DScene.esc;
		const racks = [...this.scene.world.racks.entries()].filter(([n, r]) => !r.cooler && this.qr.racks.includes(n));
		const labels = [];
		const size = this.qr.size === 's' ? {w: 50, h: 25, qr: 21} : {w: 70, h: 35, qr: 30};

		racks.forEach(([name, rack]) => {
			if (this.qr.what !== 'devices') {
				labels.push({qr: this.rackUrl(name), id: this.rackLabelId(name), l1: `${t('Rack')} ${name}`,
					l2: `${this.roomLine()}${rack.def.row_label ? ` · ${t('Fila')} ${rack.def.row_label}` : ''}`});
			}

			if (this.qr.what !== 'racks') {
				this.devices().filter((d) => d.rack === name && /^\d+$/.test(String(d.id))).sort((a, b) => (b.u || 0) - (a.u || 0)).forEach((d) => {
					labels.push({qr: this.hostUrl(d.id), id: d.name, l1: `${this.rackLabelId(name)}${d.u ? ' · U' + d.u : ''}`,
						l2: [d.inv && d.inv.serial ? `S/N ${d.inv.serial}` : '', d.inv && d.inv.asset ? d.inv.asset : ''].filter(Boolean).join(' · ') || d.host});
				});
			}
		});

		const html = `<!DOCTYPE html><html lang="${esc(this.data.lang || 'es')}"><head><meta charset="utf-8">
<title>${esc(t('Etiquetas QR'))} · LAKA Infra 3D</title>
<style>
@page { size: A4; margin: 10mm; }
body { font-family: Arial, Helvetica, sans-serif; margin: 0; color: #000; }
.bar { padding: 8px 10mm; background: #f2f2f2; display: flex; gap: 10px; align-items: center; }
.bar button { padding: 6px 14px; font-size: 14px; cursor: pointer; }
.sheet { display: flex; flex-wrap: wrap; gap: 3mm; padding: 10mm; }
.lbl { width: ${size.w}mm; height: ${size.h}mm; box-sizing: border-box; border: 0.2mm dashed #999; padding: 1.5mm;
	display: flex; gap: 2mm; align-items: center; break-inside: avoid; overflow: hidden; }
.lbl svg { width: ${size.qr}mm; height: ${size.qr}mm; flex: none; }
.lbl div { display: flex; flex-direction: column; min-width: 0; font-size: ${this.qr.size === 's' ? 7 : 8.5}pt; line-height: 1.25; }
.lbl strong { font-size: ${this.qr.size === 's' ? 9 : 11}pt; word-break: break-all; }
.lbl span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.foot { padding: 0 10mm 6mm; font-size: 8pt; color: #555; }
@media print { .bar { display: none; } }
</style></head><body>
<div class="bar"><button type="button" data-print>${esc(t('Imprimir'))}</button><span>${esc(t('%1$s etiquetas', String(labels.length)))} · ${esc(this.roomLine())}</span></div>
<div class="sheet">${labels.map((l) => `<div class="lbl">${LakaInfra3DQR.svg(l.qr, 100)}<div><strong>${esc(l.id)}</strong><span>${esc(l.l1)}</span><span>${esc(l.l2)}</span></div></div>`).join('')}</div>
<div class="foot">LAKA Infra 3D · © LAKA Soluciones Tecnológicas</div>
</body></html>`;

		const w = window.open('', '_blank');

		if (!w) {
			this.scene.report && this.scene.report.download(`laka-infra3d-etiquetas-qr.html`, html, 'text/html;charset=utf-8');

			return;
		}

		w.document.open();
		w.document.write(html);
		w.document.close();

		const bind = () => {
			const b = w.document.querySelector('[data-print]');

			if (b) {
				b.addEventListener('click', () => w.print());
			}
		};

		w.document.readyState === 'loading' ? w.addEventListener('DOMContentLoaded', bind) : bind();
	}

	// ================================================================ eventos

	click(e) {
		if (e.target === this.el) {
			this.close();

			return;
		}

		const tab = e.target.closest('[data-ops-tab]');

		if (tab) {
			if (this.form) {
				this.readForm();
			}
			this.tab = tab.dataset.opsTab;
			this.message = null;
			this.render();

			return;
		}

		const wr = e.target.closest('[data-wo-rack]');
		const wh = e.target.closest('[data-wo-host]');
		const qr = e.target.closest('[data-qr-rack]');

		if (wr || wh || qr) {
			return;
		}

		const btn = e.target.closest('[data-ops]');

		if (!btn || btn.disabled) {
			return;
		}

		const id = btn.dataset.wo;

		switch (btn.dataset.ops) {
			case 'close':
				this.close();
				break;

			case 'wo-filter':
				this.woFilter = btn.dataset.v;
				this.render();
				break;

			case 'wo-new':
				this.form = this.blankOrder([]);
				this.message = null;
				this.render();
				break;

			case 'wo-edit': {
				const o = this.orders().find((x) => x.id === id);

				this.form = JSON.parse(JSON.stringify(o));
				this.form.hostids = (this.form.hostids || []).map(String);
				this.message = null;
				this.render();
				break;
			}

			case 'wo-form-cancel':
				this.form = null;
				this.render();
				break;

			case 'wo-save':
				btn.disabled = true;
				this.saveForm();
				break;

			case 'wo-progress':
			case 'wo-done':
			case 'wo-cancel':
				btn.disabled = true;
				this.post({op: 'status', id, status: {'wo-progress': 'progress', 'wo-done': 'done', 'wo-cancel': 'cancelled'}[btn.dataset.ops]})
					.then(() => this.render());
				break;

			case 'wo-delete':
				if (this.confirmDel === id) {
					this.confirmDel = null;
					btn.disabled = true;
					this.post({op: 'delete', id}).then(() => this.render());
				}
				else {
					this.confirmDel = id;
					this.render();
				}
				break;

			case 'go-rack':
				this.close();
				this.scene.openRack(btn.dataset.rack);
				break;

			case 'go-dev': {
				const dev = (this.scene.world.devices || []).find((x) => String(x.d.id) === btn.dataset.dev);

				if (dev) {
					this.close();
					this.scene.selectDevice(dev);
				}
				break;
			}

			case 'life-filter':
				this.lifeFilter = btn.dataset.v;
				this.render();
				break;

			case 'life-csv':
				this.lifeCsv();
				break;

			case 'qr-all':
				this.qr.racks = [...this.scene.world.racks.entries()].filter(([, r]) => !r.cooler).map(([n]) => n);
				this.render();
				break;

			case 'qr-none':
				this.qr.racks = [];
				this.render();
				break;

			case 'qr-print':
				this.printLabels();
				break;
		}
	}

	change(e) {
		const el = e.target;

		if (el.dataset.woRack !== undefined && this.form) {
			this.readForm();

			const name = el.dataset.woRack;
			const inRack = this.devices().filter((d) => d.rack === name && /^\d+$/.test(String(d.id))).map((d) => String(d.id));

			if (el.checked) {
				this.form.racks.push(name);
				// Al elegir un rack se marcan todos sus equipos (se pueden desmarcar).
				this.form.hostids = [...new Set([...this.form.hostids, ...inRack])];
			}
			else {
				this.form.racks = this.form.racks.filter((r) => r !== name);
				this.form.hostids = this.form.hostids.filter((h) => !inRack.includes(h));
			}

			this.render();

			return;
		}

		if (el.dataset.woHost !== undefined && this.form) {
			this.readForm();

			const id = String(el.dataset.woHost);

			this.form.hostids = el.checked ? [...new Set([...this.form.hostids, id])] : this.form.hostids.filter((h) => h !== id);
			this.render();

			return;
		}

		if (el.dataset.woF === 'maint' && this.form) {
			this.readForm();
			this.render();

			return;
		}

		if (el.dataset.qrRack !== undefined) {
			const name = el.dataset.qrRack;

			this.qr.racks = el.checked ? [...new Set([...this.qr.racks, name])] : this.qr.racks.filter((r) => r !== name);
			this.render();

			return;
		}

		switch (el.dataset.opsF) {
			case 'days':
				this.lifeDays = parseInt(el.value, 10) || 90;
				this.render();
				this.scene.renderLegend && this.scene.renderLegend();
				break;

			case 'what':
				this.qr.what = el.value;
				this.render();
				break;

			case 'size':
				this.qr.size = el.value;
				this.render();
				break;
		}
	}
}
