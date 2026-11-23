/*
 * LAKA Infra 3D – gemelo digital de data center para Zabbix 7.0 – 8.0
 * © LAKA Soluciones Tecnológicas
 * Autor: Willian Tola
 * Licencia GPLv3
 *
 * Capacidad de la sala: espacio (U), energía (kW) y peso (kg) por rack.
 * - Modo de color "Capacidad": cada rack según su ocupación y su consumo, con los huecos libres en verde.
 * - Planificador "¿Dónde entra?": busca los racks con espacio, energía y peso para un equipo nuevo.
 * Una U se toma como ocupada si hay un equipo en el frente o atrás (criterio conservador).
 */

class LakaInfra3DCapacity {

	// Umbrales de uso (colores de severidad de Zabbix: Advertencia, Promedio, Desastre).
	static LEVELS = [[0.95, '#e45959'], [0.8, '#ffa059'], [0.6, '#ffc859']];
	static OK = '#59db8f';
	static NONE = '#768d99';

	constructor(scene) {
		this.scene = scene;
		this.plan = {n: 2, w: 500, kg: 25};
		this.results = null;
		this.ghost = null;
		this.picks = null;
		this.labels = [];
	}

	t(...args) {
		return this.scene.t(...args);
	}

	static color(ratio) {
		if (ratio === null || ratio === undefined || !isFinite(ratio)) {
			return LakaInfra3DCapacity.NONE;
		}

		for (const [limit, color] of LakaInfra3DCapacity.LEVELS) {
			if (ratio >= limit) {
				return color;
			}
		}

		return LakaInfra3DCapacity.OK;
	}

	// ---------------------------------------------------------------- cálculo

	/**
	 * Capacidad de un rack: U usadas y libres, huecos libres, energía medida/estimada y peso.
	 */
	of(rack) {
		const def = rack.def;
		const units = def.units;
		const occ = new Array(units + 2).fill(false);
		let estW = 0;
		let kg = 0;

		for (const dev of rack.devices) {
			const d = dev.d;

			for (let u = d.u; u < d.u + d.n && u <= units; u++) {
				occ[u] = true;
			}

			estW += d.w || 0;
			kg += d.kg || 0;
		}

		const blocks = [];
		let start = null;

		for (let u = 1; u <= units + 1; u++) {
			if (u <= units && !occ[u]) {
				if (start === null) {
					start = u;
				}
			}
			else if (start !== null) {
				blocks.push({u: start, n: u - start});
				start = null;
			}
		}

		const used = occ.slice(1, units + 1).filter(Boolean).length;
		const capW = (def.power_kw || 0) * 1000;
		const measured = typeof def.power_w === 'number' ? def.power_w : null;
		const load = measured !== null ? measured : (estW > 0 ? estW : null);

		return {
			units, used, free: units - used, blocks,
			largest: blocks.reduce((m, b) => Math.max(m, b.n), 0),
			ratioU: units ? used / units : 0,
			capW, measured, estW, load,
			ratioW: capW > 0 && load !== null ? load / capW : null,
			kg, maxKg: def.max_kg || 0,
			ratioKg: def.max_kg > 0 ? kg / def.max_kg : null,
			pdus: def.pdu_count || 0
		};
	}

	/** Peor relación de uso del rack (espacio, energía o peso). */
	static worst(c) {
		return Math.max(c.ratioU, c.ratioW ?? 0, c.ratioKg ?? 0);
	}

	racks() {
		return [...this.scene.world.racks.values()].filter((r) => !r.cooler);
	}

	totals() {
		const list = this.racks().map((r) => ({rack: r, c: this.of(r)}));
		const sum = (fn) => list.reduce((acc, x) => acc + fn(x.c), 0);
		const withCap = list.filter((x) => x.c.capW > 0);

		return {
			list,
			units: sum((c) => c.units),
			used: sum((c) => c.used),
			capW: sum((c) => c.capW),
			loadW: withCap.reduce((acc, x) => acc + (x.c.load || 0), 0),
			measuredW: sum((c) => c.measured || 0),
			hot: list.filter((x) => LakaInfra3DCapacity.worst(x.c) >= 0.8).length
		};
	}

	// ---------------------------------------------------------------- 3D

	/** Bloques translúcidos: huecos libres (verde) y lugares sugeridos por el planificador (color de acento). */
	build() {
		const s = this.scene;
		const THREE = s.THREE;
		const L = LakaInfra3DScene;
		const blocks = [];

		for (const rack of this.racks()) {
			for (const b of this.of(rack).blocks) {
				blocks.push({rack, b});
			}
		}

		const geo = new THREE.BoxGeometry(1, 1, 1);
		const mat = new THREE.MeshBasicMaterial({color: LakaInfra3DCapacity.OK, transparent: true, opacity: 0.22,
			depthWrite: false
		});
		const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, blocks.length));
		const m = new THREE.Matrix4();

		blocks.forEach(({rack, b}, i) => {
			const local = new THREE.Matrix4().compose(
				new THREE.Vector3(0, L.BASE + (b.u - 1) * L.UH + b.n * L.UH / 2, 0.01),
				new THREE.Quaternion(),
				new THREE.Vector3(rack.width - 0.16, b.n * L.UH - 0.006, L.DEP - 0.14)
			);

			mesh.setMatrixAt(i, m.multiplyMatrices(rack.frame.matrix, local));
		});

		mesh.count = blocks.length;
		mesh.visible = false;
		mesh.frustumCulled = false;
		mesh.renderOrder = 2;
		s.world.group.add(mesh);
		this.ghost = mesh;
		this.picks = null;
		this.labels = [];
	}

	/** Aplica o quita el modo Capacidad en la escena. */
	apply(on) {
		const s = this.scene;

		if (!s.world || !this.ghost) {
			return;
		}

		this.ghost.visible = on;

		if (this.picks) {
			this.picks.visible = on;
		}

		for (const label of this.labels) {
			s.world.group.remove(label);
			label.material.map.dispose();
			label.material.dispose();
		}

		this.labels = [];

		if (!on) {
			return;
		}

		const THREE = s.THREE;
		const L = LakaInfra3DScene;

		for (const rack of this.racks()) {
			const c = this.of(rack);

			s.world.bars.setColorAt(rack.barIndex, new THREE.Color(LakaInfra3DCapacity.color(LakaInfra3DCapacity.worst(c))));

			// Etiqueta sobre el rack: % de U y kW medidos/capacidad.
			const text = `${Math.round(c.ratioU * 100)}%${c.capW > 0 && c.load !== null ? ` · ${(c.load / 1000).toFixed(1)}/${(c.capW / 1000).toFixed(1)} kW` : ''}`;
			const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
				map: this.labelTex(text, LakaInfra3DCapacity.color(LakaInfra3DCapacity.worst(c))), transparent: true,
				depthTest: false
			}));

			sprite.scale.set(0.62, 0.115, 1);
			sprite.position.copy(new THREE.Vector3(0, rack.H + 0.42, L.DEP / 2 - 0.1).applyMatrix4(rack.frame.matrix));
			sprite.renderOrder = 3;
			s.world.group.add(sprite);
			this.labels.push(sprite);
		}

		s.world.bars.instanceColor.needsUpdate = true;
	}

	/** Etiqueta con barra de color (textura propia: cambia con cada lectura de energía). */
	labelTex(text, color) {
		const s = this.scene;
		const pal = s.palette();
		const canvas = document.createElement('canvas');

		canvas.width = 512;
		canvas.height = 96;

		const g = canvas.getContext('2d');

		g.fillStyle = pal.label;
		g.beginPath();

		if (g.roundRect) {
			g.roundRect(4, 10, 504, 76, 16);
		}
		else {
			g.rect(4, 10, 504, 76);
		}

		g.fill();
		g.fillStyle = color;
		g.fillRect(4, 10, 16, 76);
		g.fillStyle = pal.labelText;
		g.font = '700 40px Arial, sans-serif';
		g.textAlign = 'center';
		g.textBaseline = 'middle';
		g.fillText(text, 262, 50);

		const tex = new s.THREE.CanvasTexture(canvas);

		tex.colorSpace = s.THREE.SRGBColorSpace;

		return tex;
	}

	legendHtml() {
		const esc = LakaInfra3DScene.esc;
		const tot = this.totals();
		const pct = tot.units ? Math.round(tot.used / tot.units * 100) : 0;
		let html = `<span class="laka3d-chip"><i style="background:${LakaInfra3DCapacity.color(tot.units ? tot.used / tot.units : 0)}"></i>${esc(this.t('U libres'))} <strong>${tot.units - tot.used}/${tot.units}</strong> (${pct}%)</span>`;

		if (tot.capW > 0) {
			html += `<span class="laka3d-chip"><i style="background:${LakaInfra3DCapacity.color(tot.loadW / tot.capW)}"></i>${esc(this.t('Energía'))} <strong>${(tot.loadW / 1000).toFixed(1)}/${(tot.capW / 1000).toFixed(1)} kW</strong></span>`;
		}
		else if (tot.measuredW > 0) {
			html += `<span class="laka3d-chip"><i style="background:${LakaInfra3DCapacity.NONE}"></i>${esc(this.t('Energía medida'))} <strong>${(tot.measuredW / 1000).toFixed(1)} kW</strong></span>`;
		}

		html += `<span class="laka3d-chip"><i style="background:${tot.hot ? '#ffa059' : LakaInfra3DCapacity.OK}"></i>${esc(this.t('Racks al 80 % o más'))} <strong>${tot.hot}</strong></span>`;

		for (const [label, color] of [['< 60 %', LakaInfra3DCapacity.OK], ['60 – 80 %', '#ffc859'], ['80 – 95 %', '#ffa059'], ['≥ 95 %', '#e45959']]) {
			html += `<span class="laka3d-chip laka3d-chip-sm"><i style="background:${color}"></i>${label}</span>`;
		}

		html += `<button type="button" class="laka3d-chip laka3d-chip-btn laka3d-chip-plan" data-act="planner">${esc(this.t('¿Dónde entra?'))}</button>`;

		return html;
	}

	/** Bloque de capacidad para la ventana del rack. */
	rackHtml(rack) {
		const esc = LakaInfra3DScene.esc;
		const c = this.of(rack);
		const meter = (ratio) => `<div class="laka3d-meter"><b style="width:${Math.min(100, Math.round((ratio || 0) * 100))}%;background:${LakaInfra3DCapacity.color(ratio)}"></b></div>`;
		const kw = (w) => `${(w / 1000).toFixed(2)} kW`;
		let power;

		if (c.capW > 0) {
			power = `<strong>${c.load !== null ? kw(c.load) : '—'} / ${kw(c.capW)}</strong>${meter(c.ratioW)}`;
		}
		else {
			power = `<strong>${c.load !== null ? kw(c.load) : '—'}</strong><span class="laka3d-muted">${esc(this.t('Sin capacidad definida'))}</span>`;
		}

		const source = c.measured !== null
			? this.t('Medida en %1$s PDU', String(c.pdus))
			: (c.estW > 0 ? this.t('Estimada (consumo nominal)') : this.t('Sin PDU ni consumo nominal'));

		return `
			<h4>${esc(this.t('Capacidad'))}</h4>
			<div class="laka3d-kpis laka3d-kpis-cap">
				<div><span class="laka3d-muted">${esc(this.t('U libres'))}</span><strong>${c.free}/${c.units}</strong>${meter(c.ratioU)}<span class="laka3d-muted">${esc(this.t('Mayor hueco: %1$s U', String(c.largest)))}</span></div>
				<div><span class="laka3d-muted">${esc(this.t('Energía'))}</span>${power}<span class="laka3d-muted">${esc(source)}${c.measured !== null && c.estW > 0 ? ' · ' + esc(this.t('nominal')) + ' ' + kw(c.estW) : ''}</span></div>
				${rack.def.vpdu > 0 ? this.outletsHtml(rack, meter) : ''}
				${this.forecastRackHtml(rack.def.name)}
				<div><span class="laka3d-muted">${esc(this.t('Peso'))}</span><strong>${c.kg ? c.kg.toFixed(0) : 0}${c.maxKg ? ' / ' + c.maxKg : ''} kg</strong>${c.maxKg ? meter(c.ratioKg) : `<span class="laka3d-muted">${esc(this.t('Sin carga máxima definida'))}</span>`}</div>
			</div>`;
	}

	/**
	 * Tomas de las PDU verticales del rack frente a las que usan los equipos (estimado: dos fuentes por equipo
	 * activo; los pasivos, patch panels y PDU no se cuentan).
	 */
	outletsHtml(rack, meter) {
		const esc = LakaInfra3DScene.esc;
		const total = rack.def.vpdu * rack.def.outlets;
		const used = rack.devices.filter((dev) => !dev.d.passive && !['patch', 'pdu'].includes(dev.d.type)).length * 2;

		return `<div><span class="laka3d-muted">${esc(this.t('Tomas'))}</span><strong>≈ ${used} / ${total}</strong>${meter(total ? used / total : 0)}<span class="laka3d-muted">${esc(this.t('%1$s PDU verticales de %2$s tomas · estimado: 2 fuentes por equipo', String(rack.def.vpdu), String(rack.def.outlets)))}</span></div>`;
	}

	// ---------------------------------------------------------------- pronóstico (0.23.0)

	/** Racks con PDU medidas y su capacidad, para el pronóstico. */
	forecastRacks() {
		const devices = this.scene.data.devices || [];

		return this.racks().map((r) => {
			const ids = new Set((r.def.pdus || []).map(String));

			devices.filter((d) => d.rack === r.def.name && d.type === 'pdu' && !d.passive).forEach((d) => ids.add(String(d.id)));

			return {name: r.def.name, hostids: [...ids], cap_w: (r.def.power_kw || 0) * 1000};
		}).filter((r) => r.hostids.length);
	}

	async loadForecast(days) {
		const cfg = this.scene.data.cfg || {};

		if (!cfg.forecast_url) {
			return;
		}

		this.fcDays = days;
		this.fcLoading = true;
		this.renderPlanner();

		try {
			const body = new URLSearchParams({racks: JSON.stringify(this.forecastRacks()), pattern: cfg.power_key || '', days: String(days)});
			const response = await fetch(cfg.forecast_url, {method: 'POST',
				headers: {'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'}, body: body.toString()
			});
			const json = await response.json();

			this.forecast = json.success ? json : {error: true};
		}
		catch (error) {
			this.forecast = {error: true};
		}

		this.fcLoading = false;

		if (this.scene.panelState && this.scene.panelState.kind === 'planner') {
			this.renderPlanner();
		}
	}

	/** Texto del pronóstico de un rack o de la sala. */
	forecastText(f) {
		const t = this.t.bind(this);
		const kw = (w) => (w / 1000).toLocaleString(undefined, {maximumFractionDigits: 2});
		const when = (days) => days < 60 ? t('%1$s días', String(days)) : t('%1$s meses', String(Math.round(days / 30)));

		switch (f.status) {
			case 'growing':
				return t('Crece %1$s kW por mes: llega a su capacidad en %2$s.', kw(f.slope_w_month), when(f.eta_days));

			case 'full':
				return t('Ya está en su capacidad o por encima.');

			case 'stable':
				return t('Consumo estable o en baja: sin fecha de llenado.');

			case 'nocap':
				return t('Sin capacidad (kW) definida: crece %1$s kW por mes.', kw(f.slope_w_month || 0));

			case 'short':
				return t('Pocos días con datos para pronosticar.');

			default:
				return t('Sin datos de potencia en el período.');
		}
	}

	static forecastColor(f) {
		if (f.status === 'full' || (f.status === 'growing' && f.eta_days <= 90)) {
			return '#e45959';
		}

		return f.status === 'growing' && f.eta_days <= 365 ? '#ffa059' : (['nodata', 'short'].includes(f.status) ? '#97aab3' : '#59db8f');
	}

	forecastHtml() {
		const esc = LakaInfra3DScene.esc;
		const t = this.t.bind(this);
		const f = this.forecast;
		let body = '';

		if (this.fcLoading) {
			body = `<p class="laka3d-muted">${esc(t('Calculando con las tendencias de Zabbix…'))}</p>`;
		}
		else if (f && f.error) {
			body = `<p class="laka3d-dv-warn">${esc(t('No se pudieron leer las tendencias.'))}</p>`;
		}
		else if (f) {
			const order = (x) => x.status === 'full' ? -1 : (x.status === 'growing' ? x.eta_days : 1e9);
			const list = f.racks.slice().sort((a, b) => order(a) - order(b)).slice(0, 12);
			const max = Math.max(1, ...(f.room.series || []));

			body = `
				<div class="laka3d-fc-room"><i style="background:${LakaInfra3DCapacity.forecastColor(f.room)}"></i>
					<span><strong>${esc(t('Sala'))}</strong> · ${esc(f.room.current_w !== null ? (f.room.current_w / 1000).toFixed(1) + ' / ' + (f.room.cap_w / 1000).toFixed(1) + ' kW' : '—')}<br><span class="laka3d-muted">${esc(this.forecastText(f.room))}</span></span></div>
				${(f.room.series || []).length > 1 ? `<svg class="laka3d-pue-chart" viewBox="0 0 260 50" role="img" aria-label="${esc(t('kW de la sala por día'))}"><polyline fill="none" stroke="#4796c4" stroke-width="1.5" points="${f.room.series.map((v, i) => `${(i / (f.room.series.length - 1) * 260).toFixed(1)},${(48 - v / max * 44).toFixed(1)}`).join(' ')}"/></svg>` : ''}
				<div class="laka3d-list">${list.map((x) => `<button type="button" class="laka3d-row" data-act="fc-rack" data-rack="${esc(x.name)}"><i style="background:${LakaInfra3DCapacity.forecastColor(x)}"></i><span><strong>${esc(x.name)}</strong> · ${esc(x.current_w !== null ? (x.current_w / 1000).toFixed(2) + ' kW' : '—')}${x.cap_w ? ' / ' + esc((x.cap_w / 1000).toFixed(1)) + ' kW' : ''}<br><span class="laka3d-muted">${esc(this.forecastText(x))}</span></span></button>`).join('')}</div>`;
		}

		return `
			<h4>${esc(t('Pronóstico de energía'))}</h4>
			<p class="laka3d-muted">${esc(t('Proyección lineal de la potencia medida en las PDU de cada rack (promedio diario de las tendencias de Zabbix) hasta su capacidad en kW.'))}</p>
			<div class="laka3d-pw-form">${[90, 180, 365].map((d) => `<button type="button" class="laka3d-btn${f && !f.error && this.fcDays === d ? ' is-on' : ''}" data-act="fc-load" data-days="${d}">${esc(t('%1$s días', String(d)))}</button>`).join('')}</div>
			${body}`;
	}

	forecastRackHtml(name) {
		const f = this.forecast && !this.forecast.error ? this.forecast.racks.find((x) => x.name === name) : null;

		if (!f) {
			return '';
		}

		const esc = LakaInfra3DScene.esc;

		return `<div><span class="laka3d-muted">${esc(this.t('Pronóstico'))}</span><strong style="color:${LakaInfra3DCapacity.forecastColor(f)}">${esc(f.status === 'growing' ? (f.eta_days < 60 ? this.t('%1$s días', String(f.eta_days)) : this.t('%1$s meses', String(Math.round(f.eta_days / 30)))) : '—')}</strong><span class="laka3d-muted">${esc(this.forecastText(f))}</span></div>`;
	}

	// ---------------------------------------------------------------- planificador

	openPlanner() {
		const s = this.scene;

		if (s.mode !== 'capacity') {
			s.setMode('capacity');
		}

		s.panelState = {kind: 'planner', id: null};
		this.renderPlanner();
	}

	renderPlanner() {
		const s = this.scene;
		const esc = LakaInfra3DScene.esc;
		const p = this.plan;
		const res = this.results;

		const list = res === null ? ''
			: (res.length
				? res.slice(0, 30).map((r, i) => `<button type="button" class="laka3d-row laka3d-planrow" data-plan="${i}"><i style="background:${LakaInfra3DCapacity.color(r.after)}"></i><span><strong>${esc(r.rack.def.name)}</strong> · U${r.u}${p.n > 1 ? '–' + (r.u + p.n - 1) : ''}<br><span class="laka3d-muted">${esc(r.notes.join(' · '))}</span></span></button>`).join('')
				: `<p class="laka3d-muted">${esc(this.t('Ningún rack tiene lugar para ese equipo.'))}</p>`);

		s.panel.innerHTML = `
			<div class="laka3d-head"><span class="laka3d-dot" style="background:${LakaInfra3DCapacity.OK}"></span>
				<div class="laka3d-titles"><strong>${esc(this.t('¿Dónde entra?'))}</strong><span class="laka3d-muted">${esc(this.t('Busca racks con espacio, energía y peso para un equipo nuevo.'))}</span></div>
				<button type="button" class="laka3d-x" data-act="close" aria-label="${esc(this.t('Cerrar'))}">✕</button></div>
			<div class="laka3d-planform">
				<label>${esc(this.t('Alto (U)'))}<input type="number" min="1" max="20" value="${p.n}" data-plan-field="n"></label>
				<label>${esc(this.t('Consumo (W)'))}<input type="number" min="0" max="50000" step="50" value="${p.w}" data-plan-field="w"></label>
				<label>${esc(this.t('Peso (kg)'))}<input type="number" min="0" max="2000" step="1" value="${p.kg}" data-plan-field="kg"></label>
				<button type="button" class="laka3d-btn laka3d-btn-primary" data-act="plan-search">${esc(this.t('Buscar'))}</button>
			</div>
			${res !== null ? `<h4>${esc(this.t('Racks sugeridos'))} (${res.length})</h4>` : ''}
			<div class="laka3d-list">${list}</div>
			<p class="laka3d-muted">${esc(this.t('Se elige el hueco libre más bajo de cada rack (los equipos pesados van abajo). Los racks sin capacidad o carga máxima definida se aceptan y se marcan.'))}</p>
			${this.forecastHtml()}`;
		s.panel.hidden = false;
	}

	/**
	 * Racks donde entra el equipo: hueco libre suficiente (el más bajo), energía y peso disponibles.
	 * Orden: primero los que dejan más margen.
	 */
	search(render = true) {
		const p = this.plan;
		const out = [];

		for (const rack of this.racks()) {
			const c = this.of(rack);
			const block = c.blocks.find((b) => b.n >= p.n);

			if (!block) {
				continue;
			}

			const notes = [];
			let after = (c.used + p.n) / c.units;

			if (c.capW > 0) {
				const load = (c.load || 0) + p.w;

				if (load > c.capW) {
					continue;
				}

				after = Math.max(after, load / c.capW);
				notes.push(this.t('quedan %1$s kW', ((c.capW - load) / 1000).toFixed(1)));
			}
			else {
				notes.push(this.t('sin capacidad eléctrica definida'));
			}

			if (c.maxKg > 0) {
				const kg = c.kg + p.kg;

				if (kg > c.maxKg) {
					continue;
				}

				after = Math.max(after, kg / c.maxKg);
				notes.push(this.t('quedan %1$s kg', String(Math.round(c.maxKg - kg))));
			}

			notes.unshift(this.t('%1$s U libres', String(c.free - p.n)));
			out.push({rack, u: block.u, after, notes, known: c.capW > 0});
		}

		// Primero los racks con capacidad eléctrica conocida; dentro de cada grupo, los que dejan más margen.
		this.results = out.sort((a, b) => (b.known - a.known) || a.after - b.after);
		this.showPicks();

		if (this.picks) {
			this.picks.visible = this.scene.mode === 'capacity';
		}

		if (render) {
			this.renderPlanner();
		}
	}

	/** Dibuja en 3D los lugares sugeridos. */
	showPicks() {
		const s = this.scene;
		const THREE = s.THREE;
		const L = LakaInfra3DScene;

		if (this.picks) {
			s.world.group.remove(this.picks);
			this.picks.geometry.dispose();
			this.picks.material.dispose();
			this.picks.dispose();
			this.picks = null;
		}

		const res = (this.results || []).slice(0, 30);

		if (!res.length) {
			return;
		}

		const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1),
			new THREE.MeshBasicMaterial({color: '#4796c4', transparent: true, opacity: 0.65, depthWrite: false}), res.length
		);
		const m = new THREE.Matrix4();

		res.forEach((r, i) => {
			const local = new THREE.Matrix4().compose(
				new THREE.Vector3(0, L.BASE + (r.u - 1) * L.UH + this.plan.n * L.UH / 2, 0.02),
				new THREE.Quaternion(),
				new THREE.Vector3(r.rack.width - 0.14, this.plan.n * L.UH - 0.004, L.DEP - 0.1)
			);

			mesh.setMatrixAt(i, m.multiplyMatrices(r.rack.frame.matrix, local));
		});

		mesh.frustumCulled = false;
		mesh.renderOrder = 3;
		s.world.group.add(mesh);
		this.picks = mesh;
	}

	/** Clics dentro de la ventana del planificador. Devuelve true si los atendió. */
	panelClick(e) {
		const s = this.scene;
		const fc = e.target.closest('[data-act="fc-load"]');

		if (fc) {
			this.loadForecast(parseInt(fc.dataset.days, 10));

			return true;
		}

		const fr = e.target.closest('[data-act="fc-rack"]');

		if (fr) {
			s.openRack(fr.dataset.rack);

			return true;
		}

		if (e.target.closest('[data-act="plan-search"]')) {
			s.panel.querySelectorAll('[data-plan-field]').forEach((input) => {
				const v = parseFloat(input.value);
				const f = input.dataset.planField;

				this.plan[f] = f === 'n' ? Math.max(1, Math.min(20, Math.round(v) || 1)) : Math.max(0, v || 0);
			});
			this.search();

			return true;
		}

		const row = e.target.closest('[data-plan]');

		if (row && this.results) {
			const r = this.results[parseInt(row.dataset.plan, 10)];

			if (r) {
				// Vista del rack completo, como al abrir un rack, con el lugar sugerido resaltado.
				s.flyToFront(r.rack.frame, r.rack.center, 2.2, r.rack.H * 0.55);
			}

			return true;
		}

		return false;
	}

	/** Tras reconstruir la sala, los lugares sugeridos se recalculan con los racks nuevos. */
	rebuilt() {
		this.build();

		if (this.results) {
			this.search(false);
		}
	}
}
