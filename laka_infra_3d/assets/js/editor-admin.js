/*
 * LAKA Infra 3D – gemelo digital de data center para Zabbix 7.0 – 8.0
 * © LAKA Soluciones Tecnológicas
 * Autor: Willian Tola
 * Licencia GPLv3
 *
 * Editor de sala, pestaña "Historial y respaldo" (0.21.0). Se suma a LakaInfra3DEditor (assets/js/editor.js).
 *
 * - Historial de cambios de la sala (y de lo general: sitios, modelos, permisos): quién, cuándo y qué cambió,
 *   con "deshacer" del último cambio.
 * - Permiso de edición por sala: grupos de usuarios de Zabbix (solo Super admin lo cambia).
 * - Respaldo completo del módulo: descargar y restaurar (vista previa, reemplazar o combinar). Solo Super admin.
 */

Object.assign(LakaInfra3DEditor.prototype, {

	/** Fecha y hora en el idioma del widget. */
	admDate(ts) {
		return ts ? new Date(ts * 1000).toLocaleString(this.data.lang === 'pt' ? 'pt-BR' : (this.data.lang === 'en' ? 'en-US' : 'es')) : '—';
	},

	adminData() {
		return (this.data.editor && this.data.editor.admin) || null;
	},

	renderAdmin() {
		const a = this.adminData();

		if (!a) {
			return '';
		}

		this.adm = this.adm || {scope: 'room', images: true, mode: 'replace', groupFilter: ''};

		return this.renderHistoryCard() + this.renderAclCard() + this.renderBackupCard();
	},

	// ---------------------------------------------------------------- historial

	renderHistoryCard() {
		const esc = LakaInfra3DEditor.esc;
		const t = this.t.bind(this);
		const a = this.adminData();
		const list = this.adm.scope === 'global' ? (this.adm.globalHistory || null) : (a.history || []);
		const rows = list === null
			? `<p class="laka3d-muted">${esc(t('Cargando…'))}</p>`
			: (list.length ? list.map((e) => this.historyRow(e)).join('') : `<p class="laka3d-muted">${esc(t('Todavía no hay cambios registrados.'))}</p>`);

		return `
			<section class="laka3d-ed-card laka3d-ed-hist">
				<div class="laka3d-ed-cardhead">
					<strong>${esc(t('Historial de cambios'))}</strong>
					<span class="laka3d-seg laka3d-seg-sm" role="group">
						<button type="button" data-adm="scope" data-scope="room" aria-pressed="${this.adm.scope === 'room'}">${esc(t('Esta sala'))}</button>
						<button type="button" data-adm="scope" data-scope="global" aria-pressed="${this.adm.scope === 'global'}">${esc(t('General'))}</button>
					</span>
				</div>
				<p class="laka3d-muted">${esc(t('Se guardan los últimos 20 cambios. Cada cambio queda también en el registro de auditoría de Zabbix (Informes > Registro de auditoría).'))}</p>
				<div class="laka3d-ed-histlist">${rows}</div>
			</section>`;
	},

	historyRow(e) {
		const esc = LakaInfra3DEditor.esc;
		const t = this.t.bind(this);
		const date = this.admDate(e.t);
		const names = {racks: 'Racks', devices: 'Equipos', objects: 'Objetos', cables: 'Cables', sites: 'Sitios', models: 'Modelos'};
		const chips = [];

		Object.keys(names).forEach((k) => {
			const v = e.s && e.s[k];

			if (!v) {
				return;
			}

			const parts = [];

			if (v[0]) {
				parts.push(`+${v[0]}`);
			}
			if (v[1]) {
				parts.push(`−${v[1]}`);
			}
			if (v[2]) {
				parts.push(`~${v[2]}`);
			}

			chips.push(`<span class="laka3d-chip laka3d-chip-sm" title="${esc(t('agregados / quitados / cambiados'))}">${esc(t(names[k]))} ${esc(parts.join(' '))}</span>`);
		});

		if (e.s && e.s.other) {
			chips.push(`<span class="laka3d-chip laka3d-chip-sm">${esc(t('Otros ajustes'))} ${esc(String(e.s.other))}</span>`);
		}

		const badges = [];

		if (e.k === 'restore') {
			badges.push(`<span class="laka3d-badge">${esc(t('Restauración de respaldo'))}</span>`);
		}
		if (e.undone) {
			badges.push(`<span class="laka3d-badge laka3d-badge-muted">${esc(t('Deshecho por %1$s', e.undone_by || '—'))}</span>`);
		}

		const confirm = this.adm.confirmUndo === e.id;
		const undo = e.can_undo
			? `<button type="button" class="laka3d-btn ${confirm ? 'laka3d-btn-primary' : ''}" data-adm="undo" data-id="${esc(e.id)}">${esc(confirm ? t('Confirmar: deshacer') : t('Deshacer'))}</button>`
			: '';

		return `
			<div class="laka3d-ed-histrow${e.undone ? ' is-undone' : ''}">
				<div><strong>${esc(e.u || '—')}</strong> <span class="laka3d-muted">${esc(date)}</span> ${badges.join(' ')}</div>
				<div class="laka3d-ed-histchips">${chips.join(' ') || `<span class="laka3d-muted">${esc(t('Sin cambios de contenido'))}</span>`}</div>
				${undo ? `<div>${undo}</div>` : ''}
			</div>`;
	},

	async loadGlobalHistory() {
		const a = this.adminData();
		const url = `${a.history_url}&op=list&room_key=${encodeURIComponent('*')}&lang=${encodeURIComponent(this.data.lang || 'es')}`;

		try {
			const json = await (await fetch(url)).json();

			this.adm.globalHistory = json.success ? json.history : [];
		}
		catch (error) {
			this.adm.globalHistory = [];
		}

		this.render();
	},

	async undoChange(id) {
		const a = this.adminData();
		const scope = this.adm.scope === 'global' ? '*' : this.data.editor.room_key;
		const json = await this.adminPost(a.history_url, {op: 'undo', room_key: scope, id, _csrf_token: a.history_csrf});

		this.adm.confirmUndo = null;

		if (!json) {
			return;
		}

		if (this.adm.scope === 'global') {
			this.adm.globalHistory = json.history;
		}
		else {
			a.history = json.history;
		}

		if (json.storage) {
			this.data.editor.storage = json.storage;
		}

		// La distribución que está en el editor quedó vieja: se cierra y el widget se recarga.
		if (!this.dirty) {
			this.close(true, json.message);

			return;
		}

		this.flash('info', json.message);
		this.render();
	},

	// ---------------------------------------------------------------- permiso por sala

	renderAclCard() {
		const esc = LakaInfra3DEditor.esc;
		const t = this.t.bind(this);
		const a = this.adminData();
		const sel = new Set((this.adm.editors || a.editors || []).map(String));
		const names = a.groups.filter((g) => sel.has(g.id)).map((g) => g.name);

		if (!a.is_super) {
			return `
				<section class="laka3d-ed-card">
					<div class="laka3d-ed-cardhead"><strong>${esc(t('Permiso de edición'))}</strong></div>
					<p>${esc(sel.size ? t('Pueden editar esta sala: %1$s (y Super admin).', names.join(', ') || '—') : t('Cualquier Administrador puede editar esta sala.'))}</p>
					<p class="laka3d-muted">${esc(t('Solo un Super admin cambia este permiso.'))}</p>
				</section>`;
		}

		const filter = (this.adm.groupFilter || '').toLowerCase();
		const groups = a.groups.filter((g) => !filter || g.name.toLowerCase().includes(filter) || sel.has(g.id));

		return `
			<section class="laka3d-ed-card">
				<div class="laka3d-ed-cardhead"><strong>${esc(t('Permiso de edición'))}</strong></div>
				<p class="laka3d-muted">${esc(t('Grupos de usuarios de Zabbix que pueden editar la distribución y el cableado de esta sala. Sin grupos, cualquier Administrador puede editarla. Super admin siempre puede.'))}</p>
				<input type="search" class="laka3d-ed-short" data-adm-field="group-filter" value="${esc(this.adm.groupFilter || '')}" placeholder="${esc(t('Buscar grupo…'))}">
				<div class="laka3d-ed-grouplist">
					${groups.map((g) => `<label><input type="checkbox" data-adm-field="group" value="${esc(g.id)}"${sel.has(g.id) ? ' checked' : ''}> ${esc(g.name)}</label>`).join('') || `<span class="laka3d-muted">${esc(t('Sin resultados'))}</span>`}
				</div>
				<div class="laka3d-ed-row">
					<span class="laka3d-muted">${esc(sel.size ? t('Grupos elegidos: %1$s', String(sel.size)) : t('Cualquier Administrador'))}</span>
					<button type="button" class="laka3d-btn laka3d-btn-primary" data-adm="acl-save">${esc(t('Guardar permiso'))}</button>
				</div>
			</section>`;
	},

	async saveAcl() {
		const a = this.adminData();
		const ids = this.adm.editors || a.editors || [];
		const body = {room_key: this.data.editor.room_key, _csrf_token: a.acl_csrf};

		ids.forEach((id, i) => {
			body[`usrgrpids[${i}]`] = id;
		});

		const json = await this.adminPost(a.acl_url, body);

		if (json) {
			a.editors = json.editors;
			this.adm.editors = null;
			this.flash('info', json.message);
		}

		this.render();
	},

	// ---------------------------------------------------------------- respaldo completo

	renderBackupCard() {
		const esc = LakaInfra3DEditor.esc;
		const t = this.t.bind(this);
		const a = this.adminData();

		if (!a.is_super) {
			return `
				<section class="laka3d-ed-card">
					<div class="laka3d-ed-cardhead"><strong>${esc(t('Respaldo completo del módulo'))}</strong></div>
					<p class="laka3d-muted">${esc(t('Solo un Super admin puede descargar o restaurar el respaldo completo.'))}</p>
				</section>`;
		}

		const p = this.adm.preview;
		let preview = '';

		if (p) {
			const when = this.admDate(p.info.exported);
			const st = p.storage;
			const fits = !st || st.bytes <= st.max;
			const pct = st ? Math.round(st.bytes / st.max * 100) : 0;

			preview = `
				<div class="laka3d-ed-preview">
					<p><strong>${esc(this.adm.fileName || '')}</strong></p>
					<p class="laka3d-muted">${esc(t('Exportado el %1$s por %2$s · LAKA Infra 3D %3$s · Zabbix %4$s · %5$s', when, p.info.by || '—', p.info.module_version || '—', p.info.zabbix_version || '—', p.info.db === 'postgresql' ? 'PostgreSQL' : 'MySQL / MariaDB'))}</p>
					<table class="laka3d-ed-table">
						<thead><tr><th>${esc(t('Sala'))}</th><th>${esc(t('Racks'))}</th><th>${esc(t('Equipos'))}</th><th>${esc(t('Objetos'))}</th><th>${esc(t('Cables'))}</th></tr></thead>
						<tbody>${p.summary.rooms.map((r) => `<tr><td>${esc(r.key === '_default' ? t('Sala principal') : r.key)}</td><td>${r.racks}</td><td>${r.devices}</td><td>${r.objects}</td><td>${r.cables}</td></tr>`).join('')}</tbody>
					</table>
					<p>${esc(t('Sitios: %1$s · Modelos: %2$s · Fotos: %3$s · Salas con permiso: %4$s', String(p.summary.sites), String(p.summary.models), String(p.summary.images), String(p.summary.acl)))}</p>
					<p class="laka3d-muted">${esc(t('Hoy en este Zabbix: %1$s salas, %2$s sitios, %3$s modelos.', String(p.current.rooms.length), String(p.current.sites), String(p.current.models)))}</p>
					<fieldset class="laka3d-ed-radio">
						<label><input type="radio" name="laka3d-adm-mode" data-adm-field="mode" value="replace"${this.adm.mode === 'replace' ? ' checked' : ''}> ${esc(t('Reemplazar todo'))} <span class="laka3d-muted">${esc(t('(lo que no está en el archivo se borra)'))}</span></label>
						<label><input type="radio" name="laka3d-adm-mode" data-adm-field="mode" value="merge"${this.adm.mode === 'merge' ? ' checked' : ''}> ${esc(t('Combinar'))} <span class="laka3d-muted">${esc(t('(las salas, sitios y modelos del archivo reemplazan a los del mismo nombre; el resto se conserva)'))}</span></label>
					</fieldset>
					${st ? `<p class="${fits ? 'laka3d-muted' : 'laka3d-ed-error'}">${esc(fits ? t('Después de restaurar se usará el %1$s % del almacenamiento.', String(pct)) : t('El respaldo no entra en esta base de datos (%1$s % del límite). Usa Combinar con menos salas o Zabbix sobre PostgreSQL.', String(pct)))}</p>` : ''}
					<div class="laka3d-ed-row">
						<button type="button" class="laka3d-btn" data-adm="restore-cancel">${esc(t('Cancelar'))}</button>
						<button type="button" class="laka3d-btn laka3d-btn-primary" data-adm="restore"${fits ? '' : ' disabled'}>${esc(t('Descargar respaldo actual y restaurar'))}</button>
					</div>
				</div>`;
		}

		return `
			<section class="laka3d-ed-card">
				<div class="laka3d-ed-cardhead"><strong>${esc(t('Respaldo completo del módulo'))}</strong></div>
				<p class="laka3d-muted">${esc(t('Todas las salas, el cableado, los sitios, el mapa, los modelos y los permisos. La exportación de dashboards de Zabbix no los incluye: úsalo para migrar a otro servidor (por ejemplo de MySQL a PostgreSQL) o antes de cambios grandes.'))}</p>
				<div class="laka3d-ed-row">
					<label><input type="checkbox" data-adm-field="images"${this.adm.images ? ' checked' : ''}> ${esc(t('Incluir fotos de modelos'))}</label>
					<button type="button" class="laka3d-btn laka3d-btn-primary" data-adm="export">${esc(t('Descargar respaldo'))}</button>
					<label class="laka3d-btn laka3d-file">${esc(t('Restaurar desde archivo…'))}<input type="file" accept=".json,application/json" data-adm-field="file"></label>
				</div>
				${preview}
			</section>`;
	},

	async exportBackup(quiet = false) {
		const a = this.adminData();
		const json = await this.adminPost(a.backup_url, {op: 'export', images: this.adm.images ? '1' : '0', _csrf_token: a.backup_csrf});

		if (!json) {
			return false;
		}

		const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');

		this.download(`laka-infra-3d-respaldo-${stamp}.json`, JSON.stringify(json.backup), 'application/json');

		if (!quiet) {
			const s = json.summary;

			this.flash('info', this.t('Respaldo descargado: %1$s salas, %2$s sitios, %3$s modelos, %4$s fotos.',
				String(s.rooms.length), String(s.sites), String(s.models), String(s.images)));
			this.render();
		}

		return true;
	},

	async previewBackup(file) {
		const a = this.adminData();

		this.adm.fileText = await file.text();
		this.adm.fileName = file.name;

		// El archivo se descarga con una marca BOM al inicio (para Excel); se quita antes de leerlo.
		this.adm.fileText = this.adm.fileText.replace(/^﻿/, '');

		const json = await this.adminPost(a.backup_url, {op: 'preview', mode: this.adm.mode, data: this.adm.fileText, _csrf_token: a.backup_csrf});

		this.adm.preview = json || null;

		if (!json) {
			this.adm.fileText = null;
		}

		this.render();
	},

	async restoreBackup() {
		const a = this.adminData();

		// Primero se descarga lo que hay hoy: es la forma de volver atrás si hace falta.
		if (!await this.exportBackup(true)) {
			return;
		}

		const json = await this.adminPost(a.backup_url, {op: 'apply', mode: this.adm.mode, data: this.adm.fileText, _csrf_token: a.backup_csrf});

		if (!json) {
			return;
		}

		this.adm.preview = null;
		this.adm.fileText = null;

		const msg = json.images_created
			? `${json.message} ${this.t('Fotos recreadas: %1$s.', String(json.images_created))}`
			: json.message;

		this.dirty = false;
		this.close(true, msg);
	},

	// ---------------------------------------------------------------- eventos

	adminClick(e) {
		const btn = e.target.closest('[data-adm]');

		if (!btn || btn.disabled || !this.adminData()) {
			return false;
		}

		switch (btn.dataset.adm) {
			case 'scope':
				this.adm.scope = btn.dataset.scope;
				this.adm.confirmUndo = null;

				if (this.adm.scope === 'global' && !this.adm.globalHistory) {
					this.loadGlobalHistory();
				}
				this.render();
				break;

			case 'undo':
				if (this.adm.confirmUndo === btn.dataset.id) {
					btn.disabled = true;
					this.undoChange(btn.dataset.id);
				}
				else {
					this.adm.confirmUndo = btn.dataset.id;
					this.render();
				}
				break;

			case 'acl-save':
				btn.disabled = true;
				this.saveAcl();
				break;

			case 'export':
				btn.disabled = true;
				this.exportBackup().finally(() => {
					btn.disabled = false;
				});
				break;

			case 'restore':
				btn.disabled = true;
				this.restoreBackup().finally(() => {
					btn.disabled = false;
				});
				break;

			case 'restore-cancel':
				this.adm.preview = null;
				this.adm.fileText = null;
				this.render();
				break;

			default:
				return false;
		}

		return true;
	},

	adminChange(e) {
		const f = e.target.dataset.admField;

		if (!f || !this.adminData()) {
			return false;
		}

		const a = this.adminData();

		switch (f) {
			case 'group': {
				const sel = new Set((this.adm.editors || a.editors || []).map(String));

				if (e.target.checked) {
					sel.add(e.target.value);
				}
				else {
					sel.delete(e.target.value);
				}

				this.adm.editors = [...sel];
				this.render();
				break;
			}

			case 'images':
				this.adm.images = e.target.checked;
				break;

			case 'mode':
				this.adm.mode = e.target.value;

				// La estimación de tamaño depende del modo: se vuelve a pedir.
				if (this.adm.fileText) {
					this.previewBackup(new File([this.adm.fileText], this.adm.fileName || 'respaldo.json'));
				}
				break;

			case 'file':
				if (e.target.files && e.target.files[0]) {
					this.previewBackup(e.target.files[0]);
				}
				break;

			default:
				return false;
		}

		return true;
	},

	adminInput(e) {
		if (e.target.dataset.admField !== 'group-filter') {
			return false;
		}

		this.adm.groupFilter = e.target.value;

		// Se redibuja solo la lista, para no perder el foco del buscador.
		const list = this.el.querySelector('.laka3d-ed-grouplist');

		if (list) {
			const html = this.renderAclCard();
			const tmp = document.createElement('div');

			tmp.innerHTML = html;

			const fresh = tmp.querySelector('.laka3d-ed-grouplist');

			if (fresh) {
				list.innerHTML = fresh.innerHTML;
			}
		}

		return true;
	},

	/** POST con formulario; devuelve el JSON si salió bien o null (y deja el mensaje de error). */
	async adminPost(url, fields) {
		const body = new URLSearchParams({lang: this.data.lang || 'es', ...fields});

		try {
			const response = await fetch(url, {method: 'POST',
				headers: {'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'}, body: body.toString()
			});
			const json = await response.json();

			if (!json.success) {
				throw new Error((json.error && json.error.messages || []).join(' ') || this.t('No se pudo completar la operación.'));
			}

			return json;
		}
		catch (error) {
			this.flash('error', error.message || this.t('No se pudo completar la operación.'));
			this.render();

			return null;
		}
	}
});
