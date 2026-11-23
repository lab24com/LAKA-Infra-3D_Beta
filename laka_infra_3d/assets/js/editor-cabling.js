/*
 * LAKA Infra 3D – gemelo digital de data center para Zabbix 7.0 – 8.0
 * © LAKA Soluciones Tecnológicas
 * Autor: Willian Tola
 * Licencia GPLv3
 *
 * Editor de sala: configuración de cada equipo, configurador de patch panels y revisión de normas.
 * Se suma a LakaInfra3DEditor (assets/js/editor.js).
 *
 * - Configuración del equipo: papel (switch core, firewall, servidor…), flujo de aire y componentes del modelo
 *   (puertos, fuentes, ventiladores, discos), que se reflejan en la vista detallada del equipo.
 * - Patch panel: medio y categoría (ANSI/TIA-568), conector, terminación, cantidad de puertos, forma y función
 *   en la topología (ANSI/TIA-942); mapa de puertos interactivo con selección de rangos; cordones de parcheo al
 *   frente, enlaces permanentes atrás (a otro panel o a tomas), largo, color, estado y etiquetas ANSI/TIA-606.
 * - Normas: revisa la instalación de los equipos y el cableado y explica qué corregir.
 *
 * Todo se guarda junto con la sala al pulsar "Guardar" (cableado con laka_infra_3d.cable.save y componentes del
 * modelo con laka_infra_3d.model.save). "Cancelar" descarta los cambios.
 */

Object.assign(LakaInfra3DEditor.prototype, {

	// ================================================================ datos

	/** Copia de trabajo del cableado y de los componentes de los modelos. */
	cabInit() {
		if (this.cab) {
			return;
		}

		this.cab = LakaInfra3DCabling.clone(this.data.cabling);
		this.cabDirty = false;
		this.modelDraft = {};
		this.pc = null;

		// Posición original de cada pasivo: si se mueve, su cableado y configuración se pasan a la nueva clave.
		this.pkeys0 = new Set(this.draft.passives.map((p) => this.pkey(p)));
	},

	/** Clave estable de un pasivo durante la edición: la de su posición al abrir el editor o al ubicarlo. */
	pkey(p) {
		if (!Object.prototype.hasOwnProperty.call(p, '_key0')) {
			Object.defineProperty(p, '_key0', {value: LakaInfra3DCabling.passiveKey(p), enumerable: false, writable: true});
		}

		return p._key0;
	},

	cabTouch() {
		this.cabDirty = true;
		this.dirty = true;
	},

	/** Datos para calcular perfiles: modelos guardados + cambios del editor, y el cableado en edición. */
	cabData() {
		const models = Object.assign({}, this.data.models && !Array.isArray(this.data.models) ? this.data.models : {});

		for (const [mkey, p] of Object.entries(this.modelDraft || {})) {
			models[mkey] = Object.assign({}, models[mkey] || {}, {p});
		}

		return {models, cabling: this.cab};
	},

	/** Equipo del editor con la forma que usan la vista 3D y la del equipo. */
	devOf(it, rackName) {
		if (it.kind === 'host') {
			const base = (this.data.devices || []).find((x) => String(x.id) === String(it.id)) || {};

			return {id: it.id, key: String(it.id), name: it.name, host: base.host || '', type: it.type, n: it.n, u: it.u,
				face: it.face, rack: rackName, inv: base.inv || {}, kg: it.kg, w: it.w};
		}

		const p = this.draft.passives[parseInt(it.id, 10)];

		return {id: `p${it.id}`, key: this.pkey(p), name: it.name, host: '', type: it.type, n: it.n, u: it.u, face: it.face,
			rack: rackName, inv: {}, passive: true, kg: it.kg, w: it.w};
	},

	/** Todos los equipos de la sala por clave (para nombrar el otro extremo de un cable). */
	keyIndex() {
		const map = new Map();

		for (const r of this.draft.racks.filter((x) => (x.kind || 'rack') === 'rack')) {
			for (const it of this.itemsOf(r.name)) {
				const d = this.devOf(it, r.name);

				map.set(d.key, d);
			}
		}

		return map;
	},

	roleOf(d) {
		LakaInfra3DCabling.applyRoles(this.cab);

		return LakaInfra3DRackView.role(d);
	},

	portsOf(d) {
		const {profile} = LakaInfra3DDevView.profileOf(d, this.cabData());

		return [...LakaInfra3DDevView.ports(profile, 'F'), ...LakaInfra3DDevView.ports(profile, 'R')];
	},

	/** Nombre de un extremo: "sw-acc-01 · RJ45 5", "Toma 1A-W01-05", "PDU vertical A · R01". */
	epText(ep, index) {
		const t = this.t.bind(this);
		const p = LakaInfra3DCabling.split(ep);

		if (p.key.startsWith('o:')) {
			return `${t('Toma')} ${p.key.slice(2)}`;
		}

		if (p.key.startsWith('x:')) {
			const o = this.draft.objects.find((x) => x.id === p.key.slice(2));

			return `${o ? (o.name || this.kindName(o.kind)) : p.key.slice(2)} · RJ45`;
		}

		if (p.key.startsWith('v:')) {
			return `${t('PDU vertical')} ${p.key.split(':')[2]} · ${p.key.split(':')[1].toUpperCase()}`;
		}

		const d = (index || this.keyIndex()).get(p.key);
		const names = {pp: 'Puerto', rj45: 'RJ45', sfp: 'SFP', mgmt: 'Gestión', console: 'Consola', psu: 'Fuente', outlet: 'Toma'};

		return `${d ? d.name : p.key} · ${t(names[p.kind] || p.kind)} ${p.n}${p.face === 'R' && p.kind === 'pp' ? ' (' + t('atrás') + ')' : ''}`;
	},

	/** Identificador TIA-606 del panel: FS.XY-UU (U superior del panel). */
	panelTia(d) {
		return `${LakaInfra3DCabling.rackId(this.cab, d.rack)}-${LakaInfra3DCabling.pad(d.u + d.n - 1)}`;
	},

	// ================================================================ configuración del equipo

	/** Sección "Configuración" de la tarjeta del equipo elegido en el rack. */
	renderItemConfig(it, rack) {
		const esc = LakaInfra3DEditor.esc;
		const t = this.t.bind(this);
		const d = this.devOf(it, rack.name);
		const cfg = LakaInfra3DCabling.dev(this.cab, d.key);
		const auto = (() => {
			const saved = LakaInfra3DRackView.overrides;

			LakaInfra3DRackView.overrides = new Map();

			const r = LakaInfra3DRackView.role(d);

			LakaInfra3DRackView.overrides = saved;

			return r;
		})();
		const role = this.roleOf(d);
		const rv = new LakaInfra3DRackView(this);

		this.selectedDevN = d.n;
		const roles = LakaInfra3DCabling.ROLES.filter((r) => r !== '' && (d.passive ? ['patch', 'cable', 'blank', 'pdu', 'other'].includes(r) : !['cable', 'blank'].includes(r)));
		let extra = '';

		if (role === 'patch') {
			const panel = LakaInfra3DCabling.panel(this.cab, d.key, d.n);
			const used = this.cab.list.filter((s) => s.split('|').slice(0, 2).some((ep) => ep.split('#')[0] === d.key)).length;

			extra = `
				<div class="laka3d-ed-pcsum">
					<span>${esc(LakaInfra3DDevView.panelText(panel, t))}</span>
					<span class="laka3d-muted">${esc(this.panelTia(d))} · ${used} ${esc(t('cables'))}</span>
					<button type="button" class="laka3d-btn laka3d-btn-primary" data-pc="open" data-key="${esc(d.key)}">${esc(t('Configurar patch panel'))}</button>
				</div>`;
		}
		else if (!d.passive) {
			const mkey = LakaInfra3DDevView.mkey(d);
			const {profile} = LakaInfra3DDevView.profileOf(d, this.cabData());
			const parts = ['rj45', 'sfp', 'mgmt', 'console', 'usb', 'disk', 'psu', 'fan', 'outlet'];
			const modelName = (d.inv.model || '').trim() !== '' ? `${d.inv.vendor || ''} ${d.inv.model}`.trim() : null;

			extra = `
				<details class="laka3d-ed-parts"${this.partsOpen === d.key ? ' open' : ''} data-key="${esc(d.key)}">
					<summary>${esc(t('Componentes del modelo'))}${modelName ? ` · ${esc(modelName)}` : ''}</summary>
					<p class="laka3d-muted">${esc(modelName ? t('Se guarda para el modelo %1$s: lo comparten todos los equipos de ese modelo.', modelName) : t('El host no tiene modelo en el inventario: el perfil se guarda solo para este equipo.'))}</p>
					<table class="laka3d-ed-partstab">
						<thead><tr><th></th><th>${esc(t('Frente'))}</th><th>${esc(t('Atrás'))}</th></tr></thead>
						<tbody>${parts.map((k) => `<tr><td>${esc(t(LakaInfra3DDevView.PARTS[k].name))}</td>${['F', 'R'].map((f) => `<td><input type="number" min="0" max="96" class="laka3d-ed-num" data-cfg="part" data-mkey="${esc(mkey)}" data-face="${f}" data-part="${k}" value="${profile[f][k] || 0}"></td>`).join('')}</tr>`).join('')}</tbody>
					</table>
				</details>`;
		}

		return `
			<div class="laka3d-ed-config">
				<strong>${esc(t('Configuración'))}</strong>
				<div class="laka3d-ed-props">
					<label>${esc(t('Papel'))} <select data-cfg="role" data-key="${esc(d.key)}">
						<option value="">${esc(t('Automático'))} (${esc(rv.roleName(auto))})</option>
						${roles.map((r) => `<option value="${r}"${cfg.role === r ? ' selected' : ''}>${esc(rv.roleName(r))}</option>`).join('')}
					</select></label>
					${d.passive ? '' : `<label>${esc(t('Flujo de aire'))} <select data-cfg="air" data-key="${esc(d.key)}">${Object.entries(LakaInfra3DCabling.AIRFLOW).map(([k, v]) => `<option value="${k}"${cfg.air === k ? ' selected' : ''}>${esc(t(v))}</option>`).join('')}</select></label>`}
				</div>
				${extra}
				${['pdu', 'ups'].includes(role) ? this.renderPowerFields(d.key, role === 'ups' ? t('Energía de la UPS') : t('Energía de la PDU')) : ''}
			</div>`;
	},

	// ================================================================ cadena eléctrica A/B

	/** Fuentes posibles aguas arriba: UPS, tableros, ATS, generadores y transformadores de la sala, y UPS de rack. */
	powerSources(exclude) {
		const out = [];

		for (const o of this.draft.objects) {
			if (o.id && LakaInfra3DPower.SOURCE_KINDS.includes(o.kind) && `x:${o.id}` !== exclude) {
				out.push({key: `x:${o.id}`, name: `${o.name || this.kindName(o.kind)} · ${this.kindName(o.kind)}`});
			}
		}

		for (const [key, d] of this.keyIndex()) {
			if (key !== exclude && this.roleOf(d) === 'ups') {
				out.push({key, name: `${d.name} · ${this.t('UPS de rack')} ${d.rack}`});
			}
		}

		return out;
	},

	/**
	 * Rama (A–D) y "Alimentado desde" (principal y alternativa) de una PDU, UPS, tablero, ATS, generador,
	 * transformador o aire. La alternativa es para lo que tiene dos entradas (ej. ATS: red y generador).
	 */
	renderPowerFields(key, title) {
		const esc = LakaInfra3DEditor.esc;
		const t = this.t.bind(this);

		this.cabInit();

		const cfg = LakaInfra3DPower.get(this.cab, key);
		const inherited = LakaInfra3DPower.feedOf(this.cab, key);
		const sources = this.powerSources(key);
		const opt = (sel) => `<option value="">—</option>${sources.map((x) => `<option value="${esc(x.key)}"${x.key === sel ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}`;

		return `
			<fieldset class="laka3d-ed-pw">
				<legend>${esc(title)}</legend>
				<div class="laka3d-ed-props">
					<label>${esc(t('Rama'))} <select data-pwf="feed" data-pwkey="${esc(key)}">
						<option value="">${esc(inherited && !cfg.feed ? t('Heredada (%1$s)', inherited) : '—')}</option>
						${LakaInfra3DPower.FEEDS.map((f) => `<option value="${f}"${cfg.feed === f ? ' selected' : ''}>${f}</option>`).join('')}
					</select></label>
					<label>${esc(t('Alimentado desde'))} <select data-pwf="up1" data-pwkey="${esc(key)}">${opt(cfg.ups[0])}</select></label>
					<label>${esc(t('Fuente alternativa'))} <select data-pwf="up2" data-pwkey="${esc(key)}"${cfg.ups[0] ? '' : ' disabled'}>${opt(cfg.ups[1])}</select></label>
				</div>
			</fieldset>`;
	},

	setPowerField(key, field, value) {
		this.cabInit();

		const cfg = LakaInfra3DPower.get(this.cab, key);
		const ups = [cfg.ups[0] || '', cfg.ups[1] || ''];

		if (field === 'feed') {
			cfg.feed = value;
		}
		else if (field === 'up1') {
			ups[0] = value;
		}
		else {
			ups[1] = value;
		}

		LakaInfra3DPower.set(this.cab, key, cfg.feed, ups[0] ? ups : [ups[1]].filter(Boolean));
		this.cabTouch();
	},

	setDevCfg(key, field, value) {
		const cfg = LakaInfra3DCabling.dev(this.cab, key);

		cfg[field] = value;

		if (cfg.role === '' && cfg.air === 'fb') {
			delete this.cab.devs[key];
		}
		else {
			this.cab.devs[key] = `${cfg.role}|${cfg.air}`;
		}

		LakaInfra3DCabling.applyRoles(this.cab);
		this.cabTouch();
	},

	/** Componentes del modelo: se arma el perfil con todos los campos de la tabla. */
	setParts(details) {
		const p = {F: {}, R: {}};
		let mkey = '';

		details.querySelectorAll('[data-cfg="part"]').forEach((input) => {
			const v = Math.max(0, Math.min(96, parseInt(input.value, 10) || 0));

			mkey = input.dataset.mkey;

			if (v > 0) {
				p[input.dataset.face][input.dataset.part] = v;
			}
		});

		if (mkey) {
			this.modelDraft[mkey] = LakaInfra3DDevView.serialize(p);
			this.modelN = Object.assign(this.modelN || {}, {[mkey]: this.selectedDevN || 1});
			this.dirty = true;
		}
	},

	// ================================================================ configurador de patch panel

	panelItem() {
		if (!this.pc) {
			return null;
		}

		for (const r of this.draft.racks.filter((x) => (x.kind || 'rack') === 'rack')) {
			for (const it of this.itemsOf(r.name)) {
				const d = this.devOf(it, r.name);

				if (d.key === this.pc.key) {
					return {it, d, rack: r};
				}
			}
		}

		return null;
	},

	renderPanelConfig() {
		const esc = LakaInfra3DEditor.esc;
		const t = this.t.bind(this);
		const found = this.panelItem();

		if (!found) {
			this.pc = null;

			return '';
		}

		const {d} = found;
		const panel = LakaInfra3DCabling.panel(this.cab, d.key, d.n);
		const media = LakaInfra3DCabling.MEDIA[panel.media];
		const index = this.keyIndex();
		const sel = this.pc.sel;
		const tia = this.panelTia(d);
		const opt = (list, cur, names = null) => list.map((v) => `<option value="${esc(v)}"${String(v) === String(cur) ? ' selected' : ''}>${esc(names ? t(names[v] || v) : v)}</option>`).join('');
		const perRow = panel.ports > 24 ? 24 : panel.ports;
		let grid = '';

		for (let i = 1; i <= panel.ports; i++) {
			const front = LakaInfra3DCabling.cableAt(this.cab, `${d.key}#F-pp-${i}`);
			const rear = LakaInfra3DCabling.cableAt(this.cab, `${d.key}#R-pp-${i}`);
			const ps = LakaInfra3DCabling.portState(this.cab, `${d.key}#F-pp-${i}`);
			const cls = ['laka3d-pc-port', sel.includes(i) ? 'is-sel' : '', front ? 'has-front' : '', rear ? 'has-rear' : '',
				ps.st ? `pst-${ps.st}` : ''].filter(Boolean).join(' ');
			const tip = `${tia}:${LakaInfra3DCabling.pad(i)}${front ? '\n' + t('Frente') + ': ' + this.epText(front.a === `${d.key}#F-pp-${i}` ? front.b : front.a, index) : ''}${rear ? '\n' + t('Atrás') + ': ' + this.epText(rear.a === `${d.key}#R-pp-${i}` ? rear.b : rear.a, index) : ''}${ps.st ? '\n' + t(LakaInfra3DCabling.STATUS[ps.st]) : ''}${ps.note ? '\n' + ps.note : ''}`;

			grid += `<button type="button" class="${cls}" data-pc="port" data-n="${i}" title="${esc(tip)}" style="grid-column:${((i - 1) % perRow) + 1 + Math.floor(((i - 1) % perRow) / 6)}"><span>${i}</span><i class="f" style="${front ? 'background:' + esc(front.c || '#2f80ed') : ''}"></i><i class="r" style="${rear ? 'background:' + esc(rear.c || '#f2c94c') : ''}"></i></button>`;
		}

		const cols = perRow + Math.floor((perRow - 1) / 6);

		return `
			<div class="laka3d-ed-card laka3d-pc">
				<div class="laka3d-ed-cardhead">
					<strong>${esc(t('Patch panel'))} ${esc(d.name)}</strong>
					<span class="laka3d-muted">${esc(t('Rack'))} ${esc(d.rack)} · U${d.u + d.n - 1}${d.n > 1 ? '–' + d.u : ''} · ${esc(t('Identificador TIA-606'))}: <code>${esc(tia)}</code></span>
					<button type="button" class="laka3d-x" data-pc="close" aria-label="${esc(t('Cerrar'))}">✕</button>
				</div>
				<div class="laka3d-ed-props laka3d-pc-props">
					<label>${esc(t('Medio'))} <select data-pcf="media">${opt(Object.keys(LakaInfra3DCabling.MEDIA), panel.media, Object.fromEntries(Object.entries(LakaInfra3DCabling.MEDIA).map(([k, v]) => [k, v.name])))}</select></label>
					<label>${esc(media.fiber ? t('Tipo de fibra') : t('Categoría'))} <select data-pcf="cat">${opt(media.cats, panel.cat, media.fiber ? null : Object.fromEntries(media.cats.map((c) => [c, `Cat ${c}`])))}</select></label>
					<label>${esc(t('Conector'))} <select data-pcf="conn">${opt(media.conns, panel.conn, LakaInfra3DCabling.CONN_NAMES)}</select></label>
					<label>${esc(t('Terminación atrás'))} <select data-pcf="rear">${opt(media.rears, panel.rear, LakaInfra3DCabling.REAR_NAMES)}</select></label>
					<label>${esc(t('Puertos'))} <select data-pcf="ports">${opt(LakaInfra3DCabling.PORTS, panel.ports)}</select></label>
					<label>${esc(t('Forma'))} <select data-pcf="style">${opt(['flat', 'angled'], panel.style, {flat: 'Plano', angled: 'Angulado'})}</select></label>
					<label>${esc(t('Función (TIA-942)'))} <select data-pcf="func">${opt(Object.keys(LakaInfra3DCabling.FUNCS), panel.func, LakaInfra3DCabling.FUNCS)}</select></label>
				</div>
				<div class="laka3d-pc-mapbar">
					<span class="laka3d-muted">${esc(t('Clic en un puerto para elegirlo; Mayús + clic para elegir un rango.'))}</span>
					<div class="laka3d-ed-btns">
						<button type="button" class="laka3d-btn" data-pc="all">${esc(t('Elegir todos'))}</button>
						<button type="button" class="laka3d-btn" data-pc="none"${sel.length ? '' : ' disabled'}>${esc(t('Quitar selección'))}</button>
					</div>
				</div>
				<div class="laka3d-pc-map${media.fiber ? ' is-fiber' : ''}" style="grid-template-columns:repeat(${cols}, minmax(26px, 1fr))">${grid}</div>
				<div class="laka3d-pc-legend">
					<span><i class="f"></i>${esc(t('Cordón al frente'))}</span>
					<span><i class="r"></i>${esc(t('Enlace permanente atrás'))}</span>
					<span><i class="pst-r"></i>${esc(t('Reservado'))}</span>
					<span><i class="pst-d"></i>${esc(t('Dañado'))}</span>
				</div>
				${sel.length ? this.renderPortEditor(d, panel, index) : `<p class="laka3d-muted">${esc(t('Elige uno o varios puertos para documentar sus cables.'))}</p>`}
				<p class="laka3d-muted laka3d-pc-norm">${esc(media.fiber
					? t('Fibra: rotula cada enlace en los dos extremos (ANSI/TIA-606) y respeta la polaridad (A-B) de los enlaces dúplex.')
					: t('Cobre (ANSI/TIA-568): enlace permanente hasta 90 m, cordones de parcheo hasta 10 m en total, canal hasta 100 m. Rotula los dos extremos (ANSI/TIA-606).'))}</p>
			</div>`;
	},

	/** Edición de los puertos elegidos: cordón al frente, enlace atrás, estado y nota. */
	renderPortEditor(d, panel, index) {
		const esc = LakaInfra3DEditor.esc;
		const t = this.t.bind(this);
		const sel = this.pc.sel;
		const one = sel.length === 1;
		const f = this.pc.f;
		const range = one ? `${t('Puerto')} ${sel[0]}` : t('Puertos %1$s a %2$s (%3$s)', String(sel[0]), String(sel[sel.length - 1]), String(sel.length));
		const racks = this.draft.racks.filter((r) => (r.kind || 'rack') === 'rack');
		const fiber = LakaInfra3DCabling.MEDIA[panel.media].fiber;

		// Cordón al frente: equipos del rack elegido con puertos de datos.
		const fRack = f.fRack || d.rack;
		const fDevs = this.itemsOf(fRack).map((it) => this.devOf(it, fRack))
			.filter((x) => x.key !== d.key && !['cable', 'blank'].includes(this.roleOf(x)));
		const fDev = fDevs.find((x) => x.key === f.fDev) || null;
		const fPorts = fDev ? this.portsOf(fDev).filter((p) => ['rj45', 'sfp', 'mgmt', 'console', 'pp'].includes(p.kind)) : [];

		// Enlace atrás: otro patch panel (de cualquier rack) o tomas.
		const rRack = f.rRack || d.rack;
		const rPanels = this.itemsOf(rRack).map((it) => this.devOf(it, rRack))
			.filter((x) => x.key !== d.key && this.roleOf(x) === 'patch');
		const rPanel = rPanels.find((x) => x.key === f.rDev) || null;
		const rPanelCfg = rPanel ? LakaInfra3DCabling.panel(this.cab, rPanel.key, rPanel.n) : null;

		const current = sel.slice(0, 6).map((n) => {
			const fc = LakaInfra3DCabling.cableAt(this.cab, `${d.key}#F-pp-${n}`);
			const rc = LakaInfra3DCabling.cableAt(this.cab, `${d.key}#R-pp-${n}`);
			const other = (c, ep) => this.epText(c.a === ep ? c.b : c.a, index);
			const ps = LakaInfra3DCabling.portState(this.cab, `${d.key}#F-pp-${n}`);

			return `<tr>
				<td><strong>${n}</strong> <code>${esc(this.panelTia(d))}:${LakaInfra3DCabling.pad(n)}</code></td>
				<td>${fc ? `<i class="laka3d-dv-sw" style="background:${esc(fc.c || '#2f80ed')}"></i>${esc(other(fc, `${d.key}#F-pp-${n}`))}${fc.len ? ` · ${fc.len} m` : ''}` : '—'}</td>
				<td>${rc ? `<i class="laka3d-dv-sw" style="background:${esc(rc.c || '#f2c94c')}"></i>${esc(other(rc, `${d.key}#R-pp-${n}`))}${rc.len ? ` · ${rc.len} m` : ''}` : '—'}</td>
				<td>${ps.st ? esc(t(LakaInfra3DCabling.STATUS[ps.st])) : ''}${ps.note ? ` <span class="laka3d-muted">${esc(ps.note)}</span>` : ''}</td>
			</tr>`;
		}).join('');

		const colors = (field, def) => `<select data-pcf="${field}">${LakaInfra3DDevView.COLORS.map((c) => `<option value="${c}"${(f[field] || def) === c ? ' selected' : ''} style="background:${c}">${c}</option>`).join('')}</select>`;

		return `
			<div class="laka3d-pc-edit">
				<strong>${esc(range)}</strong>
				<table class="laka3d-pc-cur">
					<thead><tr><th>${esc(t('Puerto'))}</th><th>${esc(t('Frente (cordón de parcheo)'))}</th><th>${esc(t('Atrás (enlace permanente)'))}</th><th>${esc(t('Estado'))}</th></tr></thead>
					<tbody>${current}</tbody>
				</table>
				${sel.length > 6 ? `<p class="laka3d-muted">${esc(t('… y %1$s puertos más.', String(sel.length - 6)))}</p>` : ''}

				<fieldset>
					<legend>${esc(t('Frente: cordón de parcheo a un equipo'))}${one ? '' : ' · ' + esc(t('1 a 1 desde el puerto inicial'))}</legend>
					<div class="laka3d-ed-props">
						<label>${esc(t('Rack'))} <select data-pcf="fRack">${racks.map((r) => `<option value="${esc(r.name)}"${r.name === fRack ? ' selected' : ''}>${esc(r.name)}</option>`).join('')}</select></label>
						<label>${esc(t('Equipo'))} <select data-pcf="fDev"><option value="">—</option>${fDevs.map((x) => `<option value="${esc(x.key)}"${fDev && x.key === fDev.key ? ' selected' : ''}>U${x.u + x.n - 1} · ${esc(x.name)}</option>`).join('')}</select></label>
						<label>${esc(one ? t('Puerto') : t('Puerto inicial'))} <select data-pcf="fPort"${fDev ? '' : ' disabled'}><option value="">—</option>${fPorts.map((p) => `<option value="${esc(p.id)}"${f.fPort === p.id ? ' selected' : ''}>${esc(this.epText(`${fDev.key}#${p.id}`, index).split(' · ').slice(1).join(' · '))}${p.face === 'R' ? ' · ' + esc(t('atrás')) : ''}</option>`).join('')}</select></label>
						<label>${esc(t('Largo (m)'))} <input type="number" min="0" max="100" step="0.5" class="laka3d-ed-num" data-pcf="fLen" value="${esc(f.fLen || '')}" placeholder="2"></label>
						<label>${esc(t('Color'))} ${colors('fColor', fiber ? '#00b3a4' : '#2f80ed')}</label>
					</div>
					<div class="laka3d-ed-btns">
						<button type="button" class="laka3d-btn laka3d-btn-primary" data-pc="front-set"${fDev && f.fPort ? '' : ' disabled'}>${esc(t('Conectar al frente'))}</button>
						<button type="button" class="laka3d-btn" data-pc="front-del">${esc(t('Quitar cordones'))}</button>
					</div>
				</fieldset>

				<fieldset>
					<legend>${esc(t('Atrás: enlace permanente'))}</legend>
					<div class="laka3d-ed-props">
						<label>${esc(t('Destino'))} <select data-pcf="rType">
							<option value="panel"${f.rType !== 'outlet' ? ' selected' : ''}>${esc(t('Otro patch panel (troncal)'))}</option>
							<option value="outlet"${f.rType === 'outlet' ? ' selected' : ''}>${esc(t('Tomas de área de trabajo o de zona'))}</option>
						</select></label>
						${f.rType === 'outlet' ? `
							<label>${esc(t('Prefijo de la toma'))} <input type="text" maxlength="30" data-pcf="rPrefix" value="${esc(f.rPrefix ?? (this.cab.fs || '1A') + '-W01-')}" class="laka3d-ed-short"></label>
							<label>${esc(one ? t('Número') : t('Número inicial'))} <input type="number" min="0" max="9999" class="laka3d-ed-num" data-pcf="rNum" value="${esc(f.rNum || sel[0])}"></label>
							<span class="laka3d-muted">${esc(t('Toma'))}: <code>${esc((f.rPrefix ?? (this.cab.fs || '1A') + '-W01-') + LakaInfra3DCabling.pad(parseInt(f.rNum || sel[0], 10) || 0))}</code></span>`
						: `
							<label>${esc(t('Rack'))} <select data-pcf="rRack">${racks.map((r) => `<option value="${esc(r.name)}"${r.name === rRack ? ' selected' : ''}>${esc(r.name)}</option>`).join('')}</select></label>
							<label>${esc(t('Patch panel'))} <select data-pcf="rDev"><option value="">—</option>${rPanels.map((x) => `<option value="${esc(x.key)}"${rPanel && x.key === rPanel.key ? ' selected' : ''}>U${x.u + x.n - 1} · ${esc(x.name)}</option>`).join('')}</select></label>
							<label>${esc(one ? t('Puerto') : t('Puerto inicial'))} <input type="number" min="1" max="${rPanelCfg ? rPanelCfg.ports : 96}" class="laka3d-ed-num" data-pcf="rPort" value="${esc(f.rPort || sel[0])}"${rPanel ? '' : ' disabled'}></label>`}
						<label>${esc(t('Largo (m)'))} <input type="number" min="0" max="999" step="0.5" class="laka3d-ed-num" data-pcf="rLen" value="${esc(f.rLen || '')}" placeholder="${fiber ? '30' : '45'}"></label>
						<label>${esc(t('Color'))} ${colors('rColor', fiber ? '#00b3a4' : '#f2c94c')}</label>
					</div>
					<div class="laka3d-ed-btns">
						<button type="button" class="laka3d-btn laka3d-btn-primary" data-pc="rear-set"${f.rType === 'outlet' || rPanel ? '' : ' disabled'}>${esc(t('Conectar atrás'))}</button>
						<button type="button" class="laka3d-btn" data-pc="rear-del">${esc(t('Quitar enlaces'))}</button>
					</div>
				</fieldset>

				<fieldset>
					<legend>${esc(t('Estado y nota'))}</legend>
					<div class="laka3d-ed-props">
						<label>${esc(t('Estado'))} <select data-pcf="st">${Object.entries(LakaInfra3DCabling.STATUS).map(([k, v]) => `<option value="${k}"${(f.st || '') === k ? ' selected' : ''}>${esc(t(v))}</option>`).join('')}</select></label>
						<label class="laka3d-pc-wide">${esc(t('Nota'))} <input type="text" maxlength="60" data-pcf="note" value="${esc(f.note || '')}" placeholder="${esc(t('Por ejemplo: cámara del pasillo 3'))}"></label>
						<button type="button" class="laka3d-btn" data-pc="state-set">${esc(t('Aplicar'))}</button>
					</div>
				</fieldset>
			</div>`;
	},

	/** Clic dentro del configurador de patch panel o de la configuración del equipo. */
	cabClick(e) {
		const onBtn = e.target.closest('[data-on]');

		if (onBtn) {
			this.objNetClick(onBtn.dataset.on);

			return true;
		}

		const btn = e.target.closest('[data-pc]');

		if (!btn) {
			return false;
		}

		this.cabInit();

		const act = btn.dataset.pc;
		const found = act === 'open' ? null : this.panelItem();
		const t = this.t.bind(this);

		switch (act) {
			case 'open':
				this.pc = {key: btn.dataset.key, sel: [], anchor: null, f: {}};
				break;

			case 'close':
				this.pc = null;
				break;

			case 'port': {
				const n = parseInt(btn.dataset.n, 10);

				if (e.shiftKey && this.pc.anchor) {
					const [a, b] = [Math.min(this.pc.anchor, n), Math.max(this.pc.anchor, n)];

					this.pc.sel = Array.from({length: b - a + 1}, (_, i) => a + i);
				}
				else if (e.ctrlKey || e.metaKey) {
					this.pc.sel = this.pc.sel.includes(n) ? this.pc.sel.filter((x) => x !== n) : [...this.pc.sel, n].sort((x, y) => x - y);
					this.pc.anchor = n;
				}
				else {
					this.pc.sel = [n];
					this.pc.anchor = n;

					// Estado y nota del puerto para editarlos.
					const ps = LakaInfra3DCabling.portState(this.cab, `${this.pc.key}#F-pp-${n}`);

					this.pc.f.st = ps.st;
					this.pc.f.note = ps.note;
					this.pc.f.rNum = '';
					this.pc.f.rPort = '';
				}

				break;
			}

			case 'all': {
				const panel = LakaInfra3DCabling.panel(this.cab, this.pc.key, found ? found.d.n : 1);

				this.pc.sel = Array.from({length: panel.ports}, (_, i) => i + 1);
				break;
			}

			case 'none':
				this.pc.sel = [];
				break;

			case 'front-set':
			case 'rear-set':
				if (found) {
					this.applyPanelLinks(found.d, act === 'front-set' ? 'F' : 'R');
				}

				break;

			case 'front-del':
			case 'rear-del':
				for (const n of this.pc.sel) {
					LakaInfra3DCabling.removeCable(this.cab, `${this.pc.key}#${act === 'front-del' ? 'F' : 'R'}-pp-${n}`);
				}

				this.cabTouch();
				this.flash('info', act === 'front-del' ? t('Cordones quitados.') : t('Enlaces quitados.'));
				break;

			case 'state-set':
				for (const n of this.pc.sel) {
					const ep = `${this.pc.key}#F-pp-${n}`;
					const st = this.pc.f.st || '';
					const note = String(this.pc.f.note || '').replace(/[\n\r|]/g, ' ').slice(0, 60);

					if (st === '' && note === '') {
						delete this.cab.ports[ep];
					}
					else {
						this.cab.ports[ep] = `${st}|${note}`;
					}
				}

				this.cabTouch();
				break;

			default:
				return false;
		}

		this.render();

		return true;
	},

	/** Crea los cables 1 a 1 de los puertos elegidos (al frente: a un equipo; atrás: a otro panel o a tomas). */
	applyPanelLinks(d, face) {
		const t = this.t.bind(this);
		const f = this.pc.f;
		const sel = this.pc.sel;
		const panel = LakaInfra3DCabling.panel(this.cab, d.key, d.n);
		const kind = LakaInfra3DCabling.MEDIA[panel.media].fiber ? 'fiber' : 'net';
		const len = parseFloat(String(f[face === 'F' ? 'fLen' : 'rLen'] || '').replace(',', '.'));
		const targets = [];

		if (face === 'F') {
			const index = this.keyIndex();
			const dev = index.get(f.fDev);

			if (!dev || !f.fPort) {
				return;
			}

			const start = LakaInfra3DCabling.split(`x#${f.fPort}`);
			const list = this.portsOf(dev).filter((p) => p.kind === start.kind && p.face === start.face);
			const from = list.findIndex((p) => p.id === f.fPort);

			if (from < 0 || from + sel.length > list.length) {
				this.flash('error', t('El equipo no tiene puertos suficientes desde el puerto inicial.'));

				return;
			}

			sel.forEach((n, i) => targets.push([`${d.key}#F-pp-${n}`, `${dev.key}#${list[from + i].id}`]));
		}
		else if (f.rType === 'outlet') {
			const prefix = String(f.rPrefix ?? `${this.cab.fs || '1A'}-W01-`).replace(/[^0-9A-Za-z.\-]/g, '');
			const num = parseInt(f.rNum || sel[0], 10) || 0;

			sel.forEach((n, i) => targets.push([`${d.key}#R-pp-${n}`, `o:${prefix}${LakaInfra3DCabling.pad(num + i)}#F-jack-1`]));
		}
		else {
			const other = this.keyIndex().get(f.rDev);

			if (!other) {
				return;
			}

			const ports = LakaInfra3DCabling.panel(this.cab, other.key, other.n).ports;
			const start = parseInt(f.rPort || sel[0], 10) || 1;

			if (start + sel.length - 1 > ports) {
				this.flash('error', t('El panel de destino no tiene puertos suficientes.'));

				return;
			}

			sel.forEach((n, i) => targets.push([`${d.key}#R-pp-${n}`, `${other.key}#R-pp-${start + i}`]));
		}

		const color = f[face === 'F' ? 'fColor' : 'rColor'] || (kind === 'fiber' ? '#00b3a4' : (face === 'F' ? '#2f80ed' : '#f2c94c'));

		for (const [a, b] of targets) {
			LakaInfra3DCabling.setCable(this.cab, {a, b, k: kind, l: '', c: color, len: isFinite(len) && len > 0 ? len : null});
		}

		this.cabTouch();
		this.flash('info', t('%1$s cables documentados.', String(targets.length)));
	},

	/**
	 * Tarjeta de la pestaña Sala: identificación de la sala para las etiquetas ANSI/TIA-606.
	 * FS = número de piso + letra(s) del espacio. Ej.: piso 6, sala B → 6B; rack 6B.R01; puerto 6B.R01-42:01.
	 */
	renderFsCard() {
		const esc = LakaInfra3DEditor.esc;
		const t = this.t.bind(this);

		this.cabInit();

		const fs = this.cab.fs || '';
		const cur = LakaInfra3DEditor.parseFs(fs);
		const rack = (this.draft.racks.find((r) => (r.kind || 'rack') === 'rack') || {name: 'R01'}).name;
		const rid = LakaInfra3DCabling.rackId({fs: fs || '1A'}, rack);

		return `
			<section class="laka3d-ed-card laka3d-ed-fs">
				<div class="laka3d-ed-cardhead"><strong>${esc(t('Identificación de la sala (ANSI/TIA-606)'))}</strong></div>
				<div class="laka3d-ed-row">
					<label>${esc(t('Piso'))}
						<input type="text" maxlength="3" class="laka3d-ed-num" data-cfg="fs-floor" value="${esc(cur.floor)}" placeholder="1" aria-label="${esc(t('Piso'))}">
					</label>
					<label>${esc(t('Sala o espacio'))}
						<input type="text" maxlength="3" class="laka3d-ed-num" data-cfg="fs-space" value="${esc(cur.space)}" placeholder="A" aria-label="${esc(t('Sala o espacio'))}">
					</label>
					<span class="laka3d-ed-fs-id">${esc(t('Identificador (FS)'))} <code>${esc(fs || '—')}</code></span>
					${!fs ? `<span class="laka3d-muted">${esc(t('Sin configurar: las etiquetas usan 1A.'))}</span>` : ''}
				</div>
				<p class="laka3d-muted">${esc(t('Cada sala del edificio lleva su propio FS: número de piso y letra de la sala. Ej.: piso 1 sala A = 1A, piso 2 sala B = 2B, piso 6 sala F = 6F. Si escribes un número en la sala, se convierte en letra (sala 2 = B), como pide la norma.'))}</p>
				<div class="laka3d-ed-fs-ex">
					<span>${esc(t('Rack'))} <code>${esc(rid)}</code></span>
					<span>${esc(t('Patch panel'))} <code>${esc(rid)}-42</code></span>
					<span>${esc(t('Puerto'))} <code>${esc(rid)}-42:01</code></span>
					<span>${esc(t('Toma'))} <code>${esc((fs || '1A') + '-W01-01')}</code></span>
				</div>
			</section>`;
	},

	/** Cambios de campos del configurador y de la configuración del equipo. */
	cabChange(e) {
		const el = e.target;

		if (el.dataset.onf) {
			this.objNetField(el.dataset.onf, el.value, true);

			return true;
		}

		if (el.dataset.pwf) {
			this.setPowerField(el.dataset.pwkey, el.dataset.pwf, el.value);
			this.render();

			return true;
		}

		if (el.dataset.cfg) {
			this.cabInit();

			if (el.dataset.cfg === 'fs') {
				this.cab.fs = el.value.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 8);
				this.cabTouch();
				this.render();
			}
			else if (el.dataset.cfg === 'fs-floor' || el.dataset.cfg === 'fs-space') {
				// Piso y sala por separado: el FS se arma como piso + letra(s) de la sala (ANSI/TIA-606).
				const cur = LakaInfra3DEditor.parseFs(this.cab.fs);
				const floor = el.dataset.cfg === 'fs-floor' ? el.value : cur.floor;
				const space = el.dataset.cfg === 'fs-space' ? el.value : cur.space;

				this.cab.fs = LakaInfra3DEditor.buildFs(floor, space);
				this.cabTouch();
				this.render();
			}
			else if (el.dataset.cfg === 'part') {
				this.partsOpen = el.closest('details').dataset.key;
				this.setParts(el.closest('details'));
			}
			else {
				this.setDevCfg(el.dataset.key, el.dataset.cfg, el.value);
				this.render();
			}

			return true;
		}

		if (el.dataset.pcf && this.pc) {
			const field = el.dataset.pcf;
			const panelFields = ['media', 'cat', 'conn', 'rear', 'ports', 'style', 'func'];

			if (panelFields.includes(field)) {
				const found = this.panelItem();
				const p = LakaInfra3DCabling.panel(this.cab, this.pc.key, found ? found.d.n : 1);

				p[field] = field === 'ports' ? parseInt(el.value, 10) : el.value;

				// Al cambiar el medio, categoría, conector y terminación vuelven a valores válidos.
				if (field === 'media') {
					const m = LakaInfra3DCabling.MEDIA[p.media];

					p.cat = m.cats.includes(p.cat) ? p.cat : (p.media === 'cu' ? '6' : m.cats[0]);
					p.conn = m.conns[0];
					p.rear = m.rears[0];
				}

				this.cab.panels[this.pc.key] = LakaInfra3DCabling.panelString(p);
				this.pc.sel = this.pc.sel.filter((n) => n <= p.ports);
				this.cabTouch();
				this.render();

				return true;
			}

			this.pc.f[field] = el.value;

			if (field === 'fRack') {
				this.pc.f.fDev = '';
			}

			if (field === 'fRack' || field === 'fDev') {
				this.pc.f.fPort = '';
			}

			if (field === 'rRack') {
				this.pc.f.rDev = '';
			}

			// Las listas dependen de lo elegido (rack → equipo → puerto) y los botones se activan al completar.
			if (el.tagName === 'SELECT') {
				this.render();
			}

			return true;
		}

		return false;
	},

	cabInput(e) {
		const el = e.target;

		if (el.dataset.onf && ['len', 'label'].includes(el.dataset.onf)) {
			this.objNetField(el.dataset.onf, el.value, false);

			return true;
		}

		if (el.dataset.pcf && this.pc && ['fLen', 'rLen', 'rPrefix', 'rNum', 'rPort', 'note'].includes(el.dataset.pcf)) {
			this.pc.f[el.dataset.pcf] = el.value;

			return true;
		}

		return false;
	},

	// ================================================================ conexión de red de los elementos de la sala

	/**
	 * Sección "Conexión de red" de un elemento de la sala (cámara, control de acceso, sensor…): a qué patch panel
	 * (atrás, enlace permanente de ANSI/TIA-568) o a qué puerto de switch llega su cable, con etiqueta TIA-606,
	 * largo y el recorrido completo hasta el equipo activo.
	 */
	renderObjectNet(o) {
		const esc = LakaInfra3DEditor.esc;
		const t = this.t.bind(this);

		if (!o.id || !LakaInfra3DCabling.NET_KINDS.includes(o.kind)) {
			return '';
		}

		this.cabInit();

		const ep = LakaInfra3DCabling.objEp(o.id);
		const cur = LakaInfra3DCabling.cableAt(this.cab, ep);
		const index = this.keyIndex();

		// Estado del formulario: arranca con la conexión guardada.
		if (!this.on || this.on.id !== o.id) {
			const other = cur ? LakaInfra3DCabling.split(cur.a === ep ? cur.b : cur.a) : null;
			const dev = other ? index.get(other.key) : null;

			this.on = {
				id: o.id,
				type: dev && this.roleOf(dev) !== 'patch' ? 'switch' : 'panel',
				rack: dev ? dev.rack : '',
				dev: dev ? dev.key : '',
				port: other && dev ? `${other.face}-${other.kind}-${other.n}` : '',
				len: cur && cur.len !== null ? String(cur.len) : '',
				label: cur ? cur.l : ''
			};
		}

		const f = this.on;
		const racks = this.draft.racks.filter((r) => (r.kind || 'rack') === 'rack');
		const rack = f.rack && racks.some((r) => r.name === f.rack) ? f.rack : (racks[0] ? racks[0].name : '');
		const devs = rack ? this.itemsOf(rack).map((it) => this.devOf(it, rack)).filter((d) => {
			const role = this.roleOf(d);

			// Directo: equipos de red (switch de acceso o core, router, firewall, Wi-Fi u "otro") con puertos de datos.
			return f.type === 'panel' ? role === 'patch' : ['core', 'access', 'switch', 'router', 'firewall', 'wifi', 'other', ''].includes(role)
				&& this.portsOf(d).some((p) => p.kind === 'rj45' || p.kind === 'sfp');
		}) : [];
		const dev = devs.find((d) => d.key === f.dev) || null;
		let ports = [];

		if (dev && f.type === 'panel') {
			const cfg = LakaInfra3DCabling.panel(this.cab, dev.key, dev.n);

			ports = Array.from({length: cfg.ports}, (_, i) => ({id: `R-pp-${i + 1}`, n: i + 1}));
		}
		else if (dev) {
			ports = this.portsOf(dev).filter((p) => p.kind === 'rj45' || p.kind === 'sfp').map((p) => ({id: p.id, n: p.n, kind: p.kind}));
		}

		const portLabel = (p) => {
			const target = `${dev.key}#${p.id}`;
			const used = LakaInfra3DCabling.cableAt(this.cab, target);
			const busy = used && used.a !== ep && used.b !== ep ? ` — ${t('ocupado')}: ${this.epText(used.a === target ? used.b : used.a, index)}` : '';
			const name = f.type === 'panel' ? `${LakaInfra3DCabling.pad(p.n)} (${t('atrás')})` : `${p.kind === 'sfp' ? 'SFP' : 'RJ45'} ${p.n}`;

			return `${name}${busy}`;
		};

		// Recorrido actual: elemento → panel (atrás → frente) → switch.
		const path = cur ? LakaInfra3DCabling.path(this.cab, ep).map((x) => this.epText(x, index)).join(' → ') : '';
		const target = dev && f.port ? `${dev.key}#${f.port}` : '';
		const auto = target ? `${f.type === 'panel' ? `${this.panelTia(dev)}:${LakaInfra3DCabling.pad(parseInt(f.port.split('-')[2], 10))}` : dev.name} / ${o.name || this.kindName(o.kind)}` : '';
		const len = parseFloat(f.len);

		return `
			<fieldset class="laka3d-ed-objnet">
				<legend>${esc(t('Conexión de red'))}</legend>
				<p class="laka3d-ed-objnet-path">${cur
					? `<span class="laka3d-ok">●</span> ${esc(path)}${cur.len ? ` · ${cur.len} m` : ''}<br><span class="laka3d-muted">${esc(t('Etiqueta'))}: <code>${esc(cur.l || t('automática (ANSI/TIA-606)'))}</code></span>`
					: `<span class="laka3d-muted">${esc(t('Sin conexión documentada.'))}</span>`}</p>
				<div class="laka3d-ed-props laka3d-ed-props-col">
					<label>${esc(t('Llega a'))} <select data-onf="type">
						<option value="panel"${f.type === 'panel' ? ' selected' : ''}>${esc(t('Patch panel (enlace permanente)'))}</option>
						<option value="switch"${f.type === 'switch' ? ' selected' : ''}>${esc(t('Puerto de switch (directo)'))}</option>
					</select></label>
					<label>${esc(t('Rack'))} <select data-onf="rack">${racks.map((r) => `<option value="${esc(r.name)}"${r.name === rack ? ' selected' : ''}>${esc(r.name)}${r.mount === 'wall' ? ' · ' + esc(t('pared')) : ''}</option>`).join('')}</select></label>
					<label>${esc(f.type === 'panel' ? t('Patch panel') : t('Equipo'))} <select data-onf="dev"><option value="">—</option>${devs.map((d) => `<option value="${esc(d.key)}"${dev && d.key === dev.key ? ' selected' : ''}>U${d.u + d.n - 1} · ${esc(d.name)}</option>`).join('')}</select></label>
					<label>${esc(t('Puerto'))} <select data-onf="port"${dev ? '' : ' disabled'}><option value="">—</option>${dev ? ports.map((p) => `<option value="${esc(p.id)}"${f.port === p.id ? ' selected' : ''}>${esc(portLabel(p))}</option>`).join('') : ''}</select></label>
					<label>${esc(t('Largo (m)'))} <input type="number" min="0" max="999" step="0.5" class="laka3d-ed-num" data-onf="len" value="${esc(f.len)}" placeholder="25"></label>
					<label>${esc(t('Etiqueta'))} <input type="text" maxlength="80" data-onf="label" value="${esc(f.label)}" placeholder="${esc(auto)}"></label>
				</div>
				${f.type === 'panel' && len > LakaInfra3DCabling.MAX_LINK ? `<p class="laka3d-ed-objnet-warn">${esc(t('Más de %1$s m: supera el enlace permanente de ANSI/TIA-568.', String(LakaInfra3DCabling.MAX_LINK)))}</p>` : ''}
				${f.type === 'switch' && len > LakaInfra3DCabling.MAX_CHANNEL ? `<p class="laka3d-ed-objnet-warn">${esc(t('Más de %1$s m: supera el canal de ANSI/TIA-568.', String(LakaInfra3DCabling.MAX_CHANNEL)))}</p>` : ''}
				<div class="laka3d-ed-btns">
					<button type="button" class="laka3d-btn laka3d-btn-primary" data-on="set"${target ? '' : ' disabled'}>${esc(cur ? t('Cambiar conexión') : t('Conectar'))}</button>
					${cur ? `<button type="button" class="laka3d-btn" data-on="del">${esc(t('Quitar conexión'))}</button>` : ''}
				</div>
				<span class="laka3d-muted">${esc(t('La etiqueta vacía usa la de ANSI/TIA-606 (puerto del panel / elemento). Del frente del panel al switch se documenta en el patch panel.'))}</span>
			</fieldset>`;
	},

	objNetField(field, value, rerender) {
		if (!this.on) {
			return;
		}

		this.on[field] = value;

		if (field === 'type') {
			this.on.dev = '';
			this.on.port = '';
		}
		else if (field === 'rack') {
			this.on.dev = '';
			this.on.port = '';
		}
		else if (field === 'dev') {
			this.on.port = '';
		}

		if (rerender) {
			this.render();
		}
	},

	objNetClick(act) {
		const o = this.draft.objects[this.selectedObject];
		const t = this.t.bind(this);

		if (!o || !this.on || this.on.id !== o.id) {
			return;
		}

		this.cabInit();

		const ep = LakaInfra3DCabling.objEp(o.id);

		if (act === 'del') {
			LakaInfra3DCabling.removeCable(this.cab, ep);
			this.on = null;
			this.cabTouch();
			this.flash('info', t('Conexión quitada. Pulsa Guardar para aplicarla.'));
			this.render();

			return;
		}

		const f = this.on;

		if (!f.dev || !f.port) {
			return;
		}

		const len = parseFloat(f.len);

		LakaInfra3DCabling.setCable(this.cab, {a: ep, b: `${f.dev}#${f.port}`, k: 'net', l: f.label || '',
			c: f.type === 'panel' ? '#f2c94c' : '#2f80ed', len: isFinite(len) && len > 0 ? len : null
		});
		this.on = null;
		this.cabTouch();
		this.flash('info', t('Conexión documentada. Pulsa Guardar para aplicarla.'));
		this.render();
	},

	// ================================================================ guardar

	/**
	 * Después de guardar la sala: pasa el cableado de los pasivos movidos a su nueva posición, quita el de los
	 * eliminados y guarda cableado y componentes de modelos. Devuelve un mensaje de error o null.
	 */
	async saveCabling() {
		if (!this.cab) {
			return null;
		}

		const t = this.t.bind(this);
		const api = this.data.devapi || {};
		let moved = false;
		const remaining = new Set();

		// Dos pasos (clave temporal) para que dos paneles que intercambian lugar no se mezclen.
		const moves = [];

		for (const p of this.draft.passives) {
			const from = this.pkey(p);
			const to = LakaInfra3DCabling.passiveKey(p);

			remaining.add(to);

			if (from !== to) {
				moves.push([from, to]);
			}
		}

		for (const key of this.pkeys0) {
			if (!this.draft.passives.some((p) => this.pkey(p) === key)) {
				LakaInfra3DCabling.drop(this.cab, key);
				moved = true;
			}
		}

		moves.forEach(([from], i) => LakaInfra3DCabling.rekey(this.cab, from, `tmp:${i}`));
		moves.forEach(([, to], i) => LakaInfra3DCabling.rekey(this.cab, `tmp:${i}`, to));
		moved = moved || moves.length > 0;

		if ((this.cabDirty || moved) && api.cable_url) {
			const body = new URLSearchParams({
				_csrf_token: api.cable_csrf, lang: this.data.lang || 'es', room_key: api.room_key, op: 'replace',
				rev: String(this.cab.rev || 0),
				data: JSON.stringify({fs: this.cab.fs, list: this.cab.list, panels: this.cab.panels, devs: this.cab.devs,
					ports: this.cab.ports, pw: this.cab.pw || {}})
			});

			try {
				const response = await fetch(api.cable_url, {
					method: 'POST',
					headers: {'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'},
					body: body.toString()
				});
				const json = await response.json();

				if (!json.success) {
					return (json.error && json.error.messages || [t('No se pudo guardar el cableado.')]).join(' ');
				}

				this.data.cabling = json.cabling;

				if (json.storage && this.data.editor) {
					this.data.editor.storage = json.storage;
				}
				this.cab = LakaInfra3DCabling.clone(json.cabling);
				this.cabDirty = false;
				this.pkeys0 = new Set(remaining);
				this.draft.passives.forEach((p) => {
					p._key0 = LakaInfra3DCabling.passiveKey(p);
				});
			}
			catch (error) {
				return t('No se pudo guardar el cableado.');
			}
		}

		for (const [mkey, profile] of Object.entries(this.modelDraft || {})) {
			if (!api.model_url) {
				break;
			}

			const body = new URLSearchParams({_csrf_token: api.model_csrf, lang: this.data.lang || 'es', mkey, profile,
				n: String((this.modelN || {})[mkey] || 1), name: mkey.split('|').pop().slice(0, 40)});

			try {
				const response = await fetch(api.model_url, {
					method: 'POST',
					headers: {'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'},
					body: body.toString()
				});
				const json = await response.json();

				if (!json.success) {
					return (json.error && json.error.messages || [t('No se pudo guardar el perfil del modelo.')]).join(' ');
				}

				delete this.modelDraft[mkey];
			}
			catch (error) {
				return t('No se pudo guardar el perfil del modelo.');
			}
		}

		return null;
	},

	// ================================================================ normas

	/**
	 * Revisión de la instalación y del cableado. Cada hallazgo: nivel (error, warn, info), rack, equipo,
	 * mensaje, cómo corregirlo y la norma o buena práctica de referencia.
	 */
	normChecks() {
		this.cabInit();

		const t = this.t.bind(this);
		const out = [];
		const add = (level, rack, item, text, fix, ref) => out.push({level, rack, item, text, fix, ref});
		const racks = this.draft.racks.filter((r) => (r.kind || 'rack') === 'rack');
		const index = this.keyIndex();
		const net = ['core', 'access', 'switch', 'firewall', 'router', 'wifi'];
		const REF_INST = t('Buenas prácticas de instalación (BICSI 002, manual del fabricante)');
		const REF_AIR = t('Gestión de flujo de aire (ASHRAE TC 9.9)');

		if (!this.cab.fs) {
			add('info', null, null, t('La sala no tiene identificador de espacio (FS) para las etiquetas.'),
				t('Configúralo en la pestaña Sala (piso y sala), por ejemplo 1A = piso 1, sala A.'), 'ANSI/TIA-606');
		}

		for (const r of racks) {
			const items = this.itemsOf(r.name).map((it) => ({it, d: this.devOf(it, r.name)}));
			const units = r.units;
			let kg = 0;
			let w = 0;
			const used = new Array(units + 2).fill(false);

			for (const {it, d} of items) {
				const role = this.roleOf(d);
				const top = it.u + it.n - 1;
				const cfg = LakaInfra3DCabling.dev(this.cab, d.key);

				kg += it.kg || 0;
				w += it.w || 0;

				for (let u = it.u; u <= top && u <= units; u++) {
					used[u] = true;
				}

				// Peso: lo pesado abajo, para bajar el centro de gravedad del rack.
				if ((it.kg || 0) >= 20 && it.u > units / 2) {
					add('warn', r.name, it, t('%1$s pesa %2$s kg y está en la mitad superior (U%3$s).', d.name, String(it.kg), String(top)),
						t('Instala los equipos pesados en la parte inferior del rack.'), REF_INST);
				}

				if (['ups'].includes(role) && it.u > Math.ceil(units / 3)) {
					add('warn', r.name, it, t('La UPS %1$s está en U%2$s.', d.name, String(top)),
						t('Las UPS y los bancos de baterías van en la parte inferior del rack por su peso.'), REF_INST);
				}

				// Flujo de aire: la toma de aire debe quedar del lado del pasillo frío (frente del rack).
				if (!d.passive && role !== 'pdu') {
					const wrong = (cfg.air === 'bf' && it.face !== 'back') || (cfg.air === 'fb' && it.face === 'back' && !['patch', 'cable', 'blank'].includes(role));

					if (wrong) {
						add('warn', r.name, it, t('%1$s expulsa el aire caliente hacia el frente del rack (pasillo frío).', d.name),
							t('Móntalo de forma que tome aire del pasillo frío, o usa un kit de inversión de flujo del fabricante.'), REF_AIR);
					}
					else if (cfg.air === 'side') {
						add('info', r.name, it, t('%1$s tiene flujo de aire lateral.', d.name),
							t('Usa un deflector o ducto lateral para que tome aire frío y no recircule aire caliente.'), REF_AIR);
					}
				}
			}

			if (r.max_kg > 0 && kg > r.max_kg) {
				add('error', r.name, null, t('El peso total (%1$s kg) supera la carga máxima del rack (%2$s kg).', kg.toFixed(0), String(r.max_kg)),
					t('Reparte los equipos en otros racks.'), REF_INST);
			}

			if (r.power_kw > 0 && w > r.power_kw * 1000) {
				add('error', r.name, null, t('El consumo nominal (%1$s kW) supera la capacidad eléctrica del rack (%2$s kW).', (w / 1000).toFixed(2), String(r.power_kw)),
					t('Reparte la carga o amplía la alimentación del rack.'), REF_INST);
			}

			// Huecos: deben llevar panel ciego para que el aire caliente no vuelva al frente.
			if (items.length) {
				const gaps = [];
				let start = null;

				for (let u = 1; u <= units + 1; u++) {
					if (u <= units && !used[u]) {
						start = start ?? u;
					}
					else if (start !== null) {
						gaps.push(start === u - 1 ? `U${start}` : `U${start}–${u - 1}`);
						start = null;
					}
				}

				const free = used.slice(1, units + 1).filter((x) => !x).length;

				if (free > 0) {
					add('info', r.name, null, t('%1$s U libres sin panel ciego: %2$s.', String(free), gaps.slice(0, 6).join(', ') + (gaps.length > 6 ? '…' : '')),
						t('Cubre cada U libre con un panel ciego (o agrégalo aquí como pasivo "Panel ciego") para evitar la recirculación de aire caliente.'), REF_AIR);
				}

				if (units && (units - free) / units > 0.8) {
					add('info', r.name, null, t('El rack está ocupado en un %1$s %.', String(Math.round((units - free) / units * 100))),
						t('Reserva espacio para crecimiento o planifica un rack nuevo.'), REF_INST);
				}
			}

			// Patch panel junto a un switch sin organizador horizontal entre ambos.
			for (const {it, d} of items) {
				if (this.roleOf(d) !== 'patch') {
					continue;
				}

				for (const other of items) {
					const ro = this.roleOf(other.d);
					const touching = other.it.face === it.face && (other.it.u + other.it.n === it.u || it.u + it.n === other.it.u);

					if (touching && net.includes(ro)) {
						add('info', r.name, it, t('%1$s está pegado a %2$s sin organizador de cables.', d.name, other.d.name),
							t('Coloca un organizador horizontal de 1U entre el patch panel y el switch.'), 'ANSI/TIA-942 · ANSI/TIA-569');
					}
				}
			}

			// Nombres repetidos de pasivos en el mismo rack: la identificación queda ambigua.
			const names = new Map();

			for (const {d} of items.filter((x) => x.d.passive)) {
				names.set(d.name, (names.get(d.name) || 0) + 1);
			}

			for (const [name, count] of names) {
				if (count > 1) {
					add('warn', r.name, null, t('Hay %1$s pasivos con el nombre %2$s.', String(count), name),
						t('Cada panel debe tener un identificador único (FS.XY-U según la U donde está).'), 'ANSI/TIA-606');
				}
			}
		}

		// ---- cableado
		const cables = LakaInfra3DCabling.cables(this.cab);
		const panelOf = (ep) => {
			const p = LakaInfra3DCabling.split(ep);
			const d = index.get(p.key);

			return d && p.kind === 'pp' ? {d, cfg: LakaInfra3DCabling.panel(this.cab, d.key, d.n)} : null;
		};

		// Hallazgos de cables agrupados por par de equipos (24 enlaces largos entre dos paneles = un solo aviso).
		const groups = new Map();
		const group = (type, level, rack, eps, len, fix, ref) => {
			const names = eps.map((ep) => {
				const d = index.get(LakaInfra3DCabling.split(ep).key);

				return d ? d.name : this.epText(ep, index);
			}).sort();
			const k = `${type}|${names.join('|')}`;

			if (!groups.has(k)) {
				groups.set(k, {type, level, rack, names, count: 0, max: 0, fix, ref});
			}

			const g = groups.get(k);

			g.count++;
			g.max = Math.max(g.max, len || 0);
		};

		for (const c of cables) {
			const pa = panelOf(c.a);
			const pb = panelOf(c.b);
			const rack = (pa || pb) ? (pa || pb).d.rack : null;

			for (const p of [pa, pb].filter(Boolean)) {
				const fiber = LakaInfra3DCabling.MEDIA[p.cfg.media].fiber;

				if ((c.k === 'fiber') !== fiber && c.k !== 'power') {
					group(fiber ? 'cu-on-fiber' : 'fiber-on-cu', 'error', p.d.rack, [c.a, c.b], 0,
						t('Usa el mismo medio del panel en todo el enlace.'), 'ANSI/TIA-568');
				}
			}

			const rearRear = pa && pb && LakaInfra3DCabling.split(c.a).face === 'R' && LakaInfra3DCabling.split(c.b).face === 'R';

			if (rearRear && pa.cfg.media !== pb.cfg.media) {
				group('media', 'error', rack, [c.a, c.b], 0, t('Los dos paneles de un enlace deben ser del mismo medio.'), 'ANSI/TIA-568');
			}
			else if (rearRear && pa.cfg.cat !== pb.cfg.cat) {
				group(`cat:${[pa.cfg.cat, pb.cfg.cat].sort().join('/')}`, 'warn', rack, [c.a, c.b], 0,
					t('El enlace rinde como la categoría menor; usa componentes de la misma categoría.'), 'ANSI/TIA-568');
			}

			const rearLink = [c.a, c.b].some((ep) => LakaInfra3DCabling.split(ep).face === 'R' && panelOf(ep));
			const frontCord = [c.a, c.b].some((ep) => LakaInfra3DCabling.split(ep).face === 'F' && panelOf(ep));

			if (c.k === 'net' && rearLink && c.len > LakaInfra3DCabling.MAX_LINK) {
				group('link', 'warn', rack, [c.a, c.b], c.len, t('Acorta el recorrido o usa fibra.'), 'ANSI/TIA-568');
			}

			if (c.k === 'net' && frontCord && !rearLink && c.len > LakaInfra3DCabling.MAX_CORDS) {
				group('cord', 'warn', rack, [c.a, c.b], c.len, t('Los cordones de parcheo y de equipo suman como máximo 10 m por canal.'), 'ANSI/TIA-568');
			}

			for (const ep of [c.a, c.b]) {
				if (LakaInfra3DCabling.portState(this.cab, ep.replace('#R-pp-', '#F-pp-')).st === 'd') {
					add('warn', rack, null, t('Puerto marcado como dañado con cable conectado: %1$s.', this.epText(ep, index)),
						t('Pasa el cable a un puerto en buen estado y documenta el cambio.'), 'ANSI/TIA-606');
				}
			}
		}

		for (const g of groups.values()) {
			const pair = g.names.join(' ↔ ');
			const text = {
				'cu-on-fiber': t('%1$s cables de cobre en un panel de fibra: %2$s.', String(g.count), pair),
				'fiber-on-cu': t('%1$s cables de fibra en un panel de cobre: %2$s.', String(g.count), pair),
				media: t('%1$s enlaces troncales entre medios distintos: %2$s.', String(g.count), pair),
				link: t('%1$s enlaces permanentes de más de 90 m (hasta %2$s m): %3$s.', String(g.count), String(g.max), pair),
				cord: t('%1$s cordones de parcheo de más de 10 m (hasta %2$s m): %3$s.', String(g.count), String(g.max), pair)
			}[g.type] || t('%1$s enlaces entre categorías distintas (%2$s): %3$s.', String(g.count), g.type.split(':')[1], pair);

			add(g.level, g.rack, null, text, g.fix, g.ref);
		}

		// Canal de cobre: suma de cordones y enlaces desde un equipo hasta el otro extremo.
		const seen = new Set();

		for (const c of cables.filter((x) => x.k === 'net')) {
			for (const start of [c.a, c.b]) {
				if (panelOf(start) || seen.has(start) || start.startsWith('o:')) {
					continue;
				}

				let total = 0;
				let cur = start;
				let hops = 0;

				for (let guard = 0; guard < 12; guard++) {
					const cc = LakaInfra3DCabling.cableAt(this.cab, cur);

					if (!cc) {
						break;
					}

					total += cc.len || 0;
					hops++;

					const other = cc.a === cur ? cc.b : cc.a;

					seen.add(other);

					if (panelOf(other)) {
						cur = LakaInfra3DCabling.flip(other);
					}
					else {
						break;
					}
				}

				if (hops > 1 && total > LakaInfra3DCabling.MAX_CHANNEL) {
					const d = index.get(LakaInfra3DCabling.split(start).key);

					add('warn', d ? d.rack : null, null, t('Canal de %1$s m desde %2$s (máximo 100 m).', String(Math.round(total)), this.epText(start, index)),
						t('Reduce el largo del enlace o de los cordones.'), 'ANSI/TIA-568');
				}
			}
		}

		// Paneles con cordones al frente sin enlace permanente documentado atrás.
		for (const [key, d] of index) {
			if (this.roleOf(d) !== 'patch') {
				continue;
			}

			const ports = LakaInfra3DCabling.panel(this.cab, key, d.n).ports;
			let missing = 0;

			for (let n = 1; n <= ports; n++) {
				if (LakaInfra3DCabling.cableAt(this.cab, `${key}#F-pp-${n}`) && !LakaInfra3DCabling.cableAt(this.cab, `${key}#R-pp-${n}`)) {
					missing++;
				}
			}

			if (missing) {
				add('info', d.rack, null, t('%1$s: %2$s puertos con cordón al frente sin enlace permanente documentado atrás.', d.name, String(missing)),
					t('Documenta a dónde llega cada puerto (otro panel o la toma) para poder trazar el cable completo.'), 'ANSI/TIA-606');
			}
		}

		// Redundancia eléctrica: fuentes de un equipo en la misma alimentación.
		const feeds = new Map();

		for (const c of cables.filter((x) => x.k === 'power')) {
			for (const [mine, other] of [[c.a, c.b], [c.b, c.a]]) {
				const p = LakaInfra3DCabling.split(mine);

				if (p.kind === 'psu') {
					if (!feeds.has(p.key)) {
						feeds.set(p.key, []);
					}

					feeds.get(p.key).push(other.split('#')[0]);
				}
			}
		}

		for (const [key, list] of feeds) {
			if (list.length > 1 && new Set(list).size === 1) {
				const d = index.get(key);

				add('warn', d ? d.rack : null, null, t('Todas las fuentes de %1$s van a la misma alimentación.', d ? d.name : key),
					t('Conecta cada fuente a una PDU distinta (A y B) para tener redundancia.'), 'ANSI/TIA-942');
			}
		}

		// ---- seguridad física, incendio, ambiente y puesta a tierra de la sala
		this.securityChecks(add);
		this.objectNetChecks(add);
		this.powerChecks(add);
		this.lldpChecks(add);
		this.ambientChecks(add);

		const order = {error: 0, warn: 1, info: 2};

		return out.sort((a, b) => order[a.level] - order[b.level] || String(a.rack).localeCompare(String(b.rack)));
	},

	/**
	 * Elementos que la sala debería tener según las normas de construcción de data centers: control de acceso
	 * en cada puerta y videovigilancia (ANSI/TIA-942, seguridad física), detección de humo, central de alarma,
	 * supresión, extintores, pulsador EPO y luces de emergencia (NFPA 75/76, NFPA 72, NFPA 2001, NFPA 10,
	 * NFPA 101), sensor de fugas de agua donde hay aire acondicionado y barra de tierra (ANSI/TIA-607).
	 */
	/**
	 * Redundancia eléctrica (ANSI/TIA-942): equipos con dos fuentes en la misma rama o con una fuente sin cable,
	 * una sola rama en toda la sala, PDU sin rama, fuentes sin origen y sala sin generador.
	 */
	powerChecks(add) {
		const t = this.t.bind(this);
		const REF = 'ANSI/TIA-942 · Sistemas eléctricos';
		const same = [];
		const partial = [];
		const feeds = new Set();
		let cabled = 0;

		for (const r of this.draft.racks.filter((x) => (x.kind || 'rack') === 'rack')) {
			for (let i = 0; i < (r.vpdu || 0); i++) {
				const f = LakaInfra3DPower.feedOf(this.cab, `v:${r.name.toLowerCase()}:${'ABCD'[i]}`);

				if (f) {
					feeds.add(f);
				}
			}

			for (const it of this.itemsOf(r.name)) {
				const d = this.devOf(it, r.name);
				const role = this.roleOf(d);

				if (d.passive || ['patch', 'pdu', 'cable', 'blank'].includes(role)) {
					continue;
				}

				const psus = this.portsOf(d).filter((p) => p.kind === 'psu').map((p) => p.id);

				if (!psus.length) {
					continue;
				}

				const st = LakaInfra3DPower.deviceState(this.cab, d.key, psus);

				if (st.state !== 'none') {
					cabled++;
				}

				for (const l of st.links.filter((x) => x.src)) {
					const f = LakaInfra3DPower.feedOf(this.cab, l.src);

					if (f) {
						feeds.add(f);
					}
				}

				if (st.state === 'same') {
					same.push(`${d.name} (${r.name})`);
				}
				else if (st.state === 'partial') {
					partial.push(`${d.name} (${r.name})`);
				}
			}
		}

		const names = (list) => list.slice(0, 6).join(', ') + (list.length > 6 ? '…' : '');

		if (same.length) {
			add('warn', null, null, t('%1$s equipos con dos fuentes en la misma rama: %2$s.', String(same.length), names(same)),
				t('Conecta cada fuente a una PDU de rama distinta (A y B): si cae una rama, el equipo sigue con la otra.'), REF);
		}

		if (partial.length) {
			add('warn', null, null, t('%1$s equipos con una fuente sin cable: %2$s.', String(partial.length), names(partial)),
				t('Conecta la segunda fuente a la otra rama.'), REF);
		}

		if (cabled && feeds.size === 1) {
			add('warn', null, null, t('Toda la sala se alimenta de una sola rama (%1$s).', [...feeds][0]),
				t('Una sola rama es un único punto de falla: agrega la rama B con su propia UPS o tablero.'), REF);
		}

		const pw = this.cab.pw || {};
		const orphan = this.draft.objects.filter((o) => o.id && ['ups', 'panel', 'ats'].includes(o.kind)
			&& LakaInfra3DPower.get(this.cab, `x:${o.id}`).ups.length === 0);

		if (Object.keys(pw).length && orphan.length) {
			add('info', null, null, t('Sin "Alimentado desde": %1$s.', names(orphan.map((o) => o.name || this.kindName(o.kind)))),
				t('Indica de dónde se alimenta cada UPS, tablero y ATS para que la simulación de fallas sea completa.'), REF);
		}

		if (this.draft.objects.some((o) => o.kind === 'ups') && !this.draft.objects.some((o) => o.kind === 'generator')) {
			add('info', null, null, t('No hay grupo electrógeno: ante un corte largo la sala depende solo de las baterías.'),
				t('Dibuja el generador y el ATS (aunque estén fuera de la sala) para documentar el respaldo.'), REF);
		}
	},

	// ================================================================ redundancia (0.23.0)

	/**
	 * Autoevaluación de redundancia por subsistema (energía, climatización, telecomunicaciones) y nivel de
	 * referencia ANSI/TIA-942 (Rated-1 a Rated-4). Energía: ramas A/B, UPS, generador y simulación de cada falla
	 * simple (una rama o una UPS, tablero, ATS, transformador o generador) sobre los equipos con fuentes
	 * cableadas. Climatización: unidades instaladas frente a las necesarias (N) que indica el usuario.
	 * Telecomunicaciones: proveedores (acometidas) que indica el usuario. Es orientativo, no una certificación.
	 */
	redundancy() {
		const e = LakaInfra3DEditor.energyOf(this.draft.energy);
		const devs = [];
		const feeds = new Set();

		for (const r of this.draft.racks.filter((x) => (x.kind || 'rack') === 'rack')) {
			for (const it of this.itemsOf(r.name)) {
				const d = this.devOf(it, r.name);
				const role = this.roleOf(d);

				if (d.passive || ['patch', 'pdu', 'cable', 'blank'].includes(role)) {
					continue;
				}

				const psus = this.portsOf(d).filter((p) => p.kind === 'psu').map((p) => p.id);

				if (!psus.length) {
					continue;
				}

				const st = LakaInfra3DPower.deviceState(this.cab, d.key, psus);

				if (st.state === 'none') {
					continue;
				}

				(st.feeds || []).forEach((f) => !String(f).startsWith('pdu:') && feeds.add(f));
				devs.push({d, psus, st, name: `${d.name} (${r.name})`});
			}
		}

		const objs = this.draft.objects.filter((o) => o.id);
		const upsCount = objs.filter((o) => o.kind === 'ups').length + this.draft.racks.filter((r) => r.kind === 'ups').length;
		const generator = objs.some((o) => o.kind === 'generator');
		const multi = devs.filter((x) => x.psus.length >= 2);
		const redundant = multi.filter((x) => x.st.state === 'redundant');

		// Fallas simples: cada rama y cada elemento de la cadena eléctrica.
		const failures = [...[...feeds].map((f) => ({label: `${this.t('Rama')} ${f}`, fail: {keys: new Set(), feeds: new Set([f])}})),
			...objs.filter((o) => LakaInfra3DPower.SOURCE_KINDS.includes(o.kind))
				.map((o) => ({label: o.name || this.kindName(o.kind), fail: {keys: new Set([`x:${o.id}`]), feeds: new Set()}}))];
		const spof = [];

		for (const f of failures) {
			const memo = new Map();
			const down = devs.filter((x) => LakaInfra3DPower.deviceState(this.cab, x.d.key, x.psus, f.fail, memo).state === 'down');

			if (down.length) {
				spof.push({label: f.label, down: down.length, names: down.slice(0, 4).map((x) => x.name)});
			}
		}

		spof.sort((a, b) => b.down - a.down);

		let power = 'none';

		if (devs.length) {
			const dual = feeds.size >= 2 && multi.length > 0 && redundant.length >= multi.length * 0.9;

			power = dual && !spof.length ? '2N' : (upsCount >= 2 || feeds.size >= 2 ? 'N+1' : 'N');
		}

		const coolUnits = objs.filter((o) => ['crac', 'inrow', 'split', 'cdu'].includes(o.kind)).length
			+ this.draft.racks.filter((r) => r.kind === 'cooler').length;
		let cooling = 'none';

		if (e.cool_n > 0) {
			cooling = coolUnits < e.cool_n ? 'short' : (coolUnits >= 2 * e.cool_n ? '2N' : (coolUnits > e.cool_n ? 'N+1' : 'N'));
		}

		const telecom = e.isp_n <= 0 ? 'none' : (e.isp_n >= 2 ? '2N' : 'N');
		const rank = {none: 0, short: 0, N: 1, 'N+1': 2, '2N': 3};
		let rated = 0;

		if (power !== 'none' && cooling !== 'none') {
			rated = 1;

			if (rank[power] >= 2 && rank[cooling] >= 2) {
				rated = 2;
			}

			if (power === '2N' && rank[cooling] >= 2 && generator && telecom === '2N') {
				rated = cooling === '2N' ? 4 : 3;
			}

			if (cooling === 'short') {
				rated = 0;
			}
		}

		return {power, cooling, telecom, rated, feeds: feeds.size, upsCount, generator, devs: devs.length,
			multi: multi.length, redundant: redundant.length, spof, coolUnits, coolN: e.cool_n, isp: e.isp_n,
			space: e.space};
	},

	renderRedundancyCard() {
		const esc = LakaInfra3DEditor.esc;
		const t = this.t.bind(this);
		const r = this.redundancy();
		const color = {'2N': '#59db8f', 'N+1': '#ffc859', N: '#ffa059', short: '#e45959', none: '#97aab3'};
		const label = (v) => ({none: t('Sin datos'), short: t('Insuficiente')}[v] || v);
		const row = (name, v, detail) => `<tr><td>${esc(name)}</td><td><span class="laka3d-lf" style="background:${color[v]}">${esc(label(v))}</span></td><td class="laka3d-muted">${esc(detail)}</td></tr>`;

		return `
			<div class="laka3d-ed-card laka3d-red-card">
				<div class="laka3d-ed-cardhead"><strong>${esc(t('Autoevaluación de redundancia'))}</strong>
					<span class="laka3d-badge${r.rated ? '' : ' laka3d-badge-muted'}">${esc(r.rated ? t('Referencia TIA-942: Rated-%1$s', String(r.rated)) : t('Sin nivel: faltan datos'))}</span></div>
				${r.space === 'edge' ? `<p class="laka3d-muted">${esc(t('Micro data center de borde (edge): TIA-942-C admite diseños más simples en el borde; documenta igual energía, clima y enlaces.'))}</p>` : ''}
				<table class="laka3d-ed-table laka3d-red-table"><tbody>
					${row(t('Energía'), r.power, r.devs ? t('%1$s ramas · %2$s UPS · %3$s de %4$s equipos con dos fuentes en ramas distintas · %5$s', String(r.feeds), String(r.upsCount), String(r.redundant), String(r.multi), r.generator ? t('con generador') : t('sin generador')) : t('Cablea las fuentes de los equipos a las PDU (pestaña Cableado).'))}
					${row(t('Climatización'), r.cooling, r.coolN ? t('%1$s unidades instaladas para %2$s necesarias', String(r.coolUnits), String(r.coolN)) : t('Indica cuántas unidades de aire necesita la carga (Sala → Eficiencia y ambiente).'))}
					${row(t('Telecomunicaciones'), r.telecom, r.isp ? t('%1$s proveedores o acometidas', String(r.isp)) : t('Indica cuántos proveedores entran a la sala (Sala → Eficiencia y ambiente).'))}
				</tbody></table>
				${r.spof.length ? `<p><strong>${esc(t('Puntos únicos de falla'))}</strong></p><ul class="laka3d-amb-list">${r.spof.slice(0, 5).map((x) => `<li><strong>${esc(x.label)}</strong> ${esc(t('equipos que se apagan: %1$s', String(x.down)))} <span class="laka3d-muted">${esc(x.names.join(', '))}${x.down > x.names.length ? '…' : ''}</span></li>`).join('')}</ul>` : ''}
				<p class="laka3d-muted">${esc(t('Rated-1: componentes básicos (N) · Rated-2: componentes redundantes (N+1) · Rated-3: mantenible en funcionamiento (doble camino de energía, generador y dos acometidas) · Rated-4: tolerante a fallas (2N). Es una referencia orientativa calculada con lo documentado en el módulo, no una certificación TIA-942 ni Uptime Institute.'))}</p>
			</div>`;
	},

	// ================================================================ PUE y ASHRAE

	/**
	 * Eficiencia y ambiente con los valores actuales de Zabbix y lo que se está editando: medidor del PUE,
	 * sensores en la entrada de los racks, temperaturas fuera del rango ASHRAE, punto de rocío y humedad.
	 */
	ambientChecks(add) {
		if (typeof LakaInfra3DEnergy !== 'function') {
			return;
		}

		const t = this.t.bind(this);
		const data = Object.assign({}, this.data, {cfg: Object.assign({}, this.data.cfg || {}, {energy: this.draft.energy})});
		const en = new LakaInfra3DEnergy({data, t});
		const a = en.ashrae();
		const REF = 'ASHRAE TC 9.9 · Thermal Guidelines (2021)';
		const racks = (byBand) => [...a.byRack.values()].filter((x) => LakaInfra3DEnergy.band(x.t, a.cfg.ashrae) === byBand)
			.map((x) => `${x.rack} ${x.t.toFixed(1)} °C`);
		const [r0, r1] = LakaInfra3DEnergy.RECOMMENDED[a.cfg.ashrae];

		if (!(this.draft.energy && this.draft.energy.total.length)) {
			add('info', null, null, t('No se puede calcular el PUE: falta el medidor de energía total de la instalación.'),
				t('En la pestaña Sala → "Eficiencia y ambiente", elige la acometida o el tablero general vinculado a su medidor.'), 'ISO/IEC 30134-2');
		}

		const out = racks('out');
		const allow = racks('allow');

		if (out.length) {
			add('error', null, null, t('Entrada de aire fuera del rango permitido (%1$s): %2$s.', a.cfg.ashrae, out.slice(0, 6).join(', ')),
				t('Revisa el aire acondicionado, la contención y los paneles ciegos de esos racks.'), REF);
		}

		if (allow.length) {
			add('warn', null, null, t('Entrada de aire fuera del rango recomendado %1$s–%2$s °C: %3$s.', String(r0), String(r1), allow.slice(0, 6).join(', ')),
				t('Está dentro de lo permitido para la clase, pero conviene volver al rango recomendado.'), REF);
		}

		if (a.bands.none && a.racks.length) {
			add('info', null, null, t('%1$s racks sin sensor de temperatura en la entrada de aire.', String(a.bands.none)),
				t('Coloca sensores al frente del rack, idealmente arriba, al medio y abajo, para medir lo que respiran los equipos.'), REF);
		}

		if (a.dewBad.length || a.rhBad.length) {
			const names = [...new Set([...a.dewBad, ...a.rhBad].map((x) => x.o.name || ''))].slice(0, 6).join(', ');

			add('warn', null, null, t('Humedad fuera de lo recomendado (punto de rocío −9 a 15 °C, hasta %1$s %): %2$s.', String(a.cfg.rh), names),
				t('Revisa la humidificación y el sellado de la sala.'), REF);
		}
		else if (!a.humid.length && a.readings.length) {
			add('info', null, null, t('Sin lecturas de humedad: no se puede revisar el punto de rocío.'),
				t('Configura la clave de humedad del widget y vincula los sensores ambientales.'), REF);
		}
	},

	// ================================================================ validación LLDP / CDP

	/** Hosts de la sala (los equipos con hostid). */
	lldpRoomIds() {
		return new Set([...this.keyIndex().keys()].filter((k) => /^\d+$/.test(k)));
	},

	/** Consulta los vecinos LLDP/CDP de los hosts de la sala y los compara con el cableado documentado. */
	async lldpRun() {
		const editor = this.data.editor;
		const ids = [...this.lldpRoomIds()];

		this.lldp = {loading: true};
		this.render();

		try {
			const body = new URLSearchParams();

			ids.forEach((id) => body.append('hostids[]', id));

			const response = await fetch(editor.lldp_url, {method: 'POST',
				headers: {'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'}, body: body.toString()
			});
			const json = await response.json();

			if (!json.success) {
				throw new Error('lldp');
			}

			this.lldp = {hosts: json.hosts || {}, clock: json.clock};
			this.lldpCompare();
		}
		catch (error) {
			this.lldp = {error: true};
		}

		this.render();
	},

	lldpCompare() {
		this.cabInit();
		this.lldp.res = LakaInfra3DLldp.compare(this.cab, this.lldp.hosts, this.lldpRoomIds());
	},

	lldpName(key) {
		const d = this.keyIndex().get(String(key));

		return d ? d.name : key;
	},

	lldpPort(kind, n) {
		const names = {rj45: 'RJ45', sfp: 'SFP', mgmt: this.t('Gestión'), console: this.t('Consola')};

		return `${names[kind] || kind} ${n}`;
	},

	/** Puerto del perfil del equipo con ese número: RJ45 primero, después SFP. */
	lldpPick(key, n) {
		const d = this.keyIndex().get(String(key));

		if (!d || n === null) {
			return null;
		}

		const ports = this.portsOf(d);

		return ports.find((p) => p.kind === 'rj45' && p.n === n) || ports.find((p) => p.kind === 'sfp' && p.n === n) || null;
	},

	/** Propuesta de cable para una conexión vista y no documentada (directo, sin panel). */
	lldpProposal(u) {
		const v = u.views.find((x) => x.from === u.a) || u.views[0];
		const fromA = v.from === u.a;
		const na = LakaInfra3DLldp.portNum(fromA ? v.local : v.remote_port);
		const nb = LakaInfra3DLldp.portNum(fromA ? v.remote_port : v.local);
		const pa = this.lldpPick(u.a, na);
		const pb = this.lldpPick(u.b, nb);

		return {v, fromA, pa, pb};
	},

	lldpDocument(i) {
		const u = this.lldp && this.lldp.res ? this.lldp.res.undocumented[i] : null;

		if (!u) {
			return;
		}

		const {pa, pb} = this.lldpProposal(u);

		if (!pa || !pb) {
			return;
		}

		this.cabInit();
		LakaInfra3DCabling.setCable(this.cab, {a: `${u.a}#${pa.id}`, b: `${u.b}#${pb.id}`, k: 'net', l: '', c: '#2f80ed', len: null});
		this.cabTouch();
		this.lldpCompare();
		this.flash('info', this.t('Conexión documentada como cable directo. Si pasa por un patch panel, ajústala en la configuración del panel. Pulsa Guardar para aplicarla.'));
		this.render();
	},

	/** Tarjeta "Validación LLDP / CDP" de la pestaña Normas. */
	renderLldpCard() {
		const esc = LakaInfra3DEditor.esc;
		const t = this.t.bind(this);
		const editor = this.data.editor || {};

		if (!editor.lldp_url) {
			return '';
		}

		const st = this.lldp || {};
		const r = st.res;
		const side = (key, kind, n) => `<strong>${esc(this.lldpName(key))}</strong> ${esc(this.lldpPort(kind, n))}`;
		const seenTxt = (v) => `${esc(this.lldpName(v.from))} <code>${esc(v.local)}</code> → ${esc(v.remote)} <code>${esc(v.remote_port)}</code> <span class="laka3d-muted">${esc(v.proto.toUpperCase())}</span>`;
		let body = '';

		if (st.loading) {
			body = `<p class="laka3d-muted">${esc(t('Consultando los vecinos de los equipos…'))}</p>`;
		}
		else if (st.error) {
			body = `<p class="laka3d-dv-warn">${esc(t('No se pudieron leer los vecinos.'))}</p>`;
		}
		else if (r) {
			const mism = r.confirmed.filter((c) => !c.portOk);
			const chip = (n, text, color) => `<span class="laka3d-nm-chip" style="--chip:${color}">${esc(text)}: ${n}</span>`;

			body = `
				<div class="laka3d-nm-sum">
					${chip(r.confirmed.length - mism.length, t('Confirmadas'), '#59db8f')}
					${chip(mism.length, t('Puerto distinto'), '#ffc859')}
					${chip(r.missing.length, t('No vistas'), '#ffa059')}
					${chip(r.undocumented.length, t('Sin documentar'), '#e97659')}
					${chip(r.outside.length, t('Fuera de la sala'), '#7499ff')}
				</div>
				<p class="laka3d-muted">${esc(t('%1$s equipos de la sala reportan vecinos · %2$s conexiones documentadas entre equipos.', String(r.reporting), String(r.documented)))}</p>
				${r.reporting === 0 ? `<p class="laka3d-dv-warn">${esc(t('Ningún equipo de la sala reporta vecinos: vincula la plantilla "LAKA LLDP CDP by SNMP" a los switches y espera la primera lectura (cada hora).'))}</p>` : ''}
				${r.undocumented.length ? `<h5>${esc(t('Conexiones reales sin documentar'))}</h5><ul class="laka3d-lldp-list">${r.undocumented.map((u, i) => {
					const pr = this.lldpProposal(u);

					return `<li><span>${seenTxt(pr.v)}</span>${pr.pa && pr.pb
						? `<button type="button" class="laka3d-btn" data-nm="lldp-doc" data-i="${i}" title="${esc(t('Crea el cable %1$s ↔ %2$s', `${this.lldpName(u.a)} ${this.lldpPort(pr.pa.kind, pr.pa.n)}`, `${this.lldpName(u.b)} ${this.lldpPort(pr.pb.kind, pr.pb.n)}`))}">${esc(t('Documentar'))}</button>`
						: `<span class="laka3d-muted">${esc(t('Documéntala a mano: el perfil del equipo no tiene ese puerto.'))}</span>`}</li>`;
				}).join('')}</ul>` : ''}
				${r.missing.length ? `<h5>${esc(t('Documentadas que no se ven'))}</h5><ul class="laka3d-lldp-list">${r.missing.map((d) => `<li><span>${side(d.a, d.akind, d.ap)} ↔ ${side(d.b, d.bkind, d.bp)}${d.via ? ` <span class="laka3d-muted">${esc(t('por patch panel'))}</span>` : ''}</span><span class="laka3d-muted">${esc(t('Cable desconectado, puerto apagado o el equipo no anuncia LLDP.'))}</span></li>`).join('')}</ul>` : ''}
				${mism.length ? `<h5>${esc(t('Puerto distinto al documentado'))}</h5><ul class="laka3d-lldp-list">${mism.map((c) => `<li><span>${esc(t('Documentado'))}: ${side(c.a, c.akind, c.ap)} ↔ ${side(c.b, c.bkind, c.bp)}</span><span>${esc(t('Visto'))}: ${c.views.map(seenTxt).join(' · ')}</span></li>`).join('')}</ul>` : ''}
				${r.confirmed.length - mism.length ? `<details><summary>${esc(t('Confirmadas'))} (${r.confirmed.length - mism.length})</summary><ul class="laka3d-lldp-list">${r.confirmed.filter((c) => c.portOk).map((c) => `<li><span>${side(c.a, c.akind, c.ap)} ↔ ${side(c.b, c.bkind, c.bp)}</span><span>${c.views.map(seenTxt).join(' · ')}</span></li>`).join('')}</ul></details>` : ''}
				${r.outside.length ? `<details><summary>${esc(t('Fuera de la sala'))} (${r.outside.length})</summary><ul class="laka3d-lldp-list">${r.outside.map((v) => `<li><span>${seenTxt(v)}</span></li>`).join('')}</ul></details>` : ''}`;
		}

		return `
			<section class="laka3d-ed-card laka3d-lldp">
				<div class="laka3d-ed-cardhead">
					<strong>${esc(t('Validación con LLDP / CDP'))}</strong>
					<button type="button" class="laka3d-btn laka3d-btn-primary" data-nm="lldp"${st.loading ? ' disabled' : ''}>${esc(r ? t('Volver a consultar') : t('Consultar los equipos'))}</button>
				</div>
				<p class="laka3d-muted">${esc(t('Compara el cableado documentado con los vecinos que ven los propios switches (IEEE 802.1AB y CDP). Requiere la plantilla "LAKA LLDP CDP by SNMP" incluida en el módulo (templates/laka_lldp_cdp_snmp.yaml).'))}</p>
				${body}
			</section>`;
	},

	/** Hallazgos de la validación LLDP en la lista de normas. */
	lldpChecks(add) {
		const r = this.lldp && this.lldp.res;
		const t = this.t.bind(this);
		const REF = 'IEEE 802.1AB (LLDP) · ANSI/TIA-606';

		if (!r) {
			return;
		}

		if (r.undocumented.length) {
			add('warn', null, null, t('%1$s conexiones reales sin documentar (vistas por LLDP/CDP).', String(r.undocumented.length)),
				t('Documéntalas desde "Validación con LLDP / CDP" para que el gemelo digital coincida con la sala.'), REF);
		}

		if (r.missing.length) {
			add('warn', null, null, t('%1$s conexiones documentadas que ningún equipo ve.', String(r.missing.length)),
				t('Revisa si el cable existe, si el puerto está activo o si la documentación quedó vieja.'), REF);
		}

		const mism = r.confirmed.filter((c) => !c.portOk).length;

		if (mism) {
			add('warn', null, null, t('%1$s conexiones en un puerto distinto al documentado.', String(mism)),
				t('Corrige el puerto en el cableado o mueve el cable al puerto documentado.'), REF);
		}
	},

	/** Elementos de la sala vinculados a Zabbix que llevan red pero no tienen su cable documentado. */
	objectNetChecks(add) {
		const t = this.t.bind(this);
		const missing = this.draft.objects.filter((o) => o.id && o.hostid && LakaInfra3DCabling.NET_KINDS.includes(o.kind)
			&& !LakaInfra3DCabling.cableAt(this.cab, LakaInfra3DCabling.objEp(o.id)));

		if (missing.length) {
			add('info', null, null, t('%1$s elementos monitoreados sin conexión de red documentada: %2$s.', String(missing.length),
				missing.slice(0, 6).map((o) => o.name || this.kindName(o.kind)).join(', ') + (missing.length > 6 ? '…' : '')),
			t('Documenta en Infraestructura → Conexión de red a qué patch panel o switch llega cada uno.'), 'ANSI/TIA-606');
		}
	},

	securityChecks(add) {
		const t = this.t.bind(this);
		const objs = this.draft.objects || [];
		const has = (...kinds) => objs.some((o) => kinds.includes(o.kind));
		const racks = this.draft.racks.filter((r) => (r.kind || 'rack') === 'rack').length;

		if (!racks && !objs.length) {
			return;
		}

		const plan = this.plan();
		const pos = (o) => this.placeObject(o, plan);
		const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
		const REF_SEC = t('ANSI/TIA-942 · seguridad física');

		for (const door of objs.filter((o) => o.kind === 'door')) {
			const dp = pos(door);
			const reader = objs.some((o) => o.kind === 'access' && dist(pos(o), dp) <= 2.5);
			const camera = objs.some((o) => o.kind === 'camera' && dist(pos(o), dp) <= 8);

			if (!reader) {
				add('warn', null, null, t('La puerta %1$s no tiene control de acceso a menos de 2,5 m.', door.name || t('Puerta')),
					t('Instala un lector (biométrico, tarjeta o ambos) junto a la puerta y registra cada ingreso.'), REF_SEC);
			}

			if (!camera) {
				add('warn', null, null, t('Ninguna cámara vigila la puerta %1$s (a menos de 8 m).', door.name || t('Puerta')),
					t('Coloca una cámara que cubra el ingreso y la grabación en el NVR.'), REF_SEC);
			}
		}

		if (!has('door')) {
			add('info', null, null, t('La sala no tiene puertas dibujadas.'), t('Agrega la puerta de ingreso para revisar el control de acceso y la videovigilancia.'), REF_SEC);
		}

		if (!has('camera')) {
			add('warn', null, null, t('La sala no tiene cámaras de seguridad.'), t('Instala videovigilancia en el ingreso y en los pasillos.'), REF_SEC);
		}

		if (!has('motion')) {
			add('info', null, null, t('La sala no tiene sensores de movimiento o intrusión.'), t('Agrega detección de intrusión para fuera de horario.'), REF_SEC);
		}

		if (!has('smoke', 'vesda')) {
			add('error', null, null, t('La sala no tiene detección de humo.'),
				t('Instala detectores de humo o detección temprana por aspiración (VESDA).'), 'NFPA 75 / NFPA 76 · NFPA 72');
		}
		else if (!has('firepanel')) {
			add('info', null, null, t('Hay detectores pero no una central de alarma de incendio.'),
				t('Agrega la central que recibe los detectores y activa la alarma y la supresión.'), 'NFPA 72');
		}

		if (!has('suppression')) {
			add('warn', null, null, t('La sala no tiene sistema de supresión de incendio.'),
				t('Evalúa agente limpio o gas inerte (no daña los equipos) o rociadores de preacción.'), 'NFPA 75 · NFPA 2001');
		}

		if (!has('extinguisher')) {
			add('warn', null, null, t('La sala no tiene extintores portátiles.'),
				t('Coloca extintores de CO₂ o agente limpio, aptos para equipos eléctricos, cerca de la salida.'), 'NFPA 75 · NFPA 10');
		}

		if (!has('epo')) {
			add('info', null, null, t('La sala no tiene pulsador de apagado de emergencia (EPO).'),
				t('Instálalo junto a la salida principal, con tapa protectora contra accionamiento accidental.'), 'NFPA 75 · NEC 645');
		}

		if (!has('light')) {
			add('info', null, null, t('La sala no tiene luces de emergencia.'), t('Instala iluminación de emergencia sobre las salidas y los pasillos.'), 'NFPA 101');
		}

		if (has('crac', 'inrow', 'split') && !has('leak')) {
			add('info', null, null, t('Hay aire acondicionado pero ningún sensor de fugas de agua.'),
				t('Coloca un cable sensor de fugas bajo los aires y bajo el piso técnico.'), t('Buenas prácticas de monitoreo ambiental'));
		}

		if (racks && !has('ground')) {
			add('warn', null, null, t('La sala no tiene barra de tierra de telecomunicaciones (TGB).'),
				t('Instala al menos una barra de tierra y conecta a ella cada rack y bandeja.'), 'ANSI/TIA-607');
		}

		// Elementos sin host: no se monitorean.
		const unlinked = objs.filter((o) => ['camera', 'access', 'smoke', 'vesda', 'firepanel', 'suppression', 'leak'].includes(o.kind) && !o.hostid);

		if (unlinked.length) {
			add('info', null, null, t('%1$s elementos de seguridad o incendio no están vinculados a un host de Zabbix.', String(unlinked.length)),
				t('Vincúlalos en la pestaña Infraestructura para ver su estado y sus problemas.'), t('Monitoreo con Zabbix'));
		}
	},

	renderNorms() {
		const esc = LakaInfra3DEditor.esc;
		const t = this.t.bind(this);
		const list = this.normChecks();
		const sev = this.data.severities || [];
		const color = {error: (sev[4] || {}).color || '#e97659', warn: (sev[2] || {}).color || '#ffc859', info: (sev[1] || {}).color || '#7499ff'};
		const name = {error: t('Corregir'), warn: t('Revisar'), info: t('Recomendación')};
		const count = (lv) => list.filter((x) => x.level === lv).length;

		return `
			<p class="laka3d-muted">${esc(t('Revisión de la instalación de equipos y del cableado estructurado de esta sala, con lo guardado y lo que estás editando.'))}</p>
			<div class="laka3d-ed-row">
				<span>${esc(t('Identificador del espacio (FS)'))} <code>${esc(this.cab.fs || '—')}</code></span>
				<button type="button" class="laka3d-btn" data-tab="room">${esc(t('Configurar piso y sala'))}</button>
				<span class="laka3d-muted">${esc(t('Rack: FS.XY · panel: FS.XY-U · puerto: FS.XY-U:PP (ANSI/TIA-606).'))}</span>
			</div>
			${this.renderLldpCard()}
			${this.renderRedundancyCard()}
			<div class="laka3d-nm-sum">
				${['error', 'warn', 'info'].map((lv) => `<span class="laka3d-nm-chip" style="--chip:${esc(color[lv])}">${esc(name[lv])}: ${count(lv)}</span>`).join('')}
			</div>
			${list.length ? `<ul class="laka3d-nm-list">${list.map((x, i) => `
				<li class="laka3d-nm-item">
					<span class="laka3d-nm-chip" style="--chip:${esc(color[x.level])}">${esc(name[x.level])}</span>
					<div>
						<strong>${x.rack ? esc(t('Rack')) + ' ' + esc(x.rack) + ' · ' : ''}${esc(x.text)}</strong>
						<span>${esc(x.fix)}</span>
						<em>${esc(x.ref)}</em>
					</div>
					${x.rack ? `<button type="button" class="laka3d-btn" data-nm="go" data-i="${i}">${esc(t('Ver'))}</button>` : ''}
				</li>`).join('')}</ul>` : `<p class="laka3d-dv-ok">${esc(t('No se encontraron observaciones.'))}</p>`}
			<div class="laka3d-ed-card laka3d-nm-refs">
				<div class="laka3d-ed-cardhead"><strong>${esc(t('Normas que se revisan'))}</strong></div>
				<ul>
					<li><strong>ANSI/TIA-942</strong> · ${esc(t('Espacios del data center (cuarto de entrada, MDA, HDA, ZDA, EDA), cableado troncal y horizontal en estrella, redundancia y seguridad física (control de acceso y videovigilancia).'))}</li>
					<li><strong>ANSI/TIA-568</strong> · ${esc(t('Medios y categorías; cobre: enlace permanente hasta 90 m, cordones hasta 10 m, canal hasta 100 m.'))}</li>
					<li><strong>ANSI/TIA-606</strong> · ${esc(t('Identificación: rack FS.XY, panel FS.XY-U, puerto FS.XY-U:PP y la misma etiqueta en los dos extremos del cable.'))}</li>
					<li><strong>ASHRAE TC 9.9</strong> · ${esc(t('Pasillo frío y caliente, toma de aire por el frente y paneles ciegos en las U libres.'))}</li>
					<li><strong>NFPA 75 / 76 · 72 · 2001 · 10 · 101</strong> · ${esc(t('Detección de humo, central de alarma, supresión, extintores, pulsador EPO y luces de emergencia.'))}</li>
					<li><strong>ANSI/TIA-607</strong> · ${esc(t('Puesta a tierra: barra de tierra (TGB) y conexión de cada rack.'))}</li>
					<li><strong>BICSI 002</strong> · ${esc(t('Instalación: equipos pesados, UPS y baterías abajo; organizadores de cables; capacidad de peso y energía del rack.'))}</li>
				</ul>
			</div>`;
	},

	normClick(e) {
		const lldpBtn = e.target.closest('[data-nm="lldp"], [data-nm="lldp-doc"]');

		if (lldpBtn) {
			if (lldpBtn.dataset.nm === 'lldp') {
				this.lldpRun();
			}
			else {
				this.lldpDocument(parseInt(lldpBtn.dataset.i, 10));
			}

			return true;
		}

		const btn = e.target.closest('[data-nm="go"]');

		if (!btn) {
			return false;
		}

		const x = this.normChecks()[parseInt(btn.dataset.i, 10)];

		if (x && x.rack) {
			this.tab = 'devices';
			this.selectedRack = x.rack;
			this.selectedItem = x.item ? {kind: x.item.kind, id: x.item.id} : null;
			this.face = x.item && x.item.face === 'back' ? 'back' : 'front';
			this.render();
		}

		return true;
	}
});
