/*
 * LAKA Infra 3D – gemelo digital de data center para Zabbix 7.0 – 8.0
 * © LAKA Soluciones Tecnológicas
 * Autor: Willian Tola
 * Licencia GPLv3
 *
 * Vista detallada del equipo: frente y parte trasera con lo que tiene cada lado (puertos RJ45 y SFP, consola,
 * gestión, USB, discos, fuentes de poder, ventiladores, tomas), el estado de cada interfaz y fuente según Zabbix,
 * la foto del modelo (si se subió), el cableado de red y de energía con su trazado completo a través de los
 * patch panels, y la salud del servidor (CPU, RAM, discos, servicios).
 *
 * Perfil de hardware: lo guardado para el modelo (fabricante + modelo del inventario de Zabbix); si no hay,
 * las interfaces, fuentes y ventiladores descubiertos por las plantillas de Zabbix; si tampoco, uno típico
 * según el papel del equipo.
 *
 * Identificación de puertos y cables según ANSI/TIA-606: puerto "FS.XY-UU:PP" (espacio, rack, U superior
 * del equipo o panel, puerto) y cable "extremo A / extremo B", la misma etiqueta en las dos puntas.
 */

class LakaInfra3DDevView {

	// Componentes de cada cara: nombre, si lleva cable y de qué tipo.
	static PARTS = {
		rj45: {name: 'RJ45', cable: 'net'},
		sfp: {name: 'SFP', cable: 'fiber'},
		console: {name: 'Consola', cable: 'net'},
		mgmt: {name: 'Gestión', cable: 'net'},
		usb: {name: 'USB', cable: null},
		vga: {name: 'VGA', cable: null},
		disk: {name: 'Discos', cable: null},
		psu: {name: 'Fuentes de poder', cable: 'power'},
		fan: {name: 'Ventiladores', cable: null},
		outlet: {name: 'Tomas', cable: 'power'},
		pp: {name: 'Puertos del panel', cable: 'net'}
	};

	// Colores de cable habituales en un data center.
	static COLORS = ['#2f80ed', '#f2c94c', '#eb5757', '#27ae60', '#f2994a', '#9b51e0', '#56ccf2', '#e0e0e0',
		'#333333', '#00b3a4'];
	static KIND_COLOR = {net: '#2f80ed', fiber: '#00b3a4', power: '#333333'};

	static W = 1200;
	static UH = 111;

	constructor(scene) {
		this.scene = scene;
		this.el = null;
		this.dev = null;
		this.detail = null;
		this.tab = 'ports';
		this.port = null;
		this.connect = null;
		this.photo = true;
		this.busy = false;
	}

	t(...args) {
		return this.scene.t(...args);
	}

	get data() {
		return this.scene.data;
	}

	get api() {
		return this.scene.data.devapi || {};
	}

	// ================================================================ perfil de hardware

	/** Clave del modelo: fabricante|modelo del inventario; sin modelo, el propio equipo. */
	static mkey(d) {
		const inv = d.inv || {};
		const model = `${(inv.vendor || '').trim()}|${(inv.model || '').trim()}`.toLowerCase();

		return model !== '|' && (inv.model || '').trim() !== '' ? model : `h:${d.key || d.id}`;
	}

	static parseProfile(text) {
		const out = {F: {}, R: {}};

		for (const face of String(text || '').split(';')) {
			const m = face.trim().match(/^([FR]):(.*)$/);

			if (!m) {
				continue;
			}

			for (const part of m[2].split(',')) {
				const p = part.trim().match(/^([a-z0-9]+)=(\d+)$/);

				if (p && LakaInfra3DDevView.PARTS[p[1]]) {
					out[m[1]][p[1]] = Math.min(96, parseInt(p[2], 10));
				}
			}
		}

		return out;
	}

	static serialize(profile) {
		return ['F', 'R'].map((f) => `${f}:${Object.entries(profile[f] || {}).filter(([, v]) => v > 0).map(([k, v]) => `${k}=${v}`).join(',')}`).join(';');
	}

	/** Cantidad de puertos que sugiere el modelo (por ejemplo "1930-48G" → 48). */
	static portsFromModel(text, fallback) {
		const m = String(text || '').match(/(?:^|[^0-9])(8|10|12|16|24|26|28|48|52)(?:[^0-9]|$)/);

		if (!m) {
			return fallback;
		}

		const n = parseInt(m[1], 10);

		return n === 52 ? 48 : (n === 26 || n === 28 ? 24 : (n === 10 ? 8 : n));
	}

	/** Perfil típico según el papel del equipo y su altura en U. */
	static defaults(role, d) {
		const n = d.n || 1;
		const inv = d.inv || {};
		const txt = `${inv.model || ''} ${d.name}`;

		switch (role) {
			case 'switch':
			case 'access':
				return {F: {console: 1, rj45: LakaInfra3DDevView.portsFromModel(txt, 24), sfp: 4}, R: {psu: 1, fan: 1}};

			case 'core':
				return {F: {console: 1, mgmt: 1, sfp: LakaInfra3DDevView.portsFromModel(txt, 24)}, R: {psu: 2, fan: 4}};

			case 'firewall':
				return {F: {console: 1, mgmt: 1, usb: 1, rj45: 16, sfp: 4}, R: {psu: 2}};

			case 'router':
				return {F: {console: 1, usb: 1, rj45: 4, sfp: 4}, R: {psu: 2}};

			case 'wifi':
				return {F: {console: 1, rj45: 8}, R: {psu: 1}};

			case 'server':
				return {F: {disk: n === 1 ? 8 : Math.min(24, n * 6), usb: 1, vga: 1}, R: {mgmt: 1, usb: 2, vga: 1, rj45: 4, psu: 2}};

			case 'storage':
				return {F: {disk: Math.min(48, n * 12)}, R: {mgmt: 2, rj45: 2, sfp: 4, psu: 2}};

			case 'ups':
				return {F: {}, R: {mgmt: 1, outlet: 8, psu: 1}};

			case 'pdu':
				return {F: {outlet: 8 * n}, R: {psu: 1}};

			case 'patch':
				return {F: {pp: 24 * n}, R: {pp: 24 * n}};

			case 'cable':
			case 'blank':
				return {F: {}, R: {}};

			default:
				return {F: {rj45: 2}, R: {psu: 1}};
		}
	}

	/**
	 * Tipo de puerto de una interfaz de Zabbix por su nombre: SFP (10G/25G/40G/100G, "sfp", "xe"), gestión,
	 * RJ45; null para las virtuales (VLAN, loopback, port-channel, túneles, Wi-Fi, adaptadores virtuales).
	 */
	static ifaceKind(iface) {
		const n = `${iface.name || ''}`.trim();
		const l = n.toLowerCase();

		if (l === '' || /^(vlan|vl\d|lo\b|lo\d|loopback|null|tunnel|tu\d|po\d|port-channel|bond|br-|bridge|virbr|veth|docker|ssl\.|npu|fortilink|vif|isatap|teredo|6to4|pseudo|stack|cpu|nve|vxlan|ppp|l2tp|gre)/.test(l)
				|| /virtual|hyper-v|vmware|miniport|loopback|bluetooth|wi-?fi|wireless|802\.11|tap-|tun|vpn|kernel debug|qos|wfp|filter/.test(l)) {
			return null;
		}

		if (/^(mgmt|management|me\d|ma\d|oob|ipmi|idrac|ilo|bmc)/.test(l)) {
			return 'mgmt';
		}

		if (/^(te|tengig|tw|twentyfive|fo|forty|hu|hundred|xe-|et-|sfp|x\d|xg|xl|qsfp)/.test(l) || /sfp|10g|25g|40g|100g/.test(l)
				|| (iface.speed && iface.speed >= 10e9)) {
			return 'sfp';
		}

		return 'rj45';
	}

	/** Perfil del equipo y de dónde sale (guardado, Zabbix o típico). */
	profileFor(d, detail) {
		return LakaInfra3DDevView.profileOf(d, this.data, detail);
	}

	/**
	 * Perfil de un equipo sin instancia (también lo usa el editor de sala). En un patch panel la cantidad de
	 * puertos sale de su configuración (12, 24, 48…), igual en el frente y en la parte trasera.
	 */
	static profileOf(d, data, detail = null) {
		const role = LakaInfra3DRackView.role(d);
		const saved = ((data && data.models) || {})[LakaInfra3DDevView.mkey(d)];

		if (role === 'patch' && typeof LakaInfra3DCabling === 'function') {
			const panel = LakaInfra3DCabling.panel(data && data.cabling, d.key || d.id, d.n);

			return {profile: {F: {pp: panel.ports}, R: {pp: panel.ports}}, source: panel.saved ? 'panel' : 'default', role,
				saved: saved || null, panel};
		}

		if (saved && saved.p) {
			return {profile: LakaInfra3DDevView.parseProfile(saved.p), source: 'saved', role, saved};
		}

		const profile = LakaInfra3DDevView.defaults(role, d);
		let source = 'default';

		if (detail) {
			// Lo descubierto por las plantillas de Zabbix manda sobre lo típico.
			const counts = {rj45: 0, sfp: 0, mgmt: 0};

			for (const iface of detail.ifaces || []) {
				const k = LakaInfra3DDevView.ifaceKind(iface);

				if (k) {
					counts[k]++;
				}
			}

			// En servidores las placas de red están atrás; en equipos de red, adelante.
			const netFace = ['server', 'storage', 'ups', 'other'].includes(role) ? 'R' : 'F';

			for (const k of ['rj45', 'sfp']) {
				if (counts[k] > 0) {
					profile[netFace][k] = Math.min(96, counts[k]);
					source = 'zabbix';
				}
			}

			if (counts.mgmt > 0) {
				profile[netFace].mgmt = Math.min(4, counts.mgmt);
			}

			if ((detail.psus || []).length) {
				profile.R.psu = Math.min(8, detail.psus.length);
				source = 'zabbix';
			}

			if ((detail.fans || []).length && role !== 'server') {
				profile.R.fan = Math.min(12, detail.fans.length);
			}
		}

		return {profile, source, role, saved: saved || null};
	}

	/** Lista de puertos de una cara a partir del perfil. */
	static ports(profile, face) {
		const out = [];

		for (const [kind, count] of Object.entries(profile[face] || {})) {
			for (let i = 1; i <= count; i++) {
				out.push({id: `${face}-${kind}-${i}`, face, kind, n: i});
			}
		}

		return out;
	}

	/** Interfaces de Zabbix asignadas a los puertos, en orden natural de nombre (Gi1/0/1, Gi1/0/2…). */
	static mapIfaces(profile, detail) {
		const map = new Map();

		if (!detail) {
			return map;
		}

		const byKind = {rj45: [], sfp: [], mgmt: []};
		const collator = new Intl.Collator(undefined, {numeric: true, sensitivity: 'base'});

		for (const iface of detail.ifaces || []) {
			const k = LakaInfra3DDevView.ifaceKind(iface);

			if (k) {
				byKind[k].push(iface);
			}
		}

		for (const k of Object.keys(byKind)) {
			byKind[k].sort((a, b) => collator.compare(a.name, b.name));

			const face = (profile.F[k] || 0) > 0 ? 'F' : 'R';

			byKind[k].forEach((iface, i) => {
				if (i < (profile[face][k] || 0)) {
					map.set(`${face}-${k}-${i + 1}`, iface);
				}
			});
		}

		(detail.psus || []).forEach((psu, i) => map.set(`R-psu-${i + 1}`, psu));
		(detail.fans || []).forEach((fan, i) => map.set(`R-fan-${i + 1}`, fan));

		return map;
	}

	// ================================================================ cableado

	cables() {
		const list = (this.data.cabling && this.data.cabling.list) || [];

		return list.map((s) => {
			const c = LakaInfra3DCabling.parseCable(s);

			c.c = c.c || LakaInfra3DDevView.KIND_COLOR[c.k] || '#2f80ed';

			return c;
		});
	}

	cableAt(ep) {
		return this.cables().find((c) => c.a === ep || c.b === ep) || null;
	}

	devByKey(key) {
		if (!this._keys || this._keysWorld !== this.scene.world) {
			this._keys = new Map(this.scene.world.devices.map((x) => [x.d.key || x.d.id, x]));
			this._keysWorld = this.scene.world;
		}

		return this._keys.get(key) || null;
	}

	rackByLower(name) {
		for (const [n, r] of this.scene.world.racks) {
			if (n.toLowerCase() === String(name).toLowerCase()) {
				return [n, r];
			}
		}

		return [name, null];
	}

	/** Partes de un extremo "equipo#F-rj45-5". */
	static split(ep) {
		const [key, port] = ep.split('#');
		const [face, kind, n] = (port || '').split('-');

		return {key, port, face, kind, n: parseInt(n, 10)};
	}

	static flip(ep) {
		const p = LakaInfra3DDevView.split(ep);

		return `${p.key}#${p.face === 'F' ? 'R' : 'F'}-${p.kind}-${p.n}`;
	}

	/** Datos para mostrar un extremo: equipo, rack, U, nombre del puerto e identificador TIA-606. */
	endpointInfo(ep) {
		const p = LakaInfra3DDevView.split(ep);
		const fs = ((this.data.cabling && this.data.cabling.fs) || '1A').toUpperCase();
		const pad = (v) => String(v).padStart(2, '0');
		const prefix = {rj45: '', pp: '', sfp: 'S', mgmt: 'M', console: 'C', psu: 'PS', outlet: 'O'}[p.kind] ?? p.kind.toUpperCase();
		const portId = `${prefix}${pad(p.n)}`;

		if (p.key.startsWith('o:')) {
			const id = p.key.slice(2);

			return {name: `${this.t('Toma')} ${id}`, rack: '', where: this.t('Área de trabajo / zona'), port: id, tia: id,
				dev: null, face: p.face, kind: p.kind, outlet: true};
		}

		if (p.key.startsWith('x:')) {
			// Elemento de la sala (cámara, control de acceso, sensor…): TIA-606 con la baldosa donde está.
			const id = p.key.slice(2);
			const o = (this.data.objects || []).find((x) => x.id === id);
			const entry = this.scene.world && this.scene.world.objectsById ? this.scene.world.objectsById.get(id) : null;
			const tile = entry ? this.scene.gridRef(entry.group.position.x, entry.group.position.z) : '';
			const name = o ? (o.name || LakaInfra3DScene.KIND_NAMES[o.kind]) : id;

			return {name, rack: '', where: tile ? `${this.t('Sala')} · ${this.t('Baldosa')} ${tile}` : this.t('Sala'),
				port: 'RJ45', tia: tile ? `${fs}.${tile}` : `${fs}.${id}`, dev: null, face: p.face, kind: p.kind, object: o || null};
		}

		if (p.key.startsWith('v:')) {
			const [, rackLower, letter] = p.key.split(':');
			const [rack] = this.rackByLower(rackLower);
			const xy = rack.toUpperCase().replace(/[^0-9A-Z]/g, '');

			return {name: `${this.t('PDU vertical')} ${letter}`, rack, where: rack, port: `${this.t('Toma')} ${p.n}`,
				tia: `${fs}.${xy}-PDU${letter}:${portId}`, dev: null, face: p.face, kind: p.kind};
		}

		const dev = this.devByKey(p.key);

		if (!dev) {
			return {name: p.key, rack: '?', where: '?', port: p.port, tia: '?', dev: null, face: p.face, kind: p.kind};
		}

		const d = dev.d;
		const top = d.u + d.n - 1;
		const xy = d.rack.toUpperCase().replace(/[^0-9A-Z]/g, '');
		let port = LakaInfra3DDevView.PARTS[p.kind] ? this.portName(p.kind, p.n) : p.port;

		// Nombre de la interfaz de Zabbix si es el equipo abierto.
		if (this.dev && this.dev.d === d && this.ifmap && this.ifmap.get(p.port) && this.ifmap.get(p.port).name) {
			port = this.ifmap.get(p.port).name;
		}

		return {name: d.name, rack: d.rack, where: `${d.rack} · U${top}`, port, tia: `${fs}.${xy}-${pad(top)}:${portId}`,
			dev, face: p.face, kind: p.kind};
	}

	/** Nombre corto de un componente: "Puerto 5" en paneles y RJ45 sin interfaz, "SFP 2", "Fuente 1"… */
	portName(kind, n) {
		const names = {pp: 'Puerto', rj45: 'RJ45', psu: 'Fuente', fan: 'Ventilador', outlet: 'Toma', disk: 'Disco'};

		return `${this.t(names[kind] || LakaInfra3DDevView.PARTS[kind].name)} ${n}`;
	}

	/** Resumen de un patch panel: "Cobre UTP Cat 6A · RJ45 · 24 puertos · Horizontal". */
	static panelText(p, t) {
		const m = LakaInfra3DCabling.MEDIA[p.media];
		const cat = m.fiber ? p.cat : `Cat ${p.cat}`;

		return `${t(m.name)} ${cat} · ${LakaInfra3DCabling.CONN_NAMES[p.conn]} · ${p.ports} ${t('puertos')} · ${t(LakaInfra3DCabling.FUNCS[p.func])}`;
	}

	cableLabel(c) {
		return c.l !== '' ? c.l : `${this.endpointInfo(c.a).tia} / ${this.endpointInfo(c.b).tia}`;
	}

	/**
	 * Trazado de un puerto: sigue el cable y, al llegar a un patch panel, pasa al mismo puerto de la otra cara
	 * (frente ↔ atrás) y sigue con el cable siguiente, hasta llegar a un equipo o a un puerto sin cable.
	 */
	trace(ep) {
		const walk = (start) => {
			const out = [];
			let cur = start;

			for (let guard = 0; guard < 24; guard++) {
				const c = this.cableAt(cur);

				if (!c) {
					break;
				}

				const other = c.a === cur ? c.b : c.a;

				out.push({cable: c});

				if (LakaInfra3DDevView.split(other).kind === 'pp') {
					const pass = LakaInfra3DDevView.flip(other);

					out.push({eps: [other, pass]});
					cur = pass;
				}
				else {
					out.push({eps: [other]});
					break;
				}
			}

			return out;
		};

		if (LakaInfra3DDevView.split(ep).kind === 'pp') {
			const other = LakaInfra3DDevView.flip(ep);
			const left = walk(ep).reverse().map((x) => (x.eps ? {eps: x.eps.slice().reverse()} : x));

			return [...left, {eps: [ep, other], start: true}, ...walk(other)];
		}

		return [{eps: [ep], start: true}, ...walk(ep)];
	}

	// ================================================================ abrir y cerrar

	ensure() {
		if (this.el) {
			return;
		}

		this.el = document.createElement('div');
		this.el.className = 'laka3d-rv laka3d-dv';
		this.el.hidden = true;
		this.el.tabIndex = -1;
		this.el.setAttribute('role', 'dialog');
		this.el.setAttribute('aria-modal', 'true');
		this.scene.root.appendChild(this.el);

		this.el.addEventListener('click', (e) => this.click(e));
		this.el.addEventListener('change', (e) => this.change(e));
		this.el.addEventListener('input', (e) => {
			if (e.target.dataset.dv === 'c-label' && this.connect) {
				this.connect.l = e.target.value;
			}
		});
		this.el.addEventListener('keydown', (e) => {
			if (e.key === 'Escape') {
				e.stopPropagation();
				this.connect ? (this.connect = null, this.render()) : this.close();
			}
		});
	}

	open(dev) {
		const s = this.scene;

		if (!dev || (s.noc && s.noc.active)) {
			return;
		}

		if (s.rackView) {
			s.rackView.close();
		}

		this.ensure();

		const changed = !this.dev || this.dev.d.id !== dev.d.id;

		this.dev = dev;
		this.el.hidden = false;

		if (changed) {
			this.detail = null;
			this.port = null;
			this.connect = null;
			this.message = null;
			this.tab = 'ports';
			this.photo = true;
		}

		this.render();
		this.el.focus({preventScroll: true});
		this.load();
	}

	close() {
		if (!this.el || this.el.hidden) {
			return;
		}

		this.el.hidden = true;
		this.dev = null;
		this.connect = null;
	}

	get isOpen() {
		return !!(this.el && !this.el.hidden);
	}

	/** Datos nuevos del widget: vuelve a tomar el equipo (puede haber cambiado su estado) y su detalle. */
	refresh() {
		if (!this.isOpen) {
			return;
		}

		const dev = this.scene.world && this.scene.world.devicesById.get(this.dev.d.id);

		if (!dev) {
			this.close();

			return;
		}

		this.dev = dev;

		// Mientras se conecta un cable no se redibuja, para no perder lo elegido.
		if (!this.connect) {
			this.render();
		}

		this.load();
	}

	/** Pide a Zabbix las interfaces, fuentes, ventiladores y salud del host (los pasivos no tienen). */
	async load() {
		const d = this.dev.d;

		if (d.passive || !this.api.detail_url) {
			return;
		}

		const id = d.id;

		try {
			const response = await fetch(this.api.detail_url, {
				method: 'POST',
				headers: {'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'},
				body: new URLSearchParams({hostid: id}).toString()
			});
			const json = await response.json();

			if (!this.isOpen || this.dev.d.id !== id || json.error) {
				return;
			}

			this.detail = json;

			if (!this.connect) {
				this.render();
			}
		}
		catch (error) {
			console.error(error);
		}
	}

	async post(url, csrf, params) {
		const body = new URLSearchParams(Object.assign({lang: this.data.lang || 'es', _csrf_token: csrf}, params));
		const response = await fetch(url, {
			method: 'POST',
			headers: {'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'},
			body: body.toString()
		});

		return response.json();
	}

	// ================================================================ eventos

	click(e) {
		const btn = e.target.closest('[data-dv]');
		const portEl = e.target.closest('[data-port]');
		const devEl = e.target.closest('[data-goto]');

		if (devEl) {
			const dev = this.devByKey(devEl.dataset.goto);

			if (dev && dev !== this.dev) {
				this.scene.selectDevice(dev, {broadcast: false});
				this.open(dev);
			}

			return;
		}

		if (portEl && !btn) {
			this.port = portEl.dataset.port;
			this.connect = null;
			this.render();

			const trace = this.el.querySelector('.laka3d-dv-trace');

			if (trace) {
				trace.scrollIntoView({block: 'nearest'});
			}

			return;
		}

		if (!btn) {
			return;
		}

		const a = btn.dataset.dv;
		const s = this.scene;

		switch (a) {
			case 'close':
				this.close();
				break;

			case 'rack': {
				const name = this.dev.d.rack;

				this.close();

				if (s.rackView) {
					s.openRack(name, true, true);
				}

				break;
			}

			case 'tab':
				this.tab = btn.dataset.tab;
				this.render();
				break;

			case 'photo':
				this.photo = btn.dataset.on === '1';
				this.render();
				break;

			case 'connect':
				this.startConnect(btn.dataset.ep);
				break;

			case 'c-cancel':
				this.connect = null;
				this.render();
				break;

			case 'c-save':
				this.saveCable();
				break;

			case 'unplug':
				this.removeCable(btn.dataset.ep);
				break;

			case 'fs-save':
				this.saveFs();
				break;

			case 'prof-save':
				this.saveProfile(false);
				break;

			case 'prof-reset':
				this.saveProfile(true);
				break;

			case 'img-save':
				this.saveImage(btn.dataset.side);
				break;

			case 'img-clear':
				this.saveImage(btn.dataset.side, true);
				break;
		}
	}

	change(e) {
		const f = e.target.dataset.dv;
		const c = this.connect;

		if (c && f === 'c-rack') {
			c.rack = e.target.value;
			c.dev = '';
			c.port = '';
			this.render();
		}
		else if (c && f === 'c-dev') {
			c.dev = e.target.value;
			c.port = '';
			this.render();
		}
		else if (c && f === 'c-port') {
			c.port = e.target.value;
		}
		else if (c && f === 'c-kind') {
			c.k = e.target.value;
			c.c = LakaInfra3DDevView.KIND_COLOR[c.k];
			this.render();
		}
		else if (c && f === 'c-color') {
			c.c = e.target.value;
		}
		else if (f === 'img-file') {
			this.readImage(e.target.dataset.side, e.target.files && e.target.files[0]);
		}
	}

	// ================================================================ conectar cables

	startConnect(ep) {
		const p = LakaInfra3DDevView.split(ep);
		const kind = LakaInfra3DDevView.PARTS[p.kind].cable;
		const existing = this.cableAt(ep);

		this.port = ep;
		this.connect = {
			ep,
			rack: this.dev.d.rack,
			dev: '',
			port: '',
			k: existing ? existing.k : kind,
			c: existing ? existing.c : LakaInfra3DDevView.KIND_COLOR[kind],
			l: existing ? existing.l : ''
		};
		this.render();
	}

	/** Puertos libres de un destino compatibles con el tipo de cable. */
	targetPorts(key, kind) {
		const power = kind === 'power';
		let ports;

		if (key.startsWith('v:')) {
			const [, rackLower] = key.split(':');
			const [, rack] = this.rackByLower(rackLower);
			const outlets = rack ? (rack.def.outlets || 24) : 24;

			ports = Array.from({length: outlets}, (_, i) => ({id: `R-outlet-${i + 1}`, face: 'R', kind: 'outlet', n: i + 1}));
		}
		else {
			const dev = this.devByKey(key);

			if (!dev) {
				return [];
			}

			const {profile} = this.profileFor(dev.d, dev === this.dev ? this.detail : null);

			ports = [...LakaInfra3DDevView.ports(profile, 'F'), ...LakaInfra3DDevView.ports(profile, 'R')];
		}

		return ports.filter((p) => {
			const c = LakaInfra3DDevView.PARTS[p.kind].cable;

			return c !== null && (power ? c === 'power' : c !== 'power');
		}).map((p) => ({...p, ep: `${key}#${p.id}`, used: !!this.cableAt(`${key}#${p.id}`)}));
	}

	async saveCable() {
		const c = this.connect;

		if (!c || !c.dev || !c.port) {
			this.message = {kind: 'error', text: this.t('Elige el equipo y el puerto de destino.')};
			this.render();

			return;
		}

		await this.cableOp({op: 'set', a: c.ep, b: `${c.dev}#${c.port}`, k: c.k, l: c.l || '', c: c.c || ''});
	}

	async removeCable(ep) {
		if (!window.confirm(this.t('¿Quitar el cable de este puerto?'))) {
			return;
		}

		await this.cableOp({op: 'del', a: ep});
	}

	async saveFs() {
		const input = this.el.querySelector('[data-dv="fs"]');

		await this.cableOp({op: 'fs', fs: input ? input.value : ''});
	}

	async cableOp(params) {
		if (this.busy) {
			return;
		}

		this.busy = true;

		try {
			const json = await this.post(this.api.cable_url, this.api.cable_csrf, Object.assign({room_key: this.api.room_key}, params));

			if (json.success) {
				this.data.cabling = json.cabling;
				LakaInfra3DCabling.applyRoles(json.cabling);
				this.connect = null;
				this.message = {kind: 'ok', text: json.message};
			}
			else {
				this.message = {kind: 'error', text: ((json.error && json.error.messages) || [this.t('No se pudo guardar.')]).join(' ')};
			}
		}
		catch (error) {
			this.message = {kind: 'error', text: this.t('No se pudo guardar.')};
		}

		this.busy = false;
		this.render();
	}

	// ================================================================ perfil y fotos

	async saveProfile(reset) {
		const d = this.dev.d;
		let profile = '';

		if (!reset) {
			const p = {F: {}, R: {}};

			this.el.querySelectorAll('[data-dv="prof"]').forEach((input) => {
				const v = Math.max(0, Math.min(96, parseInt(input.value, 10) || 0));

				if (v > 0) {
					p[input.dataset.face][input.dataset.part] = v;
				}
			});

			profile = LakaInfra3DDevView.serialize(p);
		}

		await this.modelOp({profile});
	}

	/** Ajusta la foto al tamaño definido (1200 px × 111 px por U) recortando al centro, como "cubrir". */
	readImage(side, file) {
		if (!file) {
			return;
		}

		const reader = new FileReader();

		reader.onload = () => {
			const img = new Image();

			img.onload = () => {
				const W = LakaInfra3DDevView.W;
				const H = LakaInfra3DDevView.UH * (this.dev.d.n || 1);
				const canvas = document.createElement('canvas');

				canvas.width = W;
				canvas.height = H;

				const g = canvas.getContext('2d');
				const scale = Math.max(W / img.width, H / img.height);
				const w = img.width * scale;
				const h = img.height * scale;

				g.fillStyle = '#000000';
				g.fillRect(0, 0, W, H);
				g.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);

				let quality = 0.88;
				let url = canvas.toDataURL('image/jpeg', quality);

				while (url.length > 1300000 && quality > 0.4) {
					quality -= 0.1;
					url = canvas.toDataURL('image/jpeg', quality);
				}

				this.pending = Object.assign(this.pending || {}, {[side]: url});
				this.render();
			};
			img.src = reader.result;
		};
		reader.readAsDataURL(file);
	}

	async saveImage(side, clear = false) {
		const params = {};

		if (clear) {
			if (!window.confirm(this.t('¿Quitar la foto?'))) {
				return;
			}

			params[`clear_${side}`] = '1';
		}
		else {
			const url = this.pending && this.pending[side];

			if (!url) {
				return;
			}

			params[side] = url.slice(url.indexOf(',') + 1);
		}

		await this.modelOp(params);

		if (!clear && this.pending && this.message && this.message.kind === 'ok') {
			delete this.pending[side];
			this.render();
		}
	}

	async modelOp(params) {
		if (this.busy) {
			return;
		}

		const d = this.dev.d;
		const mkey = LakaInfra3DDevView.mkey(d);
		const inv = d.inv || {};

		this.busy = true;

		try {
			const json = await this.post(this.api.model_url, this.api.model_csrf, Object.assign({
				mkey, n: d.n || 1, name: (inv.model || d.name).slice(0, 40)
			}, params));

			if (json.success) {
				this.data.models = this.data.models || {};

				if (json.model) {
					this.data.models[mkey] = json.model;
				}
				else {
					delete this.data.models[mkey];
				}

				this.message = {kind: 'ok', text: json.message};
			}
			else {
				this.message = {kind: 'error', text: ((json.error && json.error.messages) || [this.t('No se pudo guardar.')]).join(' ')};
			}
		}
		catch (error) {
			this.message = {kind: 'error', text: this.t('No se pudo guardar.')};
		}

		this.busy = false;
		this.render();
	}

	// ================================================================ dibujo

	render() {
		const s = this.scene;
		const esc = LakaInfra3DScene.esc;
		const t = this.t.bind(this);
		const d = this.dev.d;
		const prof = this.profileFor(d, this.detail);
		const role = prof.role;
		const rv = s.rackView || new LakaInfra3DRackView(s);
		const st = rv.status(d);
		const inv = d.inv || {};
		const model = [inv.vendor, inv.model].filter((v) => v && v.trim() !== '').join(' ');
		const top = d.u + d.n - 1;

		this.ifmap = LakaInfra3DDevView.mapIfaces(prof.profile, this.detail);
		this.fiberPanel = !!(prof.panel && LakaInfra3DCabling.MEDIA[prof.panel.media].fiber);

		const portsF = LakaInfra3DDevView.ports(prof.profile, 'F');
		const portsR = LakaInfra3DDevView.ports(prof.profile, 'R');
		const all = [...portsF, ...portsR];
		const key = d.key || d.id;
		const netPorts = all.filter((p) => ['rj45', 'sfp', 'mgmt', 'pp'].includes(p.kind));
		const up = netPorts.filter((p) => (this.ifmap.get(p.id) || {}).status === 'ok').length;
		const mapped = netPorts.filter((p) => this.ifmap.has(p.id)).length;
		const cabled = all.filter((p) => this.cableAt(`${key}#${p.id}`)).length;
		const psus = all.filter((p) => p.kind === 'psu');
		const psuOk = psus.filter((p) => (this.ifmap.get(p.id) || {}).status === 'ok').length;
		const det = this.detail || {};

		const kpi = (label, value) => `<div class="laka3d-rv-kpi"><span>${esc(t(label))}</span><strong>${value}</strong></div>`;
		const kpis = [
			mapped ? kpi('Puertos activos', `${up}/${mapped}`) : '',
			netPorts.length ? kpi('Puertos', String(netPorts.length)) : '',
			kpi('Con cable', String(cabled)),
			psus.length ? kpi('Fuentes', det.psus && det.psus.length ? `${psuOk}/${psus.length} OK` : String(psus.length)) : '',
			d.temp !== null && d.temp !== undefined ? kpi('Temperatura', `${d.temp} °C`) : '',
			det.cpu !== null && det.cpu !== undefined ? kpi('CPU', `${det.cpu} %`) : '',
			det.mem !== null && det.mem !== undefined ? kpi('Memoria RAM', `${det.mem} %`) : ''
		].join('');

		const sourceText = {saved: 'Perfil guardado para el modelo', zabbix: 'Puertos y fuentes descubiertos en Zabbix',
			default: 'Perfil típico del tipo de equipo', panel: 'Patch panel configurado en el editor de sala'}[prof.source];

		const tabs = [['ports', 'Puertos y cableado'], ['power', 'Energía']];

		if (!d.passive && (role === 'server' || role === 'storage' || det.fs && det.fs.length || det.cpu !== null && det.cpu !== undefined)) {
			tabs.push(['health', 'Salud']);
		}

		if (!d.passive) {
			tabs.push(['inv', 'Inventario']);
		}

		if (this.api.can_edit) {
			tabs.push(['profile', 'Perfil y fotos']);
		}

		if (!tabs.some(([id]) => id === this.tab)) {
			this.tab = 'ports';
		}

		const saved = prof.saved || {};
		const hasPhoto = !!(saved.f || saved.b);
		const links = d.passive ? '' : `
			<a class="laka3d-btn" href="${esc(s.data.links.problems + encodeURIComponent(d.id))}" target="_blank" rel="noopener">${esc(t('Problemas'))}</a>
			<a class="laka3d-btn" href="${esc(s.data.links.latest + encodeURIComponent(d.id))}" target="_blank" rel="noopener">${esc(t('Últimos datos'))}</a>`;

		const scroll = this.el.querySelector('.laka3d-rv-body');
		const scrollTop = scroll ? scroll.scrollTop : 0;

		this.el.setAttribute('aria-label', d.name);
		this.el.innerHTML = `
			<div class="laka3d-rv-head">
				<div class="laka3d-rv-title">
					<span class="laka3d-dot" style="background:${esc(st.color)}"></span>
					<div>
						<strong>${esc(d.name)}</strong>
						<span class="laka3d-muted">${esc(rv.roleName(role))}${prof.panel ? ' · ' + esc(LakaInfra3DDevView.panelText(prof.panel, t)) : ''}${model ? ' · ' + esc(model) : ''} · ${esc(t('Rack'))} ${esc(d.rack)} · U${top}${d.n > 1 ? '–' + d.u : ''} · ${d.n}U${d.face === 'back' ? ' · ' + esc(t('atrás')) : ''}</span>
					</div>
					<span class="laka3d-rv-chip ${st.cls}" style="--chip:${esc(st.color)}">${esc(st.text)}</span>
				</div>
				<div class="laka3d-rv-kpis">${kpis}</div>
				<div class="laka3d-rv-actions">
					${links}
					<button type="button" class="laka3d-btn" data-dv="rack">‹ ${esc(t('Rack'))} ${esc(d.rack)}</button>
					<button type="button" class="laka3d-btn" data-dv="close">${esc(t('Volver a la sala'))}</button>
				</div>
			</div>
			${this.message ? `<div class="laka3d-ed-msg laka3d-ed-msg-${esc(this.message.kind)}" role="status">${esc(this.message.text)}</div>` : ''}
			<div class="laka3d-rv-body laka3d-dv-body">
				<div class="laka3d-dv-faces">
					<div class="laka3d-dv-facebar">
						<span class="laka3d-muted">${esc(t(sourceText))}${!d.passive && !this.detail ? ' · ' + esc(t('Cargando datos de Zabbix…')) : ''}</span>
						${hasPhoto ? `<div class="laka3d-seg laka3d-seg-sm" role="group">
							<button type="button" data-dv="photo" data-on="1" aria-pressed="${this.photo}">${esc(t('Foto'))}</button>
							<button type="button" data-dv="photo" data-on="0" aria-pressed="${!this.photo}">${esc(t('Esquema'))}</button>
						</div>` : ''}
					</div>
					${this.faceHtml('F', portsF, prof, saved.f)}
					${this.faceHtml('R', portsR, prof, saved.b)}
					${this.legendHtml()}
				</div>
				${this.port ? this.traceHtml(this.port) : ''}
				<div class="laka3d-dv-tabs" role="tablist">
					${tabs.map(([id, label]) => `<button type="button" role="tab" data-dv="tab" data-tab="${id}" aria-selected="${this.tab === id}">${esc(t(label))}</button>`).join('')}
				</div>
				<div class="laka3d-dv-tab">${this.tabHtml(prof, all)}</div>
			</div>
			<div class="laka3d-rv-foot">© LAKA Soluciones Tecnológicas</div>`;

		const again = this.el.querySelector('.laka3d-rv-body');

		if (again) {
			again.scrollTop = scrollTop;
		}
	}

	legendHtml() {
		const esc = LakaInfra3DScene.esc;
		const t = this.t.bind(this);

		return `<div class="laka3d-dv-legend">
			<span><i class="is-ok"></i>${esc(t('Activo'))}</span>
			<span><i class="is-bad"></i>${esc(t('Caído o con falla'))}</span>
			<span><i class="is-unk"></i>${esc(t('Sin datos'))}</span>
			<span><i class="is-cable"></i>${esc(t('Con cable'))}</span>
			<span class="laka3d-muted">${esc(t('Haz clic en un puerto para ver su trazado.'))}</span>
		</div>`;
	}

	/** Una cara del equipo: foto (si hay y está elegida) o esquema con cada componente. */
	faceHtml(face, ports, prof, imageid) {
		const esc = LakaInfra3DScene.esc;
		const t = this.t.bind(this);
		const d = this.dev.d;
		const n = d.n || 1;
		const W = LakaInfra3DDevView.W;
		const H = LakaInfra3DDevView.UH * n;
		const title = face === 'F' ? t('Frente') : t('Atrás');
		const counts = Object.entries(prof.profile[face] || {}).filter(([, v]) => v > 0)
			.map(([k, v]) => `${v} ${t(LakaInfra3DDevView.PARTS[k].name)}`).join(' · ');

		if (imageid && this.photo) {
			return `
				<figure class="laka3d-dv-face">
					<figcaption><strong>${esc(title.toUpperCase())}</strong><span class="laka3d-muted">${esc(counts || t('Sin componentes'))}</span></figcaption>
					<img src="${esc(this.api.img_url + encodeURIComponent(imageid))}" alt="${esc(title)}" width="${W}" height="${H}" loading="lazy">
				</figure>`;
		}

		return `
			<figure class="laka3d-dv-face">
				<figcaption><strong>${esc(title.toUpperCase())}</strong><span class="laka3d-muted">${esc(counts || t('Sin componentes'))}</span></figcaption>
				<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${esc(title)}">
					${this.faceSvg(face, ports, prof.role, n)}
				</svg>
			</figure>`;
	}

	/**
	 * Esquema de una cara en coordenadas de 1200 × 111 por U (las mismas de la foto): orejas, chasis y
	 * los componentes en grupos de izquierda a derecha, con filas según la altura del equipo.
	 */
	faceSvg(face, ports, role, n) {
		const esc = LakaInfra3DScene.esc;
		const W = LakaInfra3DDevView.W;
		const H = LakaInfra3DDevView.UH * n;
		const d = this.dev.d;
		const key = d.key || d.id;
		const ear = 48;
		const light = role === 'firewall';
		let svg = `<rect class="dv-ear" x="0" y="0" width="${W}" height="${H}" rx="8"/>`
			+ `<rect class="${light ? 'dv-body-light' : (['patch', 'cable', 'blank'].includes(role) ? 'dv-body-black' : 'dv-body')}" x="${ear}" y="2" width="${W - ear * 2}" height="${H - 4}" rx="3"/>`;

		for (let i = 0; i < n; i++) {
			const y = i * LakaInfra3DDevView.UH + LakaInfra3DDevView.UH / 2;

			svg += `<ellipse class="dv-screw" cx="${ear / 2}" cy="${y}" rx="9" ry="6"/><ellipse class="dv-screw" cx="${W - ear / 2}" cy="${y}" rx="9" ry="6"/>`;
		}

		// Marca y modelo en el frente; en la UPS, la pantalla.
		const inv = d.inv || {};

		const brand = face === 'F' && !['patch', 'cable', 'blank'].includes(role)
			? (((inv.vendor || '') + ' ' + (inv.model || '')).trim() || d.name) : '';

		const order = face === 'F'
			? ['console', 'mgmt', 'usb', 'vga', 'rj45', 'pp', 'sfp', 'disk', 'outlet', 'psu', 'fan']
			: ['mgmt', 'console', 'usb', 'vga', 'rj45', 'sfp', 'pp', 'outlet', 'disk', 'fan', 'psu'];
		const SZ = {
			rj45: {w: 40, h: 32, pitch: 46, max: 2 * n, group: 6},
			sfp: {w: 46, h: 24, pitch: 54, max: 2 * n, group: 4},
			pp: {w: 36, h: 32, pitch: 41, max: n, group: 6},
			console: {w: 40, h: 32, pitch: 56, max: 1},
			mgmt: {w: 40, h: 32, pitch: 56, max: 2 * n},
			usb: {w: 30, h: 14, pitch: 40, max: 2},
			vga: {w: 64, h: 26, pitch: 78, max: 1},
			disk: {w: 128, h: 0, pitch: 134, max: n === 1 ? 1 : Math.min(4, n * 2)},
			psu: {w: 180, h: 0, pitch: 192, max: Math.max(1, n)},
			fan: {w: 74, h: 74, pitch: 86, max: Math.max(1, n)},
			outlet: {w: 38, h: 48, pitch: 46, max: 2 * n, group: 8}
		};
		const groups = [];

		for (const kind of order) {
			const list = ports.filter((p) => p.kind === kind);

			if (!list.length) {
				continue;
			}

			const sz = SZ[kind];
			let rows = 1;

			if (kind === 'pp') {
				rows = Math.min(sz.max, Math.ceil(list.length / 24));
			}
			else if ((kind === 'rj45' && list.length > 12) || (kind === 'sfp' && list.length > 8) || (kind === 'outlet' && list.length > 12)) {
				rows = Math.min(sz.max, 2);
			}
			else if (kind === 'disk') {
				// 1U: una fila; 2U con 12 discos de 3,5": 3 filas de 4, como en los servidores reales.
				rows = n === 1 ? 1 : Math.max(1, Math.min(sz.max, Math.round(Math.sqrt(list.length / 1.4))));
			}

			groups.push({kind, list, sz, rows});
		}

		const avail = W - ear * 2 - 40 - (face === 'F' ? 0 : 0);
		const widthOf = (g) => {
			const cols = Math.ceil(g.list.length / g.rows);
			const gaps = g.sz.group ? Math.floor((cols - 1) / g.sz.group) * 14 : 0;

			return cols * g.sz.pitch + gaps;
		};
		let total = () => groups.reduce((acc, g) => acc + widthOf(g), 0) + Math.max(0, groups.length - 1) * 28;

		// Si no entra, más filas para el grupo más ancho que pueda tenerlas.
		for (let guard = 0; guard < 20 && total() > avail; guard++) {
			const g = groups.filter((x) => x.rows < x.sz.max).sort((a, b) => widthOf(b) - widthOf(a))[0];

			if (!g) {
				break;
			}

			g.rows++;
		}

		const scale = Math.min(1, avail / Math.max(1, total()));
		let x = ear + 20 + (avail - total() * scale) / 2;

		// Marca y modelo arriba a la izquierda, solo si hay lugar antes del primer grupo de puertos.
		if (brand !== '') {
			const fit = Math.floor((x - ear - 24) / 9);

			if (fit >= 8 || !groups.length) {
				svg += `<text class="dv-brand${light ? ' is-light' : ''}" x="${ear + 14}" y="${Math.min(26, H / 2)}">${esc(brand.length > fit && groups.length ? brand.slice(0, fit - 1) + '…' : brand)}</text>`;
			}
		}

		for (const g of groups) {
			const cols = Math.ceil(g.list.length / g.rows);
			const pitch = g.sz.pitch * scale;
			const labeled = ['rj45', 'sfp', 'pp', 'outlet'].includes(g.kind);
			// Números arriba de la primera fila y abajo de la última.
			const labelSpace = labeled ? (g.rows > 1 ? 26 : 14) : (['console', 'mgmt'].includes(g.kind) ? 14 : 0);
			const usableH = H - 10 - labelSpace;
			const gapY = 6;
			let ph = Math.min(g.sz.h || 999, usableH / g.rows - gapY);

			if (g.kind === 'disk') {
				ph = usableH / g.rows - gapY;
			}
			else if (g.kind === 'psu') {
				ph = Math.min(88, usableH / g.rows - gapY);
			}
			else if (g.kind === 'fan') {
				ph = Math.min(g.sz.w * scale, usableH / g.rows - gapY);
			}

			const rowH = ph + gapY;
			const blockH = rowH * g.rows - gapY;
			const y0 = 5 + (labeled || ['console', 'mgmt'].includes(g.kind) ? 13 : 0) + (usableH - blockH) / 2;

			g.list.forEach((p, i) => {
				// Switches: 1 arriba, 2 abajo; paneles, discos y tomas: de izquierda a derecha por fila.
				const byCol = ['rj45', 'sfp', 'mgmt'].includes(g.kind);
				const col = byCol ? Math.floor(i / g.rows) : i % cols;
				const row = byCol ? i % g.rows : Math.floor(i / cols);
				const gap = g.sz.group ? Math.floor(col / g.sz.group) * 14 * scale : 0;
				const px = x + col * pitch + gap;
				const py = y0 + row * rowH;
				const pw = g.kind === 'fan' ? ph : g.sz.w * scale;

				svg += this.portSvg(p, `${key}#${p.id}`, px, py, Math.max(6, pw), ph, row, g.rows, cols);
			});

			x += widthOf(g) * scale + 28 * scale;
		}

		if (!groups.length) {
			svg += `<text class="dv-empty" x="${W / 2}" y="${H / 2}">${esc(this.t('Sin componentes'))}</text>`;
		}

		return svg;
	}

	/** Un componente: forma según el tipo, LED de estado de Zabbix, marca de cable y número. */
	portSvg(p, ep, x, y, w, h, row, rows) {
		const esc = LakaInfra3DScene.esc;
		const iface = this.ifmap.get(p.id);
		const status = iface ? iface.status : '';
		const cable = LakaInfra3DDevView.PARTS[p.kind].cable ? this.cableAt(ep) : null;
		const sel = this.port === ep ? ' is-sel' : '';
		const pst = LakaInfra3DCabling.portState(this.data.cabling, ep).st;
		const cls = `dv-port dv-${p.kind}${status ? ' st-' + status : ''}${pst ? ' pst-' + pst : ''}${cable ? ' has-cable' : ''}${sel}${p.kind === 'pp' && this.fiberPanel ? ' is-fiber' : ''}`;
		const title = `${this.t(LakaInfra3DDevView.PARTS[p.kind].name)} ${p.n}${iface && iface.name ? ' · ' + iface.name : ''}${iface && iface.label ? ' · ' + iface.label : ''}${cable ? ' · ' + this.cableLabel(cable) : ''}`;
		const f = (v) => v.toFixed(1);
		let shape = '';
		const num = ['rj45', 'pp', 'sfp', 'outlet'].includes(p.kind);
		// Número arriba en la fila de arriba y abajo en la de abajo, como en los equipos reales.
		const numY = row === rows - 1 && rows > 1 ? y + h + 12 : y - 3;

		switch (p.kind) {
			case 'pp':
				if (this.fiberPanel) {
					// Adaptador de fibra (LC/SC dúplex): dos conectores lado a lado.
					shape = `<rect class="dv-cage" x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" rx="2"/>`
						+ `<rect class="dv-lc" x="${f(x + w * 0.12)}" y="${f(y + h * 0.25)}" width="${f(w * 0.32)}" height="${f(h * 0.5)}" rx="1"/>`
						+ `<rect class="dv-lc" x="${f(x + w * 0.56)}" y="${f(y + h * 0.25)}" width="${f(w * 0.32)}" height="${f(h * 0.5)}" rx="1"/>`;
					break;
				}
			// falls through
			case 'rj45':
			case 'mgmt':
			case 'console':
				shape = `<rect class="dv-jack" x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" rx="2"/>`
					+ `<rect class="dv-jack-in" x="${f(x + w * 0.18)}" y="${f(y + h * 0.3)}" width="${f(w * 0.64)}" height="${f(h * 0.55)}"/>`
					+ `<rect class="dv-jack-tab" x="${f(x + w * 0.36)}" y="${f(y + h * 0.18)}" width="${f(w * 0.28)}" height="${f(h * 0.14)}"/>`
					+ (p.kind !== 'pp' ? `<rect class="dv-led" x="${f(x + 2)}" y="${f(y + 2)}" width="${f(w * 0.2)}" height="${f(h * 0.14)}"/>` : '');

				if (p.kind === 'console' || p.kind === 'mgmt') {
					shape += `<text class="dv-tag" x="${f(x + w / 2)}" y="${f(y - 3)}">${p.kind === 'console' ? 'CON' : 'MGMT'}${p.kind === 'mgmt' && p.n > 1 ? ' ' + p.n : ''}</text>`;
				}

				break;

			case 'sfp':
				shape = `<rect class="dv-cage" x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" rx="1.5"/>`
					+ `<rect class="dv-cage-in" x="${f(x + 4)}" y="${f(y + h * 0.3)}" width="${f(w - 8)}" height="${f(h * 0.4)}"/>`
					+ `<rect class="dv-led" x="${f(x + 2)}" y="${f(y + 2)}" width="${f(w * 0.18)}" height="${f(h * 0.16)}"/>`;
				break;

			case 'usb':
				shape = `<rect class="dv-cage" x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" rx="1"/><rect class="dv-usb-in" x="${f(x + 3)}" y="${f(y + 3)}" width="${f(w - 6)}" height="${f(h * 0.4)}"/>`;
				break;

			case 'vga':
				shape = `<path class="dv-cage" d="M${f(x)} ${f(y)} h${f(w)} l-6 ${f(h)} h${f(-w + 12)} Z"/>`;
				break;

			case 'disk':
				shape = `<rect class="dv-disk" x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" rx="3"/>`
					+ `<rect class="dv-disk-handle" x="${f(x + 6)}" y="${f(y + h - 12)}" width="${f(w - 12)}" height="6" rx="2"/>`
					+ `<circle class="dv-disk-led" cx="${f(x + w - 10)}" cy="${f(y + 9)}" r="3"/>`;
				break;

			case 'psu':
				shape = `<rect class="dv-psu" x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" rx="4"/>`
					+ `<circle class="dv-psu-grill" cx="${f(x + w * 0.32)}" cy="${f(y + h / 2)}" r="${f(Math.min(h, w) * 0.32)}"/>`
					+ `<rect class="dv-inlet" x="${f(x + w * 0.62)}" y="${f(y + h * 0.28)}" width="${f(w * 0.24)}" height="${f(h * 0.44)}" rx="3"/>`
					+ `<circle class="dv-led" cx="${f(x + w - 12)}" cy="${f(y + 12)}" r="5"/>`
					+ `<text class="dv-tag" x="${f(x + w / 2)}" y="${f(y + h - 6)}">PSU ${p.n}</text>`;
				break;

			case 'fan':
				shape = `<circle class="dv-fan" cx="${f(x + w / 2)}" cy="${f(y + h / 2)}" r="${f(w / 2)}"/>`
					+ `<circle class="dv-fan-hub" cx="${f(x + w / 2)}" cy="${f(y + h / 2)}" r="${f(w * 0.14)}"/>`
					+ [0, 60, 120].map((a) => `<line class="dv-fan-blade" x1="${f(x + w / 2)}" y1="${f(y + h / 2)}" x2="${f(x + w / 2 + Math.cos(a * Math.PI / 180) * w * 0.42)}" y2="${f(y + h / 2 + Math.sin(a * Math.PI / 180) * w * 0.42)}"/>`).join('')
					+ `<circle class="dv-led" cx="${f(x + w - 6)}" cy="${f(y + 6)}" r="5"/>`;
				break;

			case 'outlet':
				shape = `<rect class="dv-outlet" x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" rx="5"/>`
					+ `<rect class="dv-slot" x="${f(x + w * 0.26)}" y="${f(y + h * 0.28)}" width="4" height="${f(h * 0.3)}"/>`
					+ `<rect class="dv-slot" x="${f(x + w * 0.64)}" y="${f(y + h * 0.28)}" width="4" height="${f(h * 0.3)}"/>`;
				break;
		}

		const cableMark = cable ? `<rect class="dv-cable" x="${f(x + w * 0.2)}" y="${f(y + h - 4)}" width="${f(w * 0.6)}" height="7" rx="2" fill="${esc(cable.c)}"/>` : '';
		const label = num && w >= 18 ? `<text class="dv-num" x="${f(x + w / 2)}" y="${f(numY)}">${p.n}</text>` : '';

		return `<g class="${cls}" data-port="${esc(ep)}" tabindex="0" role="button"><title>${esc(title)}</title>${shape}${cableMark}${label}</g>`;
	}

	// ---------------------------------------------------------------- trazado

	traceHtml(ep) {
		const esc = LakaInfra3DScene.esc;
		const t = this.t.bind(this);
		const p = LakaInfra3DDevView.split(ep);
		const part = LakaInfra3DDevView.PARTS[p.kind];

		if (!part) {
			return '';
		}

		const info = this.endpointInfo(ep);
		const iface = this.ifmap.get(p.port);
		const path = this.trace(ep);
		const cable = this.cableAt(ep);
		const canCable = part.cable !== null;
		const kindName = {net: 'Cobre (UTP)', fiber: 'Fibra', power: 'Energía'};

		const node = (n) => {
			const first = this.endpointInfo(n.eps[0]);
			const faces = n.eps.map((x) => this.endpointInfo(x));
			const isMe = first.dev === this.dev;
			const go = first.dev && !isMe ? ` data-goto="${esc(first.dev.d.key || first.dev.d.id)}"` : '';

			return `<div class="laka3d-dv-node${isMe ? ' is-me' : ''}${n.start ? ' is-start' : ''}"${go}>
				<strong>${esc(first.name)}</strong>
				<span class="laka3d-muted">${esc(first.where)}</span>
				${faces.map((x) => `<span class="laka3d-dv-pt">${esc(x.port)} · ${esc(x.face === 'F' ? t('frente') : t('atrás'))}</span><code>${esc(x.tia)}</code>`).join('')}
			</div>`;
		};
		const link = (c) => `<div class="laka3d-dv-link"><i style="background:${esc(c.c)}"></i><span>${esc(t(kindName[c.k] || 'Cable'))}${c.len ? ` · ${c.len} m` : ''}</span><code>${esc(this.cableLabel(c))}</code></div>`;

		const chain = path.map((x) => (x.cable ? link(x.cable) : node(x))).join('');
		const ends = path.filter((x) => x.eps);
		const farEnd = ends.length > 1 ? this.endpointInfo(ends[ends.length - 1].eps.slice(-1)[0]) : null;

		return `
			<section class="laka3d-dv-trace">
				<div class="laka3d-dv-tracehead">
					<div>
						<strong>${esc(t('Trazado'))}: ${esc(info.port)}${info.port !== this.portName(p.kind, p.n) ? ` (${esc(this.portName(p.kind, p.n))})` : ''} · ${esc(p.face === 'F' ? t('frente') : t('atrás'))}</strong>
						<span class="laka3d-muted">${esc(t('Identificador TIA-606'))}: <code>${esc(info.tia)}</code>${iface && iface.label ? ' · ' + esc(t('Estado en Zabbix')) + ': ' + esc(iface.label) : ''}</span>
					</div>
					<div class="laka3d-dv-btns">
						${canCable && this.api.can_edit ? `<button type="button" class="laka3d-btn" data-dv="connect" data-ep="${esc(ep)}">${esc(cable ? t('Cambiar cable') : t('Conectar cable'))}</button>` : ''}
						${cable && this.api.can_edit ? `<button type="button" class="laka3d-btn" data-dv="unplug" data-ep="${esc(ep)}">${esc(t('Quitar cable'))}</button>` : ''}
					</div>
				</div>
				${path.length > 1 ? `<div class="laka3d-dv-chain">${chain}</div>
					${farEnd ? `<p class="laka3d-muted">${esc(t('Llega a %1$s · %2$s', farEnd.name, farEnd.port))}</p>` : ''}`
					: `<p class="laka3d-muted">${esc(canCable ? t('Este puerto no tiene cable registrado.') : t('Este componente no lleva cable.'))}</p>`}
				${this.connect && this.connect.ep === ep ? this.connectHtml() : ''}
			</section>`;
	}

	connectHtml() {
		const esc = LakaInfra3DScene.esc;
		const t = this.t.bind(this);
		const c = this.connect;
		const s = this.scene;
		const kindPart = LakaInfra3DDevView.split(c.ep).kind;
		const power = LakaInfra3DDevView.PARTS[kindPart].cable === 'power';
		const racks = [...s.world.racks.entries()].filter(([, r]) => !r.cooler);
		const [, rack] = this.rackByLower(c.rack);
		const targets = [];

		if (rack) {
			for (const x of rack.devices.slice().sort((a, b) => b.d.u - a.d.u)) {
				const role = LakaInfra3DRackView.role(x.d);

				if (['cable', 'blank'].includes(role)) {
					continue;
				}

				targets.push({key: x.d.key || x.d.id, name: `U${x.d.u + x.d.n - 1} · ${x.d.name}`});
			}

			if (power) {
				for (let i = 0; i < Math.max(rack.def.vpdu || 0, 2); i++) {
					const letter = 'ABCDEFGH'[i];

					targets.unshift({key: `v:${c.rack.toLowerCase()}:${letter}`, name: `${t('PDU vertical')} ${letter}`});
				}
			}
		}

		const ports = c.dev ? this.targetPorts(c.dev, power ? 'power' : 'net').filter((p) => p.ep !== c.ep) : [];
		const kinds = power ? ['power'] : ['net', 'fiber'];
		const kindName = {net: 'Cobre (UTP)', fiber: 'Fibra', power: 'Energía'};
		const auto = c.dev && c.port ? `${this.endpointInfo(c.ep).tia} / ${this.endpointInfo(`${c.dev}#${c.port}`).tia}` : '';

		return `
			<div class="laka3d-dv-connect">
				<strong>${esc(t('Conectar a'))}</strong>
				<div class="laka3d-dv-form">
					<label>${esc(t('Rack'))}<select data-dv="c-rack">${racks.map(([n]) => `<option value="${esc(n)}"${n.toLowerCase() === c.rack.toLowerCase() ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select></label>
					<label>${esc(t('Equipo'))}<select data-dv="c-dev"><option value="">—</option>${targets.map((x) => `<option value="${esc(x.key)}"${x.key === c.dev ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
					<label>${esc(t('Puerto'))}<select data-dv="c-port"${c.dev ? '' : ' disabled'}><option value="">—</option>${ports.map((p) => `<option value="${esc(p.id)}"${p.id === c.port ? ' selected' : ''}${p.used ? ' disabled' : ''}>${esc(this.portName(p.kind, p.n))} · ${esc(p.face === 'F' ? t('frente') : t('atrás'))}${p.used ? ' (' + esc(t('ocupado')) + ')' : ''}</option>`).join('')}</select></label>
					<label>${esc(t('Tipo de cable'))}<select data-dv="c-kind">${kinds.map((k) => `<option value="${k}"${k === c.k ? ' selected' : ''}>${esc(t(kindName[k]))}</option>`).join('')}</select></label>
					<label>${esc(t('Color'))}<select data-dv="c-color" class="laka3d-dv-color">${LakaInfra3DDevView.COLORS.map((col) => `<option value="${col}"${col === c.c ? ' selected' : ''} style="background:${col}">${col}</option>`).join('')}</select></label>
					<label class="laka3d-dv-wide">${esc(t('Etiqueta'))}<input type="text" data-dv="c-label" maxlength="80" value="${esc(c.l)}" placeholder="${esc(auto || t('Automática (TIA-606)'))}"></label>
				</div>
				<div class="laka3d-dv-btns">
					<button type="button" class="laka3d-btn laka3d-btn-primary" data-dv="c-save">${esc(t('Guardar cable'))}</button>
					<button type="button" class="laka3d-btn" data-dv="c-cancel">${esc(t('Cancelar'))}</button>
				</div>
			</div>`;
	}

	// ---------------------------------------------------------------- pestañas

	tabHtml(prof, all) {
		switch (this.tab) {
			case 'power':
				return this.powerHtml(all);

			case 'health':
				return this.healthHtml();

			case 'inv':
				return this.invHtml();

			case 'profile':
				return this.profileHtml(prof);

			default:
				return this.portsHtml(all);
		}
	}

	/** Tabla de puertos de red con su interfaz de Zabbix, estado, velocidad, tráfico y cable. */
	portsHtml(all) {
		const esc = LakaInfra3DScene.esc;
		const t = this.t.bind(this);
		const d = this.dev.d;
		const key = d.key || d.id;
		const list = all.filter((p) => ['rj45', 'sfp', 'mgmt', 'console', 'pp'].includes(p.kind));
		const fs = (this.data.cabling && this.data.cabling.fs) || '';
		const bps = (v) => {
			if (v === null || v === undefined) {
				return '—';
			}

			const u = [['G', 1e9], ['M', 1e6], ['k', 1e3]].find(([, m]) => v >= m);

			return u ? `${(v / u[1]).toFixed(v / u[1] >= 100 ? 0 : 1)} ${u[0]}bps` : `${Math.round(v)} bps`;
		};
		const stName = {ok: 'Activo', bad: 'Caído', unk: 'Desconocido', nodata: 'Sin datos'};

		const rows = list.map((p) => {
			const ep = `${key}#${p.id}`;
			const iface = this.ifmap.get(p.id);
			const cable = this.cableAt(ep);
			let to = '—';

			if (cable) {
				const path = this.trace(ep).filter((x) => x.eps);
				const far = this.endpointInfo(path[path.length - 1].eps.slice(-1)[0]);
				const next = this.endpointInfo(cable.a === ep ? cable.b : cable.a);

				to = next.name === far.name ? `${far.name} · ${far.port}` : `${next.name} · ${next.port} → ${far.name} · ${far.port}`;
			}

			return `<tr data-port="${esc(ep)}" class="${this.port === ep ? 'is-sel' : ''}">
				<td><strong>${esc(this.portName(p.kind, p.n))}</strong> <span class="laka3d-muted">${esc(p.face === 'F' ? t('frente') : t('atrás'))}</span>${(() => {
					const ps = LakaInfra3DCabling.portState(this.data.cabling, ep);

					return ps.st ? ` <span class="laka3d-dv-st pst-${esc(ps.st)}" title="${esc(ps.note)}">${esc(t(LakaInfra3DCabling.STATUS[ps.st]))}</span>` : (ps.note ? ` <span class="laka3d-muted" title="${esc(ps.note)}">✎</span>` : '');
				})()}</td>
				<td>${iface ? `${esc(iface.name)}${iface.alias ? ` <span class="laka3d-muted">(${esc(iface.alias)})</span>` : ''}` : '—'}</td>
				<td>${iface ? `<span class="laka3d-dv-st st-${esc(iface.status)}">${esc(iface.label || t(stName[iface.status] || 'Sin datos'))}</span>` : '—'}</td>
				<td>${iface ? esc(bps(iface.speed)) : '—'}</td>
				<td>${iface ? `${esc(bps(iface.in))} / ${esc(bps(iface.out))}` : '—'}</td>
				<td>${cable ? `<i class="laka3d-dv-sw" style="background:${esc(cable.c)}"></i><code>${esc(this.cableLabel(cable))}</code>` : '—'}</td>
				<td>${esc(to)}</td>
			</tr>`;
		}).join('');

		return `
			${this.api.can_edit ? `<div class="laka3d-dv-fs">
				<label>${esc(t('Espacio (FS) para las etiquetas TIA-606'))} <input type="text" data-dv="fs" maxlength="8" value="${esc(fs)}" placeholder="1A"></label>
				<button type="button" class="laka3d-btn" data-dv="fs-save">${esc(t('Guardar'))}</button>
				<span class="laka3d-muted">${esc(t('Piso y sala, por ejemplo 1A. Puerto: FS.RACK-U:PUERTO.'))}</span>
			</div>` : ''}
			${list.length ? `<div class="laka3d-dv-tablewrap"><table class="laka3d-dv-table">
				<thead><tr><th>${esc(t('Puerto'))}</th><th>${esc(t('Interfaz en Zabbix'))}</th><th>${esc(t('Estado'))}</th><th>${esc(t('Velocidad'))}</th><th>${esc(t('Entrada / salida'))}</th><th>${esc(t('Cable'))}</th><th>${esc(t('Conectado a'))}</th></tr></thead>
				<tbody>${rows}</tbody>
			</table></div>` : `<p class="laka3d-muted">${esc(t('Este equipo no tiene puertos de red.'))}</p>`}
			${this.detail && (this.detail.ifaces || []).length ? `<p class="laka3d-muted">${esc(t('%1$s interfaces en Zabbix; las virtuales (VLAN, loopback, port-channel, túneles) no se dibujan.', String(this.detail.ifaces.length)))}</p>` : ''}`;
	}

	powerHtml(all) {
		const esc = LakaInfra3DScene.esc;
		const t = this.t.bind(this);
		const d = this.dev.d;
		const key = d.key || d.id;
		const list = all.filter((p) => ['psu', 'outlet'].includes(p.kind));
		const fans = all.filter((p) => p.kind === 'fan');
		const stName = {ok: 'OK', bad: 'Falla', unk: 'Desconocido', nodata: 'Sin datos'};
		const store = this.data.cabling || {};
		const hasPower = typeof LakaInfra3DPower === 'function';
		// Rama de la PDU a la que llega el cable (A, B…), con el color de la rama.
		const feedChip = (src) => {
			const f = src && hasPower ? LakaInfra3DPower.feedOf(store, src) : '';

			return f ? `<span class="laka3d-pw-feed" style="background:${esc(LakaInfra3DPower.FEED_COLOR[f])}">${esc(f)}</span>` : '—';
		};

		const rows = list.map((p) => {
			const ep = `${key}#${p.id}`;
			const zb = this.ifmap.get(p.id);
			const cable = this.cableAt(ep);
			const far = cable ? this.endpointInfo(cable.a === ep ? cable.b : cable.a) : null;

			return `<tr data-port="${esc(ep)}" class="${this.port === ep ? 'is-sel' : ''}">
				<td><strong>${esc(t(p.kind === 'psu' ? 'Fuente' : 'Toma'))} ${p.n}</strong> <span class="laka3d-muted">${esc(p.face === 'F' ? t('frente') : t('atrás'))}</span></td>
				<td>${zb ? `<span class="laka3d-dv-st st-${esc(zb.status)}" title="${esc(zb.name)}">${esc(zb.label || t(stName[zb.status]))}</span>` : '—'}</td>
				<td>${cable ? `<i class="laka3d-dv-sw" style="background:${esc(cable.c)}"></i><code>${esc(this.cableLabel(cable))}</code>` : '—'}</td>
				<td>${far ? `${esc(far.name)} · ${esc(far.port)}` : '—'}</td>
				<td>${feedChip(cable ? (cable.a === ep ? cable.b : cable.a).split('#')[0] : null)}</td>
			</tr>`;
		}).join('');

		// Redundancia: fuentes en ramas distintas (A y B) según la cadena eléctrica; sin ramas, PDU distintas.
		const psuIds = list.filter((p) => p.kind === 'psu').map((p) => p.id);
		const st = hasPower && psuIds.length ? LakaInfra3DPower.deviceState(store, key, psuIds) : null;
		const msg = {
			redundant: ['ok', 'Fuentes en ramas distintas: si cae una rama, el equipo sigue con la otra.'],
			same: ['warn', 'Todas las fuentes van a la misma rama: sin redundancia de alimentación.'],
			partial: ['warn', 'Una fuente no tiene cable: sin redundancia de alimentación.']
		}[st ? st.state : ''];
		const redundancy = msg && psuIds.length > 1 ? `<p class="laka3d-dv-${msg[0]}">${esc(t(msg[1]))}</p>` : '';

		return `
			${redundancy}
			${list.length ? `<div class="laka3d-dv-tablewrap"><table class="laka3d-dv-table">
				<thead><tr><th>${esc(t('Componente'))}</th><th>${esc(t('Estado en Zabbix'))}</th><th>${esc(t('Cable'))}</th><th>${esc(t('Conectado a'))}</th><th>${esc(t('Rama'))}</th></tr></thead>
				<tbody>${rows}</tbody>
			</table></div>` : `<p class="laka3d-muted">${esc(t('Este equipo no tiene fuentes ni tomas.'))}</p>`}
			${fans.length ? `<h4>${esc(t('Ventiladores'))}</h4><div class="laka3d-dv-chips">${fans.map((p) => {
				const zb = this.ifmap.get(p.id);

				return `<span class="laka3d-dv-st st-${esc(zb ? zb.status : 'nodata')}" title="${esc(zb ? zb.name : '')}">${esc(t('Ventilador'))} ${p.n}: ${esc(zb ? (zb.label || t(stName[zb.status])) : t('Sin datos'))}</span>`;
			}).join('')}</div>` : ''}`;
	}

	healthHtml() {
		const esc = LakaInfra3DScene.esc;
		const t = this.t.bind(this);
		const det = this.detail;

		if (!det) {
			return `<p class="laka3d-muted">${esc(t('Cargando datos de Zabbix…'))}</p>`;
		}

		const bar = (label, v, extra = '') => `<div class="laka3d-dv-bar"><span>${esc(label)}</span><div class="laka3d-meter"><b style="width:${Math.min(100, v || 0)}%;background:${v === null || v === undefined ? 'transparent' : (LakaInfra3DScene.usageColor(v) || LakaInfra3DScene.OK_COLOR)}"></b></div><strong>${v === null || v === undefined ? esc(t('Sin datos recientes')) : v + ' %'}</strong>${extra}</div>`;
		const uptime = (s) => {
			if (!s) {
				return '—';
			}

			const days = Math.floor(s / 86400);
			const h = Math.floor((s % 86400) / 3600);

			return days > 0 ? `${days} d ${h} h` : `${h} h ${Math.floor((s % 3600) / 60)} min`;
		};
		const gib = (b) => (b ? `${(b / 1073741824).toFixed(1)} GB` : '');
		const stName = {ok: 'OK', bad: 'Falla', unk: 'Desconocido', nodata: 'Sin datos'};

		return `
			<div class="laka3d-dv-health">
				<div>
					<h4>${esc(t('Recursos'))}</h4>
					${bar(t('CPU'), det.cpu, det.cores ? `<em>${det.cores} ${esc(t('núcleos'))}</em>` : '')}
					${bar(t('Memoria RAM'), det.mem, det.memtotal ? `<em>${esc(gib(det.memtotal))}</em>` : '')}
					<p><span class="laka3d-muted">${esc(t('Tiempo encendido'))}:</span> <strong>${esc(uptime(det.uptime))}</strong></p>
				</div>
				<div>
					<h4>${esc(t('Discos y sistemas de archivos'))}</h4>
					${(det.fs || []).length ? det.fs.map((x) => bar(x.name, x.pused)).join('') : `<p class="laka3d-muted">${esc(t('Sin sistemas de archivos en Zabbix.'))}</p>`}
					${(det.disks || []).length ? `<div class="laka3d-dv-chips">${det.disks.map((x) => `<span class="laka3d-dv-st st-${esc(x.status)}" title="${esc(x.name)}">${esc(x.name.length > 40 ? x.name.slice(0, 39) + '…' : x.name)}: ${esc(x.label || t(stName[x.status]))}</span>`).join('')}</div>` : ''}
				</div>
				<div>
					<h4>${esc(t('Servicios'))}</h4>
					${det.services && det.services.total ? (det.services.down.length
						? `<p class="laka3d-dv-warn">${esc(t('%1$s de %2$s servicios automáticos no están en ejecución:', String(det.services.down.length), String(det.services.total)))}</p><ul class="laka3d-dv-list">${det.services.down.map((x) => `<li>${esc(x.name)} <span class="laka3d-muted">${esc(x.label)}</span></li>`).join('')}</ul>`
						: `<p class="laka3d-dv-ok">${esc(t('Los %1$s servicios automáticos están en ejecución.', String(det.services.total)))}</p>`)
						: `<p class="laka3d-muted">${esc(t('Sin servicios descubiertos en Zabbix.'))}</p>`}
				</div>
			</div>`;
	}

	invHtml() {
		const esc = LakaInfra3DScene.esc;
		const t = this.t.bind(this);
		const inv = (this.detail && this.detail.inv) || {};
		const base = this.dev.d.inv || {};
		const rows = [
			['Fabricante', inv.vendor || base.vendor], ['Modelo', inv.model || base.model], ['Chasis', inv.chassis],
			['Número de serie', inv.serialno_a || base.serial], ['Número de serie B', inv.serialno_b],
			['Sistema operativo', inv.os_full || inv.os || base.os], ['Hardware', inv.hardware_full || inv.hardware],
			['Dirección MAC', inv.macaddress_a], ['Etiqueta de activo', inv.asset_tag || base.asset],
			['Ubicación', inv.location || base.location]
		].filter(([, v]) => v && String(v).trim() !== '');

		return rows.length
			? `<div class="laka3d-inv laka3d-dv-inv">${rows.map(([k, v]) => `<span class="laka3d-muted">${esc(t(k))}</span><strong>${esc(v)}</strong>`).join('')}</div>`
			: `<p class="laka3d-muted">${esc(t('El host no tiene inventario en Zabbix. Actívalo en modo automático o manual para ver fabricante, modelo y serie.'))}</p>`;
	}

	/** Perfil del modelo (cantidades por cara) y fotos del frente y de atrás. */
	profileHtml(prof) {
		const esc = LakaInfra3DScene.esc;
		const t = this.t.bind(this);
		const d = this.dev.d;
		const n = d.n || 1;
		const W = LakaInfra3DDevView.W;
		const H = LakaInfra3DDevView.UH * n;
		const inv = d.inv || {};
		const saved = prof.saved || {};
		const modelName = (inv.model || '').trim() !== '' ? `${inv.vendor || ''} ${inv.model}`.trim() : null;
		const fields = (face) => Object.keys(LakaInfra3DDevView.PARTS).map((k) => `<label>${esc(t(LakaInfra3DDevView.PARTS[k].name))}<input type="number" min="0" max="96" data-dv="prof" data-face="${face}" data-part="${k}" value="${prof.profile[face][k] || 0}"></label>`).join('');
		const photo = (side, field, title) => {
			const pending = this.pending && this.pending[side];
			const current = saved[field] ? this.api.img_url + encodeURIComponent(saved[field]) : null;

			return `<div class="laka3d-dv-photo">
				<strong>${esc(title)}</strong>
				${pending ? `<img src="${esc(pending)}" alt="">` : (current ? `<img src="${esc(current)}" alt="">` : `<div class="laka3d-dv-nophoto">${W} × ${H} px</div>`)}
				<div class="laka3d-dv-btns">
					<input type="file" accept="image/png,image/jpeg" data-dv="img-file" data-side="${side}"${this.api.is_super ? '' : ' disabled'}>
					${pending ? `<button type="button" class="laka3d-btn laka3d-btn-primary" data-dv="img-save" data-side="${side}">${esc(t('Subir foto'))}</button>` : ''}
					${current && this.api.is_super ? `<button type="button" class="laka3d-btn" data-dv="img-clear" data-side="${side}">${esc(t('Quitar foto'))}</button>` : ''}
				</div>
			</div>`;
		};

		return `
			<p class="laka3d-muted">${esc(modelName ? t('Se guarda para el modelo %1$s: lo comparten todos los equipos de ese modelo.', modelName) : t('El host no tiene modelo en el inventario: el perfil se guarda solo para este equipo.'))}</p>
			<div class="laka3d-dv-prof">
				<fieldset><legend>${esc(t('Frente'))}</legend>${fields('F')}</fieldset>
				<fieldset><legend>${esc(t('Atrás'))}</legend>${fields('R')}</fieldset>
			</div>
			<div class="laka3d-dv-btns">
				<button type="button" class="laka3d-btn laka3d-btn-primary" data-dv="prof-save">${esc(t('Guardar perfil'))}</button>
				${saved.p ? `<button type="button" class="laka3d-btn" data-dv="prof-reset">${esc(t('Volver al automático'))}</button>` : ''}
			</div>
			<h4>${esc(t('Fotos del modelo'))}</h4>
			<p class="laka3d-muted">${esc(t('Tamaño: %1$s × %2$s px (1200 px de ancho y 111 px por U, la proporción de un equipo de 19"). La foto se ajusta sola a ese tamaño, recortando al centro. PNG o JPEG, hasta 1 MB. Se guarda en Zabbix (Administración → General → Imágenes) y solo se muestra en esta vista.', String(W), String(H)))}</p>
			${this.api.is_super ? '' : `<p class="laka3d-dv-warn">${esc(t('Solo un superadministrador puede subir o quitar fotos: Zabbix guarda las imágenes con su API de imágenes.'))}</p>`}
			<div class="laka3d-dv-photos">
				${photo('front', 'f', t('Frente'))}
				${photo('back', 'b', t('Atrás'))}
			</div>`;
	}
}
