/*
 * LAKA Infra 3D – gemelo digital de data center para Zabbix 7.0 – 8.0
 * © LAKA Soluciones Tecnológicas
 * Autor: Willian Tola
 * Licencia GPLv3
 *
 * Eficiencia energética y ambiente de la sala.
 * - PUE (ISO/IEC 30134-2): energía total de la instalación ÷ energía de TI. El valor instantáneo usa la
 *   potencia actual; el de período, las tendencias horarias de Zabbix (12 meses es el período de la norma).
 *   Categoría 1 si la TI se mide a la salida de las UPS, categoría 2 si se mide a la salida de las PDU.
 * - ASHRAE TC 9.9 (Thermal Guidelines, 5.ª ed. 2021): temperatura en la entrada de aire de los equipos;
 *   rango recomendado 18–27 °C (H1: 18–22 °C), rangos permitidos por clase A1–A4, punto de rocío
 *   recomendado de −9 a 15 °C y humedad relativa máxima de 60 % (70 % con contaminantes bajos).
 * - ISO/IEC 30134 (0.23.0): REF (parte 3, energía renovable ÷ energía total), ERF (parte 6, energía reutilizada
 *   ÷ energía total), WUE (parte 9, litros de agua ÷ kWh de TI) y CUE (parte 8, kg de CO₂ ÷ kWh de TI, con el
 *   factor de emisión de la red). Reporte anual mes a mes, el período que piden las normas y el reporte europeo.
 * - Enfriamiento líquido: clases de agua de la instalación W17, W27, W32, W40, W45 y W+ (ASHRAE TC 9.9,
 *   5.ª ed.), según la temperatura de suministro medida en las CDU y los intercambiadores de puerta trasera.
 */

class LakaInfra3DEnergy {

	static RECOMMENDED = {A1: [18, 27], A2: [18, 27], A3: [18, 27], A4: [18, 27], H1: [18, 22]};
	static ALLOWABLE = {A1: [15, 32], A2: [10, 35], A3: [5, 40], A4: [5, 45]};
	static DEW = [-9, 15];

	static COLORS = {rec: '#59db8f', allow: '#ffc859', out: '#e45959', none: '#768d99'};

	// Límite superior de la temperatura de suministro del agua de la instalación por clase (°C); el inferior es 2 °C.
	static WCLASS = {W17: 17, W27: 27, W32: 32, W40: 40, W45: 45, 'W+': Infinity};

	/**
	 * Indicadores ISO/IEC 30134 de un período (respuesta de energy.get) con la configuración de la sala.
	 * REF incluye la energía de la red comprada como renovable por contrato (porcentaje "green").
	 * CUE usa el factor de emisión (kg CO₂/kWh) sobre la energía de la red no renovable.
	 */
	static kpis(p, cfg) {
		const edc = p.total_all_kwh || p.total_kwh || 0;
		const eit = p.it_kwh || 0;
		const renew = Math.min(p.renew_kwh || 0, edc);
		const green = Math.max(0, Math.min(100, cfg.green || 0)) / 100;
		const grid = Math.max(0, edc - renew);
		const co2 = cfg.cef > 0 ? grid * (1 - green) * cfg.cef : null;

		return {
			ref: edc > 0 && (cfg.renew.length || green > 0) ? (renew + grid * green) / edc : null,
			erf: edc > 0 && cfg.reuse.length ? (p.reuse_kwh || 0) / edc : null,
			wue: eit > 0 && cfg.water.length ? (p.water_l || 0) / eit : null,
			co2,
			cue: eit > 0 && co2 !== null ? co2 / eit : null
		};
	}

	/** Punto de rocío (°C) con la fórmula de Magnus. */
	static dewPoint(t, rh) {
		if (!isFinite(t) || !isFinite(rh) || rh <= 0) {
			return null;
		}

		const a = 17.62;
		const b = 243.12;
		const g = Math.log(Math.min(rh, 100) / 100) + a * t / (b + t);

		return Math.round(b * g / (a - g) * 10) / 10;
	}

	/** Banda ASHRAE de una temperatura de entrada: recomendada, permitida o fuera. */
	static band(t, cls) {
		const [r0, r1] = LakaInfra3DEnergy.RECOMMENDED[cls] || LakaInfra3DEnergy.RECOMMENDED.A1;
		const allow = LakaInfra3DEnergy.ALLOWABLE[cls];

		if (t >= r0 && t <= r1) {
			return 'rec';
		}

		return allow && t >= allow[0] && t <= allow[1] ? 'allow' : 'out';
	}

	/** Potencia en W según la unidad del ítem (W, kW, MW; VA y kVA como W). */
	static watts(value, units) {
		const f = {'': 1, w: 1, va: 1, kw: 1000, kva: 1000, mw: 1e6}[String(units || '').trim().toLowerCase()];

		return f !== undefined && value !== null && value !== undefined && isFinite(value) ? value * f : null;
	}

	constructor(scene) {
		this.scene = scene;
		this.days = 7;
		this.period = null;
		this.loading = false;
	}

	t(...args) {
		return this.scene.t(...args);
	}

	get cfg() {
		return Object.assign({total: [], it: 'pdu', it_objs: [], ashrae: 'A1', rh: 60, renew: [], reuse: [], water: [], cef: 0,
			green: 0, wclass: '', cool_n: 0, isp_n: 0, space: 'dc'}, (this.scene.data.cfg || {}).energy || {});
	}

	objects() {
		return this.scene.data.objects || [];
	}

	// ================================================================ PUE

	/** Potencias actuales y PUE instantáneo. */
	current() {
		const cfg = this.cfg;
		const byId = new Map(this.objects().map((o) => [o.id, o]));
		const sum = (ids) => {
			let w = 0;
			let read = 0;

			for (const id of ids) {
				const o = byId.get(id);
				const v = o ? LakaInfra3DEnergy.watts(o.value, o.units) : null;

				if (v !== null) {
					w += v;
					read++;
				}
			}

			return {w, read, of: ids.length};
		};
		const total = sum(cfg.total);
		let it;

		if (cfg.it === 'ups') {
			it = sum(cfg.it_objs);
		}
		else {
			const racks = (this.scene.data.racks || []).filter((r) => (r.kind || 'rack') === 'rack');
			const read = racks.filter((r) => r.power_w !== null && r.power_w !== undefined);

			it = {w: read.reduce((a, r) => a + r.power_w, 0), read: read.length, of: racks.filter((r) => (r.pdu_count || 0) > 0).length};
		}

		const pue = total.read && it.w > 0 && total.w >= it.w ? total.w / it.w : null;

		return {total, it, pue, category: cfg.it === 'ups' ? 1 : 2, configured: cfg.total.length > 0};
	}

	/** Fuentes para el PUE por período: [{hostid, pattern}] de cada lado. */
	sources() {
		const cfg = this.cfg;
		const byId = new Map(this.objects().map((o) => [o.id, o]));
		const obj = (ids) => ids.map((id) => byId.get(id)).filter((o) => o && o.hostid)
			.map((o) => ({hostid: String(o.hostid), pattern: o.pattern || o.key}));
		let it = [];

		if (cfg.it === 'ups') {
			it = obj(cfg.it_objs);
		}
		else {
			const pattern = (this.scene.data.cfg || {}).power_key || '';
			const ids = new Set();

			for (const r of this.scene.data.racks || []) {
				(r.pdus || []).forEach((id) => ids.add(String(id)));
			}

			for (const d of this.scene.data.devices || []) {
				if (d.type === 'pdu' && !d.passive) {
					ids.add(String(d.id));
				}
			}

			it = [...ids].map((hostid) => ({hostid, pattern}));
		}

		return {total: obj(cfg.total), it, renew: obj(cfg.renew), reuse: obj(cfg.reuse), water: obj(cfg.water)};
	}

	async loadPeriod(days, then = null) {
		const url = (this.scene.data.cfg || {}).energy_url;

		if (!url) {
			return;
		}

		this.days = days;
		this.loading = true;
		this.scene.refreshPanel();

		const src = this.sources();
		const body = new URLSearchParams({total: JSON.stringify(src.total), it: JSON.stringify(src.it),
			renew: JSON.stringify(src.renew), reuse: JSON.stringify(src.reuse), water: JSON.stringify(src.water), days: String(days)});

		try {
			const response = await fetch(url, {method: 'POST',
				headers: {'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'}, body: body.toString()
			});
			const json = await response.json();

			this.period = json.success ? json : {error: true};
		}
		catch (error) {
			this.period = {error: true};
		}

		this.loading = false;
		this.scene.refreshPanel();

		if (then && this.period && !this.period.error) {
			then();
		}
	}

	/** Bloque PUE de la ventana de Energía. */
	pueHtml() {
		const esc = LakaInfra3DScene.esc;
		const t = this.t.bind(this);
		const c = this.current();
		const kw = (w) => (w / 1000).toLocaleString(undefined, {maximumFractionDigits: 1});

		if (!c.configured) {
			return `
				<h4>${esc(t('Eficiencia (PUE)'))}</h4>
				<p class="laka3d-muted">${esc(t('Sin medidor de energía total. En el editor, pestaña Sala → "Eficiencia y ambiente", elige qué elementos miden la energía total (acometida, tablero general).'))}</p>`;
		}

		const color = c.pue === null ? '#768d99' : (c.pue <= 1.5 ? '#59db8f' : (c.pue <= 2 ? '#ffc859' : '#e45959'));
		const p = this.period;
		let period = '';

		if (this.loading) {
			period = `<p class="laka3d-muted">${esc(t('Calculando con las tendencias de Zabbix…'))}</p>`;
		}
		else if (p && p.error) {
			period = `<p class="laka3d-dv-warn">${esc(t('No se pudieron leer las tendencias.'))}</p>`;
		}
		else if (p) {
			const max = Math.max(1.0, ...p.days.map((d) => d.pue || 0));
			const w = 260;
			const bw = p.days.length ? Math.max(2, Math.floor(w / p.days.length) - 1) : 0;

			period = `
				<div class="laka3d-kpis">
					<div><span class="laka3d-muted">${esc(t('PUE del período'))}</span><strong>${p.pue !== null ? p.pue.toFixed(2) : '—'}</strong></div>
					<div><span class="laka3d-muted">${esc(t('Energía total'))}</span><strong>${esc(p.total_kwh.toLocaleString())} kWh</strong></div>
					<div><span class="laka3d-muted">${esc(t('Energía de TI'))}</span><strong>${esc(p.it_kwh.toLocaleString())} kWh</strong></div>
				</div>
				${p.days.length ? `<svg class="laka3d-pue-chart" viewBox="0 0 ${w} 60" role="img" aria-label="${esc(t('PUE por día'))}">
					${p.days.map((d, i) => d.pue ? `<rect x="${i * (bw + 1)}" y="${60 - Math.round(d.pue / max * 56)}" width="${bw}" height="${Math.round(d.pue / max * 56)}" fill="${d.pue <= 1.5 ? '#59db8f' : (d.pue <= 2 ? '#ffc859' : '#e45959')}"><title>${esc(d.day)} · PUE ${d.pue.toFixed(2)}</title></rect>` : '').join('')}
				</svg>` : ''}
				<p class="laka3d-muted">${esc(t('%1$s horas con medición de los dos lados.', String(p.hours)))}${this.days >= 365 ? ` ${esc(t('Período anual: el que pide ISO/IEC 30134-2 para informar el PUE.'))}` : ''}</p>
				${this.kpiHtml(p)}`;
		}

		return `
			<h4>${esc(t('Eficiencia (PUE)'))}</h4>
			<div class="laka3d-pue">
				<div class="laka3d-pue-big" style="--pue:${color}"><strong>${c.pue !== null ? c.pue.toFixed(2) : '—'}</strong><span>${esc(t('PUE ahora'))}</span></div>
				<div class="laka3d-pue-detail">
					<span>${esc(t('Total'))}: <strong>${c.total.read ? kw(c.total.w) + ' kW' : '—'}</strong></span>
					<span>${esc(t('TI'))}: <strong>${c.it.read ? kw(c.it.w) + ' kW' : '—'}</strong></span>
					<span>${esc(t('Infraestructura'))}: <strong>${c.pue !== null ? kw(c.total.w - c.it.w) + ' kW' : '—'}</strong></span>
					<span>DCiE: <strong>${c.pue !== null ? Math.round(100 / c.pue) + ' %' : '—'}</strong></span>
				</div>
			</div>
			<p class="laka3d-muted">${esc(t('ISO/IEC 30134-2, categoría %1$s (TI medida a la salida de %2$s).', String(c.category), c.category === 1 ? t('las UPS') : t('las PDU')))}
				${c.it.of && c.it.read < c.it.of ? esc(t('Faltan lecturas de TI: %1$s de %2$s.', String(c.it.read), String(c.it.of))) : ''}</p>
			<div class="laka3d-pw-form">
				${[[1, t('24 h')], [7, t('7 días')], [30, t('30 días')], [365, t('12 meses')]].map(([d, l]) => `<button type="button" class="laka3d-btn${p && this.days === d ? ' is-on' : ''}" data-en="period" data-days="${d}">${esc(l)}</button>`).join('')}
			</div>
			${period}
			<div class="laka3d-pw-form"><button type="button" class="laka3d-btn" data-en="annual">${esc(t('Reporte anual de eficiencia'))}</button></div>`;
	}

	/** Fila de indicadores ISO/IEC 30134 del período (REF, ERF, WUE, CUE). */
	kpiHtml(p) {
		const esc = LakaInfra3DScene.esc;
		const t = this.t.bind(this);
		const k = LakaInfra3DEnergy.kpis(p, this.cfg);
		const pct = (v) => v === null ? '—' : `${(v * 100).toLocaleString(undefined, {maximumFractionDigits: 1})} %`;
		const num = (v, d) => v === null ? '—' : v.toLocaleString(undefined, {maximumFractionDigits: d});

		return `
			<div class="laka3d-kpis laka3d-kpis-iso">
				<div title="${esc(t('Energía renovable ÷ energía total (ISO/IEC 30134-3)'))}"><span class="laka3d-muted">REF</span><strong>${pct(k.ref)}</strong></div>
				<div title="${esc(t('Energía reutilizada ÷ energía total (ISO/IEC 30134-6)'))}"><span class="laka3d-muted">ERF</span><strong>${pct(k.erf)}</strong></div>
				<div title="${esc(t('Litros de agua ÷ kWh de TI (ISO/IEC 30134-9)'))}"><span class="laka3d-muted">WUE</span><strong>${num(k.wue, 2)}${k.wue !== null ? ' L/kWh' : ''}</strong></div>
				<div title="${esc(t('kg de CO₂ ÷ kWh de TI (ISO/IEC 30134-8)'))}"><span class="laka3d-muted">CUE</span><strong>${num(k.cue, 3)}${k.cue !== null ? ' kg/kWh' : ''}</strong></div>
			</div>
			${[k.ref, k.erf, k.wue, k.cue].includes(null) ? `<p class="laka3d-muted">${esc(t('Los indicadores en "—" necesitan su medidor o dato en el editor (Sala → Eficiencia y ambiente): generación renovable, energía reutilizada, medidor de agua y factor de emisión de la red.'))}</p>` : ''}`;
	}

	/** Reporte anual mes a mes (abre una ventana imprimible; si el período cargado no es de 12 meses, lo pide). */
	annualReport() {
		if (!this.period || this.period.error || this.days < 365) {
			this.loadPeriod(365, () => this.annualReport());

			return;
		}

		const t = this.t.bind(this);
		const esc = LakaInfra3DScene.esc;
		const cfg = this.cfg;
		const p = this.period;
		const s = this.scene;
		const n = (v, d = 0) => v === null || v === undefined ? '—' : Number(v).toLocaleString(undefined, {maximumFractionDigits: d});
		const pct = (v) => v === null ? '—' : `${(v * 100).toLocaleString(undefined, {maximumFractionDigits: 1})} %`;
		const rows = p.months.map((m) => ({m, k: LakaInfra3DEnergy.kpis(m, cfg)}));
		const year = {k: LakaInfra3DEnergy.kpis(p, cfg)};
		const cols = [t('Mes'), t('Energía total (kWh)'), t('Energía de TI (kWh)'), 'PUE', t('Renovable (kWh)'), 'REF',
			t('Reutilizada (kWh)'), 'ERF', t('Agua (m³)'), 'WUE (L/kWh)', t('CO₂ (t)'), 'CUE (kg/kWh)'];
		const line = (label, d, k) => [label, n(d.total_all_kwh || d.total_kwh), n(d.it_kwh), d.pue !== null ? Number(d.pue).toFixed(2) : '—',
			n(d.renew_kwh), pct(k.ref), n(d.reuse_kwh), pct(k.erf), n((d.water_l || 0) / 1000, 1), n(k.wue, 2),
			k.co2 !== null ? n(k.co2 / 1000, 2) : '—', n(k.cue, 3)];
		const body = rows.map(({m, k}) => line(m.month, m, k));
		const total = line(t('12 meses'), p, year.k);
		const site = [(s.data.cfg || {}).site, s.roomName()].filter(Boolean).join(' · ');

		this.annualCsv = [cols, ...body, total];

		const html = `<!DOCTYPE html><html lang="${esc(s.data.lang || 'es')}"><head><meta charset="utf-8">
<title>${esc(t('Reporte anual de eficiencia'))} · LAKA Infra 3D</title>
<style>
@page { size: A4 landscape; margin: 12mm; }
body { font-family: Arial, Helvetica, sans-serif; color: #1f2c33; margin: 0; padding: 14mm; font-size: 10pt; }
h1 { font-size: 16pt; margin: 0 0 4px; } .sub { color: #555; margin-bottom: 12px; }
.bar { display: flex; gap: 8px; margin-bottom: 12px; } .bar button { padding: 6px 14px; cursor: pointer; }
.kpis { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0 14px; }
.kpis div { border: 1px solid #ccd5d9; border-radius: 6px; padding: 6px 12px; min-width: 110px; }
.kpis span { display: block; color: #555; font-size: 8.5pt; } .kpis strong { font-size: 14pt; }
table { border-collapse: collapse; width: 100%; } th, td { border-bottom: 1px solid #dfe4e7; padding: 4px 6px; text-align: right; }
th:first-child, td:first-child { text-align: left; } thead th { background: #f2f5f7; } tfoot td { font-weight: bold; border-top: 2px solid #1f2c33; }
.note { color: #555; font-size: 8.5pt; margin-top: 10px; line-height: 1.4; } .foot { margin-top: 14px; font-size: 8pt; color: #777; }
@media print { .bar { display: none; } body { padding: 0; } }
</style></head><body>
<div class="bar"><button type="button" data-print>${esc(t('Imprimir'))}</button><button type="button" data-csv>CSV</button></div>
<h1>${esc(t('Reporte anual de eficiencia'))}</h1>
<div class="sub">${esc(site)} · ${esc(t('Últimos 12 meses'))} · ${esc(new Date().toLocaleDateString())}</div>
<div class="kpis">
	<div><span>PUE</span><strong>${p.pue !== null ? p.pue.toFixed(2) : '—'}</strong></div>
	<div><span>REF</span><strong>${pct(year.k.ref)}</strong></div>
	<div><span>ERF</span><strong>${pct(year.k.erf)}</strong></div>
	<div><span>WUE</span><strong>${n(year.k.wue, 2)}</strong></div>
	<div><span>CUE</span><strong>${n(year.k.cue, 3)}</strong></div>
	<div><span>${esc(t('Energía total'))}</span><strong>${n((p.total_all_kwh || p.total_kwh) / 1000, 1)} MWh</strong></div>
</div>
<table><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
<tbody>${body.map((r) => `<tr>${r.map((v) => `<td>${esc(v)}</td>`).join('')}</tr>`).join('')}</tbody>
<tfoot><tr>${total.map((v) => `<td>${esc(v)}</td>`).join('')}</tr></tfoot></table>
<p class="note">${esc(t('ISO/IEC 30134-2 (PUE), -3 (REF), -6 (ERF), -8 (CUE) y -9 (WUE). Energía y agua calculadas con las tendencias horarias de Zabbix. Categoría de medición de TI: %1$s. Factor de emisión de la red: %2$s kg CO₂/kWh; energía de la red comprada como renovable: %3$s %. Estos indicadores coinciden con los que pide el reporte europeo de data centers (Reglamento Delegado UE 2024/1364).', cfg.it === 'ups' ? '1 (UPS)' : '2 (PDU)', cfg.cef ? String(cfg.cef) : '—', String(cfg.green || 0)))}</p>
<div class="foot">LAKA Infra 3D · © LAKA Soluciones Tecnológicas</div>
</body></html>`;

		const w = window.open('', '_blank');

		if (!w) {
			s.report && s.report.download('laka-infra3d-reporte-anual-eficiencia.html', html, 'text/html;charset=utf-8');

			return;
		}

		w.document.open();
		w.document.write(html);
		w.document.close();

		const bind = () => {
			const pb = w.document.querySelector('[data-print]');
			const cb = w.document.querySelector('[data-csv]');

			pb && pb.addEventListener('click', () => w.print());
			cb && cb.addEventListener('click', () => this.annualCsvDownload());
		};

		w.document.readyState === 'loading' ? w.addEventListener('DOMContentLoaded', bind) : bind();
	}

	annualCsvDownload() {
		const csv = '\uFEFF' + (this.annualCsv || []).map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(';')).join('\r\n');

		this.scene.report && this.scene.report.download(`laka-infra3d-eficiencia-anual-${new Date().toISOString().slice(0, 10)}.csv`, csv);
	}

	// ================================================================ ASHRAE

	/** Lecturas de temperatura y humedad: entradas (frente del rack), salidas (atrás) y ambiente. */
	readings() {
		const out = [];

		for (const o of this.objects()) {
			if (o.kind !== 'sensor' || o.value === null || o.value === undefined || o.units !== '°C') {
				continue;
			}

			const place = o.mount === 'rack' || o.rack ? (o.face === 'back' ? 'outlet' : 'inlet') : 'room';
			const dew = o.hum !== null && o.hum !== undefined ? LakaInfra3DEnergy.dewPoint(o.value, o.hum) : null;

			out.push({o, t: o.value, rh: o.hum ?? null, dew, place, rack: o.rack || ''});
		}

		return out;
	}

	/** Resumen ASHRAE de la sala. */
	ashrae() {
		const cfg = this.cfg;
		const r = this.readings();
		const inlets = r.filter((x) => x.place === 'inlet');
		const racks = (this.scene.data.racks || []).filter((x) => (x.kind || 'rack') === 'rack');
		const byRack = new Map();

		for (const x of inlets) {
			const prev = byRack.get(x.rack);

			if (!prev || x.t > prev.t) {
				byRack.set(x.rack, x);
			}
		}

		const bands = {rec: 0, allow: 0, out: 0, none: racks.filter((x) => !byRack.has(x.name)).length};

		for (const x of byRack.values()) {
			bands[LakaInfra3DEnergy.band(x.t, cfg.ashrae)]++;
		}

		// Diferencia de temperatura entrada / salida por rack (ΔT).
		const delta = [];

		for (const [rack, inlet] of byRack) {
			const outs = r.filter((x) => x.place === 'outlet' && x.rack === rack);

			if (outs.length) {
				delta.push({rack, dt: Math.round((Math.max(...outs.map((x) => x.t)) - inlet.t) * 10) / 10});
			}
		}

		const humid = r.filter((x) => x.rh !== null);
		const dewBad = humid.filter((x) => x.dew !== null && (x.dew < LakaInfra3DEnergy.DEW[0] || x.dew > LakaInfra3DEnergy.DEW[1]));
		const rhBad = humid.filter((x) => x.rh > cfg.rh);

		return {cfg, readings: r, inlets, byRack, bands, delta, humid, dewBad, rhBad, racks};
	}

	openAmbient() {
		const s = this.scene;

		s.panelState = {kind: 'ambient', id: null};
		this.renderAmbient();
		s.panel.hidden = false;
	}

	renderAmbient() {
		const s = this.scene;
		const esc = LakaInfra3DScene.esc;
		const t = this.t.bind(this);
		const a = this.ashrae();
		const [r0, r1] = LakaInfra3DEnergy.RECOMMENDED[a.cfg.ashrae];
		const allow = LakaInfra3DEnergy.ALLOWABLE[a.cfg.ashrae];
		const C = LakaInfra3DEnergy.COLORS;
		const hottest = [...a.byRack.values()].sort((x, y) => y.t - x.t).slice(0, 8);
		const chip = (band) => `<span class="laka3d-pw-st" style="background:${C[band]}"></span>`;

		s.panel.innerHTML = `
			${s.crumbs([{t: s.roomName(), go: 'room'}, {t: t('Ambiente')}])}
			<div class="laka3d-head"><span class="laka3d-dot" style="background:${C.rec}"></span>
				<div class="laka3d-titles"><strong>${esc(t('Ambiente según ASHRAE'))}</strong><span class="laka3d-muted">${esc(t('TC 9.9 · clase %1$s · recomendado %2$s–%3$s °C en la entrada', a.cfg.ashrae, String(r0), String(r1)))}</span></div>
				<button type="button" class="laka3d-x" data-act="close" aria-label="${esc(t('Cerrar'))}">✕</button></div>
			<div class="laka3d-kpis">
				<div><span class="laka3d-muted">${esc(t('Recomendado'))}</span><strong style="color:${C.rec}">${a.bands.rec}</strong></div>
				<div><span class="laka3d-muted">${esc(t('Permitido'))}</span><strong style="color:${C.allow}">${a.bands.allow}</strong></div>
				<div><span class="laka3d-muted">${esc(t('Fuera'))}</span><strong style="color:${C.out}">${a.bands.out}</strong></div>
			</div>
			<p class="laka3d-muted">${esc(t('Racks según la temperatura más alta medida en su entrada de aire (sensores al frente del rack).'))}
				${a.bands.none ? esc(t('%1$s racks sin sensor de entrada.', String(a.bands.none))) : ''}
				${allow ? esc(t('Permitido para %1$s: %2$s–%3$s °C.', a.cfg.ashrae, String(allow[0]), String(allow[1]))) : ''}</p>
			${hottest.length ? `<h4>${esc(t('Entradas más calientes'))}</h4>
				<ul class="laka3d-amb-list">${hottest.map((x) => `<li>${chip(LakaInfra3DEnergy.band(x.t, a.cfg.ashrae))}<strong>${esc(x.rack)}</strong> ${esc(x.o.name || '')} <span>${x.t.toFixed(1)} °C</span></li>`).join('')}</ul>` : ''}
			${a.delta.length ? `<h4>${esc(t('Diferencia entrada / salida (ΔT)'))}</h4>
				<ul class="laka3d-amb-list">${a.delta.sort((x, y) => y.dt - x.dt).slice(0, 8).map((x) => `<li><strong>${esc(x.rack)}</strong> <span>${x.dt > 0 ? '+' : ''}${x.dt.toFixed(1)} °C</span></li>`).join('')}</ul>` : ''}
			<h4>${esc(t('Humedad y punto de rocío'))}</h4>
			${a.humid.length ? `<ul class="laka3d-amb-list">${a.humid.map((x) => {
				const bad = (x.dew !== null && (x.dew < LakaInfra3DEnergy.DEW[0] || x.dew > LakaInfra3DEnergy.DEW[1])) || x.rh > a.cfg.rh;

				return `<li>${chip(bad ? 'allow' : 'rec')}${esc(x.o.name || '')} <span>${x.rh.toFixed(0)} % · ${esc(t('rocío'))} ${x.dew !== null ? x.dew.toFixed(1) + ' °C' : '—'}</span></li>`;
			}).join('')}</ul>
				<p class="laka3d-muted">${esc(t('Recomendado: punto de rocío de −9 a 15 °C y humedad hasta %1$s %.', String(a.cfg.rh)))}</p>`
				: `<p class="laka3d-muted">${esc(t('Sin lecturas de humedad: configura la clave de humedad en el widget y vincula los sensores.'))}</p>`}
			${this.liquidHtml()}`;
	}

	/** Enfriamiento líquido: lecturas de las CDU e intercambiadores frente a la clase W de la instalación. */
	liquid() {
		const cfg = this.cfg;
		const limit = LakaInfra3DEnergy.WCLASS[cfg.wclass];
		const units = this.objects().filter((o) => ['cdu', 'rdhx'].includes(o.kind));

		return units.map((o) => {
			const ok = o.value !== null && o.value !== undefined && o.units === '°C';
			const state = !ok ? 'none' : (o.value < 2 ? 'out' : (limit === undefined || o.value <= limit ? 'rec' : 'out'));

			return {o, t: ok ? o.value : null, state};
		});
	}

	liquidHtml() {
		const esc = LakaInfra3DScene.esc;
		const t = this.t.bind(this);
		const list = this.liquid();
		const cls = this.cfg.wclass;
		const C = LakaInfra3DEnergy.COLORS;

		if (!list.length) {
			return '';
		}

		return `
			<h4>${esc(t('Enfriamiento líquido'))}</h4>
			<p class="laka3d-muted">${esc(cls ? t('Clase de agua de la instalación %1$s (ASHRAE): suministro de 2 a %2$s °C.', cls, cls === 'W+' ? '>45' : String(LakaInfra3DEnergy.WCLASS[cls])) : t('Sin clase W definida: elige la clase de agua de la instalación en el editor (Sala → Eficiencia y ambiente).'))}</p>
			<ul class="laka3d-amb-list">${list.map((x) => `<li><span class="laka3d-pw-st" style="background:${C[x.state]}"></span><strong>${esc(x.o.name || this.scene.kindName(x.o.kind))}</strong> ${esc(this.scene.kindName(x.o.kind))} <span>${x.t !== null ? x.t.toFixed(1) + ' °C' : '—'}</span></li>`).join('')}</ul>`;
	}

	/** Leyenda del modo Calor con las bandas ASHRAE. */
	legendHtml() {
		const esc = LakaInfra3DScene.esc;
		const a = this.ashrae();
		const C = LakaInfra3DEnergy.COLORS;
		const names = {rec: 'Recomendado', allow: 'Permitido', out: 'Fuera', none: 'Sin sensor'};

		return `<span class="laka3d-chip">ASHRAE ${esc(a.cfg.ashrae)}</span>`
			+ ['rec', 'allow', 'out', 'none'].map((k) => `<span class="laka3d-chip"><i style="background:${C[k]}"></i>${esc(this.t(names[k]))} <strong>${a.bands[k]}</strong></span>`).join('');
	}

	panelClick(e) {
		if (e.target.closest('[data-en="annual"]')) {
			this.annualReport();

			return true;
		}

		const btn = e.target.closest('[data-en="period"]');

		if (!btn) {
			return false;
		}

		this.loadPeriod(parseInt(btn.dataset.days, 10));

		return true;
	}
}
