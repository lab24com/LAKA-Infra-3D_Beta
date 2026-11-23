/*
 * LAKA Infra 3D – gemelo digital de data center para Zabbix 7.0 – 8.0
 * © LAKA Soluciones Tecnológicas
 * Autor: Willian Tola
 * Licencia GPLv3
 *
 * Cadena eléctrica A/B y análisis de impacto (ANSI/TIA-942, sistemas eléctricos; niveles Rated 1–4).
 * - Cada PDU (en U o vertical), UPS, tablero, ATS, generador o transformador tiene una rama (A–D) y hasta
 *   dos fuentes aguas arriba (cableado → pw: "rama|fuente1,fuente2"). Con dos fuentes el elemento sigue
 *   con energía mientras una tenga (ej. ATS alimentado por la red y por el generador).
 * - Las fuentes de poder de cada equipo se conectan a las tomas de las PDU con cables de energía.
 * - Redundancia: un equipo con dos o más fuentes debe tomarlas de ramas distintas.
 * - Simulación: se elige qué falla (una rama, una UPS, un tablero, una PDU o un switch) y se calcula qué
 *   equipos se apagan, cuáles pierden redundancia y qué elementos de la sala quedan sin energía o sin red.
 */

class LakaInfra3DPower {

	static FEEDS = ['A', 'B', 'C', 'D'];

	// Elementos de la sala que alimentan a otros (fuentes) y los que solo consumen pero tienen su tablero.
	static SOURCE_KINDS = ['transformer', 'generator', 'ats', 'ups', 'panel'];
	static FED_KINDS = ['transformer', 'generator', 'ats', 'ups', 'panel', 'battery', 'crac', 'inrow', 'split', 'cdu', 'rdhx'];

	// Colores de las ramas y de los estados (OK, advertencia, promedio, desastre y sin datos de Zabbix).
	static FEED_COLOR = {A: '#4796c4', B: '#e8a33d', C: '#8f6cf2', D: '#2bb5a3'};
	static STATE = {
		redundant: {color: '#59db8f', name: 'Redundante (2 ramas)'},
		single: {color: '#7499ff', name: 'Una sola fuente'},
		same: {color: '#ffa059', name: 'Fuentes en la misma rama'},
		partial: {color: '#ffc859', name: 'Una fuente sin cable'},
		none: {color: '#768d99', name: 'Sin documentar'},
		ok: {color: '#59db8f', name: 'Sigue funcionando'},
		degraded: {color: '#ffa059', name: 'Pierde redundancia'},
		down: {color: '#e45959', name: 'Se apaga'},
		nonet: {color: '#b46cf2', name: 'Sin red'},
		unknown: {color: '#768d99', name: 'Sin documentar'}
	};

	// ================================================================ motor (sin vista)

	/** Configuración eléctrica de una clave: {feed, ups[]}. */
	static get(store, key) {
		const s = ((store && store.pw) || {})[key] || '';
		const [feed = '', ups = ''] = s.split('|');

		return {feed: LakaInfra3DPower.FEEDS.includes(feed) ? feed : '', ups: ups.split(',').filter(Boolean).slice(0, 2)};
	}

	static set(store, key, feed, ups) {
		store.pw = store.pw || {};

		const list = (ups || []).filter((u) => u && u !== key).slice(0, 2);

		if (!feed && !list.length) {
			delete store.pw[key];
		}
		else {
			store.pw[key] = `${feed || ''}|${[...new Set(list)].join(',')}`;
		}
	}

	/**
	 * Rama efectiva: la propia, la heredada de su primera fuente o, en una PDU vertical sin configurar,
	 * la letra de la PDU (A o B), que es la convención de los racks con doble alimentación.
	 */
	static feedOf(store, key, seen = new Set()) {
		if (seen.has(key)) {
			return '';
		}

		seen.add(key);

		const cfg = LakaInfra3DPower.get(store, key);

		if (cfg.feed) {
			return cfg.feed;
		}

		for (const up of cfg.ups) {
			const f = LakaInfra3DPower.feedOf(store, up, seen);

			if (f) {
				return f;
			}
		}

		const v = /^v:[^:]+:([A-D])$/.exec(key);

		return v ? v[1] : '';
	}

	/** Cadena aguas arriba (para mostrar): PDU ← tablero ← UPS ← ATS ← red / generador. */
	static chain(store, key, depth = 0, seen = new Set()) {
		if (seen.has(key) || depth > 8) {
			return [];
		}

		seen.add(key);

		return LakaInfra3DPower.get(store, key).ups.map((u) => ({key: u, ups: LakaInfra3DPower.chain(store, u, depth + 1, seen)}));
	}

	/**
	 * ¿Se queda sin energía? Sí, si es lo que falla, si su rama es la que falla, o si todas sus fuentes
	 * aguas arriba se quedan sin energía.
	 */
	static isDead(store, key, fail, memo = new Map(), seen = new Set()) {
		if (memo.has(key)) {
			return memo.get(key);
		}

		if (seen.has(key)) {
			return false;
		}

		seen.add(key);

		let dead = fail.keys.has(key);

		if (!dead && fail.feeds.size) {
			const f = LakaInfra3DPower.feedOf(store, key);

			dead = f !== '' && fail.feeds.has(f);
		}

		if (!dead) {
			const ups = LakaInfra3DPower.get(store, key).ups;

			dead = ups.length > 0 && ups.every((u) => LakaInfra3DPower.isDead(store, u, fail, memo, seen));
		}

		memo.set(key, dead);

		return dead;
	}

	/** Fuentes de poder de un equipo y a qué PDU (o UPS) llega el cable de cada una. */
	static links(store, devKey, psuIds) {
		return psuIds.map((id) => {
			const ep = `${devKey}#${id}`;
			const c = LakaInfra3DCabling.cableAt(store, ep);

			return {ep, src: c ? (c.a === ep ? c.b : c.a).split('#')[0] : null};
		});
	}

	/**
	 * Estado eléctrico de un equipo. Sin falla: redundante, una sola fuente, misma rama, una fuente sin cable
	 * o sin documentar. Con falla: sigue, pierde redundancia, se apaga o sin documentar.
	 */
	static deviceState(store, devKey, psuIds, fail = null, memo = new Map()) {
		const links = LakaInfra3DPower.links(store, devKey, psuIds);
		const cabled = links.filter((l) => l.src);

		if (!cabled.length) {
			return {state: fail ? 'unknown' : 'none', links, psus: psuIds.length};
		}

		if (fail) {
			const alive = cabled.filter((l) => !LakaInfra3DPower.isDead(store, l.src, fail, memo));

			return {state: alive.length === 0 ? 'down' : (alive.length < cabled.length ? 'degraded' : 'ok'), links,
				psus: psuIds.length};
		}

		// Ramas distintas; si una PDU no tiene rama, cuenta como propia (no se puede asegurar que comparta).
		const feeds = new Set(cabled.map((l) => LakaInfra3DPower.feedOf(store, l.src) || `pdu:${l.src}`));

		if (psuIds.length < 2) {
			return {state: 'single', links, psus: psuIds.length, feeds};
		}

		if (cabled.length < psuIds.length) {
			return {state: feeds.size >= 2 ? 'redundant' : 'partial', links, psus: psuIds.length, feeds};
		}

		return {state: feeds.size >= 2 ? 'redundant' : 'same', links, psus: psuIds.length, feeds};
	}

	// ================================================================ vista 3D

	constructor(scene) {
		this.scene = scene;
		this.sim = null;
		this.target = '';
		this.result = null;
	}

	t(...args) {
		return this.scene.t(...args);
	}

	get store() {
		return (this.scene.data && this.scene.data.cabling) || LakaInfra3DCabling.empty();
	}

	/** Fuentes de poder del equipo según su perfil (modelo guardado, inventario o perfil típico). */
	psuIds(d) {
		if (d.passive || ['patch', 'pdu', 'cable', 'blank'].includes(LakaInfra3DRackView.role(d))) {
			return [];
		}

		const {profile} = LakaInfra3DDevView.profileOf(d, this.scene.data);

		return [...LakaInfra3DDevView.ports(profile, 'F'), ...LakaInfra3DDevView.ports(profile, 'R')]
			.filter((p) => p.kind === 'psu').map((p) => p.id);
	}

	keyOf(d) {
		return String(d.key || d.id);
	}

	/** Todos los nodos que pueden fallar: ramas, fuentes de la sala, PDU, UPS de rack y switches. */
	nodes() {
		const s = this.scene;
		const store = this.store;
		const out = [];
		const feeds = new Set();

		for (const k of Object.keys(store.pw || {})) {
			const f = LakaInfra3DPower.feedOf(store, k);

			if (f) {
				feeds.add(f);
			}
		}

		for (const r of s.world.racks.values()) {
			for (let i = 0; i < (r.def.vpdu || 0); i++) {
				feeds.add('ABCD'[i] || 'A');
			}
		}

		for (const f of [...feeds].sort()) {
			out.push({key: `feed:${f}`, name: `${this.t('Rama')} ${f}`, group: this.t('Ramas')});
		}

		for (const e of s.world.objects) {
			if (LakaInfra3DPower.SOURCE_KINDS.includes(e.o.kind)) {
				out.push({key: `x:${e.o.id}`, name: e.o.name || s.kindName(e.o.kind), group: this.t('Fuentes de la sala'),
					kind: e.o.kind});
			}
		}

		for (const r of [...s.world.racks.values()].filter((x) => !x.cooler)) {
			for (let i = 0; i < (r.def.vpdu || 0); i++) {
				const letter = 'ABCDEFGH'[i];

				out.push({key: `v:${r.def.name.toLowerCase()}:${letter}`, name: `${this.t('PDU vertical')} ${letter} · ${r.def.name}`,
					group: this.t('PDU')});
			}

			for (const dev of r.devices) {
				const role = LakaInfra3DRackView.role(dev.d);

				if (role === 'pdu' || role === 'ups') {
					out.push({key: this.keyOf(dev.d), name: `${dev.d.name} · ${r.def.name}`, group: role === 'ups' ? this.t('UPS de rack') : this.t('PDU')});
				}
				else if (['core', 'access', 'switch', 'router', 'firewall'].includes(role)) {
					out.push({key: this.keyOf(dev.d), name: `${dev.d.name} · ${r.def.name}`, group: this.t('Equipos de red'), net: true});
				}
			}
		}

		return out;
	}

	/** Nombre de una clave de la cadena eléctrica. */
	nodeName(key) {
		if (key.startsWith('x:')) {
			const e = this.scene.world.objectsById.get(key.slice(2));

			return e ? (e.o.name || this.scene.kindName(e.o.kind)) : key;
		}

		if (key.startsWith('v:')) {
			const [, rack, letter] = key.split(':');

			return `${this.t('PDU vertical')} ${letter} · ${rack.toUpperCase()}`;
		}

		const dev = this.scene.devView ? this.scene.devView.devByKey(key) : null;

		return dev ? dev.d.name : key;
	}

	/** Estado de cada equipo (y de cada elemento de la sala si hay simulación). */
	analyze() {
		const s = this.scene;
		const store = this.store;
		const fail = this.sim;
		const memo = new Map();
		const devices = new Map();
		const counts = {};

		if (!s.world) {
			return null;
		}

		for (const dev of s.world.devices) {
			const ids = this.psuIds(dev.d);

			if (!ids.length) {
				continue;
			}

			const st = LakaInfra3DPower.deviceState(store, this.keyOf(dev.d), ids, fail, memo);

			devices.set(dev, st);
		}

		const objects = new Map();

		if (fail) {
			// Equipos de red que se apagan o que fallan: lo que cuelga de ellos queda sin red.
			const downKeys = new Set([...fail.keys]);

			for (const [dev, st] of devices) {
				if (st.state === 'down') {
					downKeys.add(this.keyOf(dev.d));
				}
			}

			const endOf = (ep) => {
				const path = LakaInfra3DCabling.path(store, ep);

				return path.length > 1 ? path[path.length - 1].split('#')[0] : null;
			};

			// Lo que se eligió como falla (un switch, una UPS de rack) queda apagado.
			for (const dev of s.world.devices) {
				if (fail.keys.has(this.keyOf(dev.d))) {
					const st = devices.get(dev);

					devices.set(dev, {state: 'down', links: st ? st.links : [], psus: st ? st.psus : 0});
				}
			}

			// Equipos que siguen con energía pero cuyos enlaces de datos terminan todos en equipos caídos.
			for (const dev of s.world.devices) {
				const key = this.keyOf(dev.d);
				const st = devices.get(dev);

				if (st && st.state === 'down') {
					continue;
				}

				const ends = (store.list || []).map((c) => c.split('|')).filter((c) => c[2] !== 'power')
					.flatMap((c) => [c[0], c[1]]).filter((ep) => ep.split('#')[0] === key && !ep.includes('-pp-'))
					.map(endOf).filter(Boolean);

				if (ends.length && ends.every((k) => downKeys.has(k))) {
					devices.set(dev, {state: 'nonet', links: st ? st.links : [], psus: st ? st.psus : 0});
				}
			}

			for (const e of s.world.objects) {
				const id = `x:${e.o.id}`;

				if (LakaInfra3DPower.FED_KINDS.includes(e.o.kind) && LakaInfra3DPower.isDead(store, id, fail, memo)) {
					objects.set(e, 'down');
					continue;
				}

				const end = typeof LakaInfra3DCabling.NET_KINDS !== 'undefined' && LakaInfra3DCabling.NET_KINDS.includes(e.o.kind)
					? endOf(LakaInfra3DCabling.objEp(e.o.id)) : null;

				if (end && downKeys.has(end)) {
					objects.set(e, 'nonet');
				}
			}

			// PDU verticales caídas (para su color).
			this.deadVpdu = new Set((s.world.vpdus || []).map((v) => `v:${v.rack.def.name.toLowerCase()}:${'ABCDEFGH'[v.letter ?? 0]}`)
				.filter((k) => LakaInfra3DPower.isDead(store, k, fail, memo)));
		}

		for (const st of devices.values()) {
			counts[st.state] = (counts[st.state] || 0) + 1;
		}

		// Redundancia de la sala sin falla (los indicadores de la ventana no cambian al simular).
		const base = {};

		for (const dev of s.world.devices) {
			const ids = this.psuIds(dev.d);

			if (ids.length) {
				const st = fail ? LakaInfra3DPower.deviceState(store, this.keyOf(dev.d), ids).state : devices.get(dev).state;

				base[st] = (base[st] || 0) + 1;
			}
		}

		for (const st of objects.values()) {
			counts[`obj_${st}`] = (counts[`obj_${st}`] || 0) + 1;
		}

		this.result = {devices, objects, counts, base};

		return this.result;
	}

	color(d) {
		if (!this.result) {
			this.analyze();
		}

		const dev = this.scene.world.devicesById.get(d.id);
		const st = dev && this.result ? this.result.devices.get(dev) : null;

		if (!st) {
			return d.passive || LakaInfra3DRackView.role(d) === 'pdu' ? null : (this.sim ? '#5f676e' : '#5f676e');
		}

		return LakaInfra3DPower.STATE[st.state].color;
	}

	objectColor(o) {
		if (!this.sim || !this.result) {
			return null;
		}

		const e = this.scene.world.objectsById.get(o.id);
		const st = e ? this.result.objects.get(e) : null;

		return st ? LakaInfra3DPower.STATE[st].color : null;
	}

	/** Color de la barra del rack: el peor estado de sus equipos. */
	rackColor(rack) {
		const order = this.sim ? ['down', 'nonet', 'degraded', 'unknown', 'ok'] : ['same', 'partial', 'none', 'single', 'redundant'];

		for (const state of order) {
			if (rack.devices.some((x) => this.result && this.result.devices.get(x) && this.result.devices.get(x).state === state)) {
				return LakaInfra3DPower.STATE[state].color;
			}
		}

		return '#59636d';
	}

	vpduColor(v) {
		const key = `v:${v.rack.def.name.toLowerCase()}:${'ABCDEFGH'[v.letter ?? 0]}`;

		if (this.sim && this.deadVpdu && this.deadVpdu.has(key)) {
			return LakaInfra3DPower.STATE.down.color;
		}

		return LakaInfra3DPower.FEED_COLOR[LakaInfra3DPower.feedOf(this.store, key)] || '#ffffff';
	}

	legendHtml() {
		const esc = LakaInfra3DScene.esc;
		const states = this.sim ? ['down', 'degraded', 'nonet', 'ok', 'unknown'] : ['redundant', 'same', 'partial', 'single', 'none'];
		const counts = (this.result && this.result.counts) || {};

		return states.map((k) => `<span class="laka3d-chip"><i style="background:${LakaInfra3DPower.STATE[k].color}"></i>${esc(this.t(LakaInfra3DPower.STATE[k].name))} <strong>${counts[k] || 0}</strong></span>`).join('')
			+ (this.sim ? '' : Object.entries(LakaInfra3DPower.FEED_COLOR).slice(0, 2).map(([f, c]) => `<span class="laka3d-chip"><i style="background:${c}"></i>${esc(this.t('Rama'))} ${f}</span>`).join(''));
	}

	// ---------------------------------------------------------------- ventana

	open() {
		const s = this.scene;

		s.panelState = {kind: 'power', id: null};
		this.render();
		s.panel.hidden = false;
	}

	render() {
		const s = this.scene;
		const esc = LakaInfra3DScene.esc;
		const t = this.t.bind(this);

		if (!s.world) {
			return;
		}

		this.analyze();

		const c = this.result.counts;
		const b = this.result.base;
		const nodes = this.nodes();
		const groups = [...new Set(nodes.map((n) => n.group))];
		const store = this.store;

		// Árbol de fuentes: de cada fuente de la sala sin otra fuente arriba, hacia abajo.
		const children = new Map();

		for (const [k, v] of Object.entries(store.pw || {})) {
			for (const up of (v.split('|')[1] || '').split(',').filter(Boolean)) {
				if (!children.has(up)) {
					children.set(up, []);
				}

				children.get(up).push(k);
			}
		}

		const roots = [...new Set([...children.keys()].filter((k) => LakaInfra3DPower.get(store, k).ups.length === 0))];
		// Un elemento con dos fuentes (ej. ATS: red y generador) se despliega una sola vez; la segunda vez se
		// nombra con una flecha hacia arriba.
		const shown = new Set();
		const tree = (key, depth = 0) => {
			const f = LakaInfra3DPower.feedOf(store, key);
			const chip = `<span class="laka3d-pw-feed" style="background:${esc(LakaInfra3DPower.FEED_COLOR[f] || '#768d99')}">${esc(f || '–')}</span>`;

			if (shown.has(key) || depth > 6) {
				return `<li>${chip}${esc(this.nodeName(key))} <span class="laka3d-muted">↑</span></li>`;
			}

			shown.add(key);

			const kids = (children.get(key) || []).slice().sort();

			return `<li>${chip}${esc(this.nodeName(key))}${kids.length ? `<ul>${kids.map((k) => tree(k, depth + 1)).join('')}</ul>` : ''}</li>`;
		};

		let simHtml = '';

		if (this.sim) {
			const down = [...this.result.devices].filter(([, st]) => st.state === 'down').map(([dev]) => dev);
			const degraded = [...this.result.devices].filter(([, st]) => st.state === 'degraded').map(([dev]) => dev);
			const nonet = [...this.result.devices].filter(([, st]) => st.state === 'nonet').map(([dev]) => dev);
			const objs = [...this.result.objects];
			const list = (devs) => devs.slice(0, 24).map((dev) => `<button type="button" class="laka3d-linkbtn" data-dev="${esc(dev.d.id)}">${esc(dev.d.name)}</button>`).join(', ')
				+ (devs.length > 24 ? ` ${esc(t('y %1$s más', String(devs.length - 24)))}` : '');

			simHtml = `
				<div class="laka3d-pw-sim">
					<p><strong>${esc(t('Si falla %1$s:', this.targetName()))}</strong></p>
					${down.length ? `<p><span class="laka3d-pw-st" style="background:${LakaInfra3DPower.STATE.down.color}"></span>${esc(t('Se apagan %1$s equipos', String(down.length)))}: ${list(down)}</p>` : ''}
					${degraded.length ? `<p><span class="laka3d-pw-st" style="background:${LakaInfra3DPower.STATE.degraded.color}"></span>${esc(t('Pierden redundancia %1$s equipos', String(degraded.length)))}: ${list(degraded)}</p>` : ''}
					${nonet.length ? `<p><span class="laka3d-pw-st" style="background:${LakaInfra3DPower.STATE.nonet.color}"></span>${esc(t('Quedan sin red %1$s equipos', String(nonet.length)))}: ${list(nonet)}</p>` : ''}
					${objs.length ? `<p><span class="laka3d-pw-st" style="background:${LakaInfra3DPower.STATE.down.color}"></span>${esc(t('Elementos de la sala afectados'))}: ${objs.map(([e, st]) => `${esc(e.o.name || s.kindName(e.o.kind))} (${esc(t(st === 'down' ? 'sin energía' : 'sin red'))})`).join(', ')}</p>` : ''}
					${!down.length && !degraded.length && !nonet.length && !objs.length ? `<p class="laka3d-ok">${esc(t('Nada se apaga: la sala soporta esta falla.'))}</p>` : ''}
					${(c.unknown || 0) ? `<p class="laka3d-muted">${esc(t('%1$s equipos sin cables de energía documentados: no se puede saber qué les pasa.', String(c.unknown)))}</p>` : ''}
				</div>`;
		}

		s.panel.innerHTML = `
			${s.crumbs([{t: s.roomName(), go: 'room'}, {t: t('Energía')}])}
			<div class="laka3d-head"><span class="laka3d-dot" style="background:${LakaInfra3DPower.FEED_COLOR.A}"></span>
				<div class="laka3d-titles"><strong>${esc(t('Energía y redundancia'))}</strong><span class="laka3d-muted">${esc(t('Cadena eléctrica A/B · ANSI/TIA-942'))}</span></div>
				<button type="button" class="laka3d-x" data-act="close" aria-label="${esc(t('Cerrar'))}">✕</button></div>
			<div class="laka3d-kpis">
				<div><span class="laka3d-muted">${esc(t('Redundantes'))}</span><strong style="color:${LakaInfra3DPower.STATE.redundant.color}">${b.redundant || 0}</strong></div>
				<div><span class="laka3d-muted">${esc(t('Misma rama'))}</span><strong style="color:${LakaInfra3DPower.STATE.same.color}">${(b.same || 0) + (b.partial || 0)}</strong></div>
				<div><span class="laka3d-muted">${esc(t('Sin documentar'))}</span><strong>${b.none || 0}</strong></div>
			</div>
			${s.energy ? s.energy.pueHtml() : ''}
			<h4>${esc(t('Simular una falla'))}</h4>
			<div class="laka3d-pw-form">
				<select data-pw="target" aria-label="${esc(t('Qué falla'))}">
					<option value="">${esc(t('Elige qué falla…'))}</option>
					${groups.map((g) => `<optgroup label="${esc(g)}">${nodes.filter((n) => n.group === g).map((n) => `<option value="${esc(n.key)}"${n.key === this.target ? ' selected' : ''}>${esc(n.name)}</option>`).join('')}</optgroup>`).join('')}
				</select>
				<button type="button" class="laka3d-btn laka3d-btn-primary" data-pw="run"${this.target ? '' : ' disabled'}>${esc(t('Simular'))}</button>
				${this.sim ? `<button type="button" class="laka3d-btn" data-pw="stop">${esc(t('Terminar'))}</button>` : ''}
			</div>
			${simHtml}
			<h4>${esc(t('Cadena eléctrica'))}</h4>
			${roots.length ? `<ul class="laka3d-pw-tree">${roots.map((k) => tree(k)).join('')}</ul>`
				: `<p class="laka3d-muted">${esc(t('Sin cadena eléctrica configurada. En el editor: rama y "Alimentado desde" en UPS, tableros y PDU.'))}</p>`}`;
	}

	targetName() {
		if (this.target.startsWith('feed:')) {
			return `${this.t('Rama')} ${this.target.slice(5)}`;
		}

		return this.nodeName(this.target);
	}

	simulate(target) {
		this.target = target || '';

		if (!this.target) {
			this.sim = null;
		}
		else if (this.target.startsWith('feed:')) {
			this.sim = {keys: new Set(), feeds: new Set([this.target.slice(5)])};
		}
		else {
			this.sim = {keys: new Set([this.target]), feeds: new Set()};
		}

		this.result = null;
		this.scene.applyMode();
		this.scene.renderLegend();
		this.render();
	}

	/** Clics de la ventana. Devuelve true si los atendió. */
	panelClick(e) {
		const btn = e.target.closest('[data-pw]');

		if (!btn || btn.tagName === 'SELECT') {
			return false;
		}

		if (btn.dataset.pw === 'run') {
			this.simulate(this.target);
		}
		else if (btn.dataset.pw === 'stop') {
			this.simulate('');
		}

		return true;
	}

	panelChange(e) {
		if (e.target.dataset.pw === 'target') {
			this.target = e.target.value;
			this.render();

			return true;
		}

		return false;
	}

	/** Al salir del modo Energía se termina la simulación. */
	leave() {
		this.sim = null;
		this.target = '';
		this.result = null;
	}

	rebuilt() {
		this.result = null;
	}
}
