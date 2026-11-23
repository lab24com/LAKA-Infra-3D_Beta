/*
 * LAKA Infra 3D – gemelo digital de data center para Zabbix 7.0 – 8.0
 * © LAKA Soluciones Tecnológicas
 * Autor: Willian Tola
 * Licencia GPLv3
 *
 * Vista detallada del rack: elevación del frente y de atrás con el frente de cada equipo dibujado
 * (puertos, discos, ventilación, pantalla), nombres alineados a cada U y la tabla de equipos del rack
 * con U, papel, modelo (inventario de Zabbix), altura, cara y estado.
 * Se abre al hacer clic en un rack de la sala 3D o desde la ventana del rack.
 */

class LakaInfra3DRackView {

	// Papeles elegidos en el editor (clave del equipo → papel); los carga LakaInfra3DCabling.applyRoles.
	static overrides = new Map();

	constructor(scene) {
		this.scene = scene;
		this.el = null;
		this.name = null;
	}

	t(...args) {
		return this.scene.t(...args);
	}

	// ---------------------------------------------------------------- papel del equipo

	/**
	 * Papel del equipo para dibujarlo y mostrarlo en la tabla. El tipo guardado es general (Red, Servidor, Patch
	 * panel…); el papel se deduce del nombre del host, del nombre visible y del modelo y fabricante del inventario.
	 */
	static role(d) {
		// Papel elegido en el editor de sala (Configuración del equipo): manda sobre lo deducido.
		const forced = LakaInfra3DRackView.overrides && LakaInfra3DRackView.overrides.get(d.key || d.id);

		if (forced) {
			return forced;
		}

		const inv = d.inv || {};
		const txt = ` ${d.name} ${d.host || ''} ${inv.model || ''} ${inv.vendor || ''} `.toLowerCase();

		if (d.type === 'patch') {
			if (/organiz|cable|guia|guía|passa ?cabo|\borg\b/.test(txt)) {
				return 'cable';
			}

			if (/blank|ciego|cego|tapa/.test(txt)) {
				return 'blank';
			}

			return 'patch';
		}

		if (d.type === 'network') {
			if (/fortigate|firewall|\bfw\b|palo ?alto|\basa\b|sophos|check ?point|pfsense|opnsense|\butm\b/.test(txt)) {
				return 'firewall';
			}

			if (/router|\brt\b|\bisr\b|\basr\b|\bccr|mikrotik|edgerouter|\bgw\b|gateway/.test(txt)) {
				return 'router';
			}

			if (/\bap\b|\bwlc\b|wireless|wi-?fi/.test(txt)) {
				return 'wifi';
			}

			if (/core|spine|n[uú]cleo|\bcr\b|distrib/.test(txt)) {
				return 'core';
			}

			if (/\bacc\b|access|acceso|acesso|\bedge\b/.test(txt)) {
				return 'access';
			}

			return 'switch';
		}

		return ['server', 'storage', 'ups', 'pdu'].includes(d.type) ? d.type : 'other';
	}

	roleName(role) {
		return this.t({
			firewall: 'Firewall', router: 'Router', wifi: 'Controladora Wi-Fi', core: 'Switch core',
			access: 'Switch de acceso', switch: 'Switch', server: 'Servidor', storage: 'Storage', ups: 'UPS',
			pdu: 'PDU', patch: 'Patch panel', cable: 'Organizador de cables', blank: 'Panel ciego', other: 'Otro'
		}[role] || 'Otro');
	}

	// ---------------------------------------------------------------- abrir y cerrar

	ensure() {
		if (this.el) {
			return;
		}

		this.el = document.createElement('div');
		this.el.className = 'laka3d-rv';
		this.el.hidden = true;
		this.el.tabIndex = -1;
		this.el.setAttribute('role', 'dialog');
		this.el.setAttribute('aria-modal', 'true');
		this.scene.root.appendChild(this.el);

		this.el.addEventListener('click', (e) => this.click(e));
		this.el.addEventListener('keydown', (e) => {
			if (e.key === 'Escape') {
				e.stopPropagation();
				this.close();
			}
			else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.target.closest('input, select, textarea')) {
				this.step(e.key === 'ArrowLeft' ? -1 : 1);
			}
		});
	}

	open(name) {
		const s = this.scene;

		if (!s.world || !s.world.racks.has(name) || (s.noc && s.noc.active)) {
			return;
		}

		this.ensure();
		this.name = name;
		this.el.hidden = false;
		this.render();
		this.el.focus({preventScroll: true});
	}

	close() {
		if (!this.el || this.el.hidden) {
			return;
		}

		this.el.hidden = true;
		this.name = null;
	}

	get isOpen() {
		return !!(this.el && !this.el.hidden);
	}

	/** Datos nuevos de Zabbix: redibuja si sigue abierta (o se cierra si el rack ya no existe). */
	refresh() {
		if (!this.isOpen) {
			return;
		}

		if (!this.scene.world || !this.scene.world.racks.has(this.name)) {
			this.close();

			return;
		}

		const body = this.el.querySelector('.laka3d-rv-body');
		const top = body ? body.scrollTop : 0;

		this.render();

		const again = this.el.querySelector('.laka3d-rv-body');

		if (again) {
			again.scrollTop = top;
		}
	}

	racks() {
		return [...this.scene.world.racks.values()].filter((r) => !r.cooler);
	}

	/** Rack anterior o siguiente de la sala (en el orden de las filas). */
	step(dir) {
		const names = [...this.scene.world.racks.entries()].filter(([, r]) => !r.cooler).map(([n]) => n);
		const at = names.indexOf(this.name);

		if (names.length < 2 || at < 0) {
			return;
		}

		const next = names[(at + dir + names.length) % names.length];

		// La cámara de la sala también va al rack, para que al volver se vea dónde está.
		this.scene.openRack(next, true, false);
		this.name = next;
		this.render();
	}

	click(e) {
		const act = e.target.closest('[data-rv]');
		const dev = e.target.closest('[data-dev]');

		if (act) {
			const a = act.dataset.rv;

			if (a === 'close') {
				this.close();
			}
			else if (a === 'report' && this.scene.report) {
				this.scene.report.open(this.name);
			}
			else if (a === 'prev' || a === 'next') {
				this.step(a === 'prev' ? -1 : 1);
			}

			return;
		}

		if (dev) {
			// Como en la sala: abre la ventana del equipo y la cámara va hasta él.
			const d = this.scene.world.devicesById.get(dev.dataset.dev);

			if (d) {
				this.close();
				this.scene.selectDevice(d, {detail: true});
			}
		}
	}

	// ---------------------------------------------------------------- estado

	status(d) {
		const s = this.scene;

		if (d.passive) {
			return {cls: 'is-passive', text: this.t('Pasivo'), color: '#7f8a94'};
		}

		if (d.sev >= 0) {
			const sev = s.data.severities[d.sev];

			return {cls: 'is-sev', text: sev.name, color: sev.color};
		}

		if (d.maint) {
			return {cls: 'is-maint', text: this.t('Mantenimiento'), color: LakaInfra3DScene.MAINT_COLOR};
		}

		const down = (d.avail || []).some((a) => a.state === 2);

		if (down) {
			return {cls: 'is-down', text: this.t('No disponible'), color: '#e45959'};
		}

		return {cls: 'is-ok', text: 'OK', color: LakaInfra3DScene.OK_COLOR};
	}

	// ---------------------------------------------------------------- dibujo

	render() {
		const s = this.scene;
		const esc = LakaInfra3DScene.esc;
		const t = this.t.bind(this);
		const rack = s.world.racks.get(this.name);
		const def = rack.def;
		const devs = rack.devices.slice().sort((a, b) => (b.d.u + b.d.n) - (a.d.u + a.d.n) || (a.d.face === 'back') - (b.d.face === 'back'));
		const cap = s.capacity ? s.capacity.of(rack) : null;
		const probs = devs.filter((x) => x.d.sev >= 0);
		const temps = devs.map((x) => x.d.temp).filter((v) => v !== null && v !== undefined);
		const worst = probs.reduce((m, x) => (x.d.sev > m.sev ? x.d : m), {sev: -1, maint: false});
		const hasBack = devs.some((x) => x.d.face === 'back');
		const count = this.racks().length;

		// Tamaño de la U según el alto disponible, para ver el rack completo sin bajar (entre 12 y 22 px).
		const avail = Math.max(300, (this.el.clientHeight || s.root.clientHeight || 700) - 150);
		const px = Math.max(12, Math.min(22, Math.floor(avail / (def.units + 1))));

		const kpi = (label, value, extra = '') => `<div class="laka3d-rv-kpi"><span>${esc(label)}</span><strong>${value}</strong>${extra}</div>`;
		const kw = (w) => `${(w / 1000).toFixed(2)} kW`;
		const kpis = [
			kpi(t('Ocupación'), `${cap ? cap.used : 0}/${def.units} U`),
			kpi(t('Problemas'), `<span style="color:${probs.length ? esc(s.sevColor(worst)) : 'inherit'}">${probs.length}</span>`),
			kpi(t('Temp. máx.'), temps.length ? `${Math.max(...temps)} °C` : '—'),
			cap ? kpi(t('Energía'), cap.load !== null ? (cap.capW > 0 ? `${kw(cap.load)} / ${kw(cap.capW)}` : kw(cap.load)) : '—') : '',
			cap ? kpi(t('Peso'), `${cap.kg ? cap.kg.toFixed(0) : 0}${cap.maxKg ? ' / ' + cap.maxKg : ''} kg`) : ''
		].join('');

		const tempCol = temps.length > 0;
		const rows = devs.map((x) => this.rowHtml(x.d, tempCol)).join('');

		this.el.setAttribute('aria-label', `${t('Rack')} ${this.name}`);
		this.el.innerHTML = `
			<div class="laka3d-rv-head">
				<div class="laka3d-rv-title">
					<span class="laka3d-dot" style="background:${esc(s.sevColor(worst))}"></span>
					<div>
						<strong>${esc(t('Rack'))} ${esc(this.name)}</strong>
						<span class="laka3d-muted">${esc(s.roomName())} · ${esc(LakaInfra3DScene.rackWhere(def, t))} · ${def.units}U</span>
					</div>
				</div>
				<div class="laka3d-rv-kpis">${kpis}</div>
				<div class="laka3d-rv-actions">
					${count > 1 ? `<button type="button" class="laka3d-btn" data-rv="prev" title="${esc(t('Rack anterior'))}" aria-label="${esc(t('Rack anterior'))}">‹</button>
					<button type="button" class="laka3d-btn" data-rv="next" title="${esc(t('Rack siguiente'))}" aria-label="${esc(t('Rack siguiente'))}">›</button>` : ''}
					${s.report ? `<button type="button" class="laka3d-btn" data-rv="report">${esc(t('Reporte del rack'))}</button>` : ''}
					<button type="button" class="laka3d-btn" data-rv="close">${esc(t('Volver a la sala'))}</button>
				</div>
			</div>
			<div class="laka3d-rv-body">
				<div class="laka3d-rv-elevs">
					${this.elevationSvg(rack, 'front', px, true)}
					${this.elevationSvg(rack, 'back', px, hasBack)}
				</div>
				<div class="laka3d-rv-table">
					<div class="laka3d-rv-tablehead">
						<strong>${esc(t('Equipos del rack'))}</strong>
						<span class="laka3d-muted">${esc(t('%1$s elementos · de arriba hacia abajo', String(devs.length)))}</span>
					</div>
					${devs.length ? `
					<table>
						<thead><tr>
							<th>U</th><th>${esc(t('Equipo'))}</th><th>${esc(t('Papel'))}</th><th>${esc(t('Modelo'))}</th>
							<th>${esc(t('Altura · cara'))}</th>${tempCol ? `<th>${esc(t('Temp.'))}</th>` : ''}<th>${esc(t('Estado'))}</th>
						</tr></thead>
						<tbody>${rows}</tbody>
					</table>` : `<p class="laka3d-muted">${esc(t('Rack vacío.'))}</p>`}
				</div>
			</div>
			<div class="laka3d-rv-foot">© LAKA Soluciones Tecnológicas</div>`;
	}

	rowHtml(d, tempCol) {
		const esc = LakaInfra3DScene.esc;
		const role = LakaInfra3DRackView.role(d);
		const st = this.status(d);
		const inv = d.inv || {};
		const model = [inv.vendor, inv.model].filter((v) => v && v.trim() !== '').join(' ');
		const top = d.u + d.n - 1;
		const face = d.face === 'back' ? this.t('atrás') : this.t('frente');
		const temp = d.temp !== null && d.temp !== undefined ? `${d.temp} °C` : '—';
		const title = d.problems && d.problems[0] ? d.problems[0].name : '';

		return `
			<tr data-dev="${esc(d.id)}" tabindex="0" class="${d.passive ? 'is-passive' : ''}">
				<td class="laka3d-rv-u">U${top}${d.n > 1 ? `<span>–${d.u}</span>` : ''}</td>
				<td class="laka3d-rv-name"><i style="background:${esc(st.color)}"></i>${esc(d.name)}</td>
				<td>${esc(this.roleName(role))}</td>
				<td class="laka3d-muted">${esc(model || '—')}</td>
				<td>${d.n}U · ${esc(face)}</td>
				${tempCol ? `<td>${esc(temp)}</td>` : ''}
				<td><span class="laka3d-rv-chip ${st.cls}" style="--chip:${esc(st.color)}" title="${esc(title)}">${esc(st.text)}</span></td>
			</tr>`;
	}

	/**
	 * Elevación de una cara del rack en SVG: rieles con los números de U, el frente de cada equipo y,
	 * a la derecha, los nombres alineados con una línea guía. Los equipos de la otra cara se marcan con
	 * un contorno punteado (ocupan la profundidad del rack).
	 */
	elevationSvg(rack, face, px, labels) {
		const esc = LakaInfra3DScene.esc;
		const units = rack.def.units;
		const rail = Math.max(18, Math.round(px * 1.05));
		const inner = Math.round(px * 10.8);
		const rackW = inner + rail * 2;
		const labelW = labels ? 150 : 0;
		const top = 30;
		const H = top + units * px + 10;
		const W = rackW + labelW;
		const font = Math.max(9, Math.min(12, Math.round(px * 0.55)));
		let svg = '';

		// Marco, fondo y rieles con agujeros cuadrados (uno por U, como en un rack real).
		svg += `<rect class="rv-frame" x="0.5" y="${top - 6}" width="${rackW - 1}" height="${units * px + 12}" rx="4"/>`;
		svg += `<rect class="rv-bay" x="${rail}" y="${top}" width="${inner}" height="${units * px}"/>`;

		for (let u = units; u >= 1; u--) {
			const y = top + (units - u) * px;
			const mid = y + px / 2;
			const strong = u % 5 === 0 ? ' rv-un-strong' : '';

			svg += `<line class="rv-uline" x1="${rail}" y1="${y}" x2="${rail + inner}" y2="${y}"/>`;
			svg += `<text class="rv-un${strong}" x="${rail / 2}" y="${mid}" font-size="${font - 2}">${u}</text>`;
			svg += `<text class="rv-un${strong}" x="${rackW - rail / 2}" y="${mid}" font-size="${font - 2}">${u}</text>`;
			svg += `<rect class="rv-hole" x="${rail - 5}" y="${mid - 1.5}" width="3" height="3"/><rect class="rv-hole" x="${rail + inner + 2}" y="${mid - 1.5}" width="3" height="3"/>`;
		}

		const title = face === 'front' ? this.t('Frente') : this.t('Atrás');
		let devices = '';
		let names = '';

		for (const x of rack.devices) {
			const d = x.d;
			const own = (d.face === 'back') === (face === 'back');
			const y = top + (units - (d.u + d.n - 1)) * px + 0.5;
			const h = d.n * px - 1;

			if (!own) {
				devices += `<rect class="rv-other" x="${rail + 2}" y="${y + 1}" width="${inner - 4}" height="${h - 2}" rx="1.5"><title>${esc(d.name)} · ${esc(face === 'front' ? this.t('montado atrás') : this.t('montado al frente'))}</title></rect>`;
				continue;
			}

			const role = LakaInfra3DRackView.role(d);
			const st = this.status(d);
			const alarm = !d.passive && (d.sev >= 0 || st.cls === 'is-down');

			devices += `<g class="rv-dev${alarm ? ' is-alarm' : ''}" data-dev="${esc(d.id)}" tabindex="0" role="button" aria-label="${esc(d.name)}, U${d.u}">`
				+ `<title>${esc(d.name)} · ${esc(this.roleName(role))} · U${d.u}${d.n > 1 ? '–' + (d.u + d.n - 1) : ''} · ${esc(st.text)}</title>`
				+ this.faceplate(role, rail - 3, y, inner + 6, h, d.n)
				+ (d.passive ? '' : `<circle class="rv-led" cx="${rail + 1.5}" cy="${y + Math.min(h / 2, px / 2)}" r="${Math.max(2, px * 0.14)}" fill="${esc(st.color)}"/>`)
				+ (alarm ? `<rect class="rv-alarm" x="${rail - 3}" y="${y}" width="${inner + 6}" height="${h}" rx="1.5" stroke="${esc(st.color)}"/>` : '')
				+ '</g>';

			if (labels) {
				const ly = y + Math.min(h / 2, px / 2 + 0.5);

				names += `<g class="rv-label${d.passive ? ' is-passive' : ''}" data-dev="${esc(d.id)}">`
					+ `<line x1="${rackW + 4}" y1="${ly}" x2="${rackW + 16}" y2="${ly}"/>`
					+ `<text x="${rackW + 20}" y="${ly}" font-size="${font}">${esc(d.name.length > 20 ? d.name.slice(0, 19) + '…' : d.name)}</text></g>`;
			}
		}

		return `
			<div class="laka3d-rv-face">
				<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">
					<text class="rv-title" x="${rackW / 2}" y="14">${esc(title.toUpperCase())}</text>
					${labels ? `<text class="rv-coltitle" x="${rackW + 20}" y="14">${esc(this.t('Equipo').toUpperCase())}</text>` : ''}
					${svg}${devices}${names}
				</svg>
			</div>`;
	}

	/**
	 * Frente del equipo según su papel: puertos RJ45 y SFP en switches, routers y firewalls, bahías de discos
	 * en servidores y storage, pantalla en la UPS, tomas en la PDU, peines en el organizador de cables.
	 */
	faceplate(role, x, y, w, h, n) {
		const r = (cls, rx, ry, rw, rh, extra = '') => `<rect class="${cls}" x="${rx.toFixed(1)}" y="${ry.toFixed(1)}" width="${Math.max(0.5, rw).toFixed(1)}" height="${Math.max(0.5, rh).toFixed(1)}"${extra}/>`;
		const uh = h / n;
		const ear = Math.max(3, w * 0.035);
		const bx = x + ear;
		const bw = w - ear * 2;
		let out = '';

		// Cuerpo con orejas de montaje y tornillos.
		const body = ['firewall'].includes(role) ? 'rv-body-light' : (['patch', 'cable', 'blank'].includes(role) ? 'rv-body-black' : 'rv-body');

		out += r('rv-ear', x, y, w, h, ' rx="1.5"');
		out += r(body, bx, y, bw, h);

		for (let i = 0; i < n; i++) {
			const sy = y + i * uh + uh / 2;

			out += `<circle class="rv-screw" cx="${(x + ear / 2).toFixed(1)}" cy="${sy.toFixed(1)}" r="${Math.max(0.8, ear * 0.28).toFixed(1)}"/><circle class="rv-screw" cx="${(x + w - ear / 2).toFixed(1)}" cy="${sy.toFixed(1)}" r="${Math.max(0.8, ear * 0.28).toFixed(1)}"/>`;
		}

		// Bloque de puertos: columnas agrupadas de a 6, en una o dos filas, como un switch real.
		const ports = (x0, x1, rows, cols, cls = 'rv-port', yy = y, hh = h) => {
			let s = '';
			const groups = Math.ceil(cols / 6);
			const gap = (x1 - x0) * 0.025;
			const pw = ((x1 - x0) - gap * (groups - 1)) / cols;
			const rh = (hh - uh * 0.36) / rows;

			for (let rr = 0; rr < rows; rr++) {
				for (let c = 0; c < cols; c++) {
					const px0 = x0 + c * pw + Math.floor(c / 6) * gap;

					s += r(cls, px0 + pw * 0.12, yy + uh * 0.18 + rr * rh + rh * 0.1, pw * 0.76, rh * 0.8);
				}
			}

			return s;
		};
		const sfp = (x0, x1, count, rows = 1) => {
			let s = '';
			const sw = (x1 - x0) / Math.ceil(count / rows);
			const rh = (h - uh * 0.36) / rows;

			for (let i = 0; i < count; i++) {
				const c = i % Math.ceil(count / rows);
				const rr = Math.floor(i / Math.ceil(count / rows));

				s += r('rv-sfp', x0 + c * sw + sw * 0.1, y + uh * 0.18 + rr * rh + rh * 0.12, sw * 0.8, rh * 0.76);
			}

			return s;
		};
		const leds = (x0, count) => {
			let s = '';

			for (let i = 0; i < count; i++) {
				s += `<circle class="rv-sled" cx="${(x0 + i * Math.max(2.5, uh * 0.22)).toFixed(1)}" cy="${(y + uh * 0.32).toFixed(1)}" r="${Math.max(0.7, uh * 0.06).toFixed(1)}"/>`;
			}

			return s;
		};
		const vents = (x0, x1) => {
			let s = '';
			const step = Math.max(2.2, uh * 0.2);

			for (let vx = x0; vx < x1; vx += step) {
				s += `<line class="rv-vent" x1="${vx.toFixed(1)}" y1="${(y + h * 0.22).toFixed(1)}" x2="${(vx + step * 0.6).toFixed(1)}" y2="${(y + h * 0.78).toFixed(1)}"/>`;
			}

			return s;
		};

		switch (role) {
			case 'switch':
			case 'access':
				out += leds(bx + bw * 0.03, 3);
				out += ports(bx + bw * 0.12, bx + bw * 0.8, Math.min(2, Math.max(1, n * 2)), 24);
				out += sfp(bx + bw * 0.83, bx + bw * 0.97, 4, n > 1 ? 2 : 1);
				break;

			case 'core':
				out += leds(bx + bw * 0.03, 4);
				out += sfp(bx + bw * 0.12, bx + bw * 0.62, 24, 2);
				out += sfp(bx + bw * 0.66, bx + bw * 0.97, 6, 1);
				break;

			case 'firewall':
				out += r('rv-brand', bx + bw * 0.03, y + h * 0.3, bw * 0.12, h * 0.4);
				out += leds(bx + bw * 0.18, 3);
				out += ports(bx + bw * 0.3, bx + bw * 0.78, 2, 12, 'rv-port-dark');
				out += sfp(bx + bw * 0.81, bx + bw * 0.97, 4, 2);
				break;

			case 'router':
				out += leds(bx + bw * 0.03, 3);
				out += r('rv-slot', bx + bw * 0.12, y + h * 0.18, bw * 0.3, h * 0.64);
				out += ports(bx + bw * 0.46, bx + bw * 0.72, 1, 6);
				out += sfp(bx + bw * 0.76, bx + bw * 0.96, 4, 1);
				break;

			case 'wifi':
				out += leds(bx + bw * 0.03, 4);
				out += ports(bx + bw * 0.6, bx + bw * 0.95, 1, 8);
				break;

			case 'server': {
				// Bahías de discos: 8 por U (2 filas desde 2U), ventilación a la izquierda y botón de encendido.
				out += vents(bx + bw * 0.02, bx + bw * 0.14);
				const rows = n >= 2 ? Math.min(4, n) : 1;
				const cols = n >= 2 ? 6 : 8;
				const x0 = bx + bw * 0.17;
				const x1 = bx + bw * 0.88;
				const cw = (x1 - x0) / cols;
				const rh = (h - uh * 0.3) / rows;

				for (let rr = 0; rr < rows; rr++) {
					for (let c = 0; c < cols; c++) {
						out += r('rv-bay-disk', x0 + c * cw + cw * 0.06, y + uh * 0.15 + rr * rh + rh * 0.08, cw * 0.88, rh * 0.84);
						out += r('rv-disk-led', x0 + c * cw + cw * 0.12, y + uh * 0.15 + rr * rh + rh * 0.2, cw * 0.08, rh * 0.25);
					}
				}

				out += `<circle class="rv-power" cx="${(bx + bw * 0.94).toFixed(1)}" cy="${(y + uh / 2).toFixed(1)}" r="${Math.max(1.2, uh * 0.16).toFixed(1)}"/>`;
				break;
			}

			case 'storage': {
				const rows = Math.max(1, Math.min(4, n));
				const cols = 12;
				const x0 = bx + bw * 0.04;
				const x1 = bx + bw * 0.96;
				const cw = (x1 - x0) / cols;
				const rh = (h - uh * 0.3) / rows;

				for (let rr = 0; rr < rows; rr++) {
					for (let c = 0; c < cols; c++) {
						out += r('rv-bay-disk', x0 + c * cw + cw * 0.06, y + uh * 0.15 + rr * rh + rh * 0.08, cw * 0.88, rh * 0.84);
						out += r('rv-disk-led', x0 + c * cw + cw * 0.4, y + uh * 0.15 + rr * rh + rh * 0.65, cw * 0.2, rh * 0.15);
					}
				}

				break;
			}

			case 'ups':
				out += r('rv-lcd', bx + bw * 0.06, y + Math.min(h * 0.25, uh * 0.25), bw * 0.2, Math.min(h * 0.5, uh * 0.5));
				out += leds(bx + bw * 0.3, 4);
				out += vents(bx + bw * 0.45, bx + bw * 0.96);
				break;

			case 'pdu':
				for (let i = 0; i < 10; i++) {
					out += r('rv-outlet', bx + bw * (0.12 + i * 0.08), y + h * 0.28, bw * 0.05, h * 0.44, ' rx="1"');
				}

				out += r('rv-lcd', bx + bw * 0.02, y + h * 0.3, bw * 0.07, h * 0.4);
				break;

			case 'patch':
				for (let rr = 0; rr < n; rr++) {
					out += ports(bx + bw * 0.06, bx + bw * 0.94, 1, 24, 'rv-port', y + rr * uh, uh);
				}

				break;

			case 'cable': {
				// Organizador de cables: peines blancos en dos grupos.
				for (let rr = 0; rr < n; rr++) {
					for (const [a, b] of [[0.08, 0.46], [0.54, 0.92]]) {
						const x0 = bx + bw * a;
						const x1 = bx + bw * b;
						const fy = y + rr * uh;

						out += r('rv-finger-base', x0, fy + uh * 0.18, x1 - x0, uh * 0.2, ' rx="1"');

						for (let i = 0; i < 6; i++) {
							out += r('rv-finger', x0 + (x1 - x0) * (0.02 + i * 0.165), fy + uh * 0.35, (x1 - x0) * 0.12, uh * 0.45, ' rx="1"');
						}
					}
				}

				break;
			}

			case 'blank':
				break;

			default:
				out += leds(bx + bw * 0.03, 2);
				out += r('rv-slot', bx + bw * 0.15, y + h * 0.3, bw * 0.7, h * 0.4);
		}

		return out;
	}
}
