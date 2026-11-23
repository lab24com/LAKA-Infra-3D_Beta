/*
 * LAKA Infra 3D – gemelo digital de data center para Zabbix 7.0 – 8.0
 * © LAKA Soluciones Tecnológicas
 * Autor: Willian Tola
 * Licencia GPLv3
 *
 * Reportes de estado: del data center (resumen ejecutivo, problemas activos, estado de cada rack,
 * infraestructura de sala, cableado y normas, con el detalle de cada rack si se elige) y de un rack
 * (indicadores, elevación del frente y de atrás, equipos, problemas y cableado).
 * Se abren en una ventana lista para imprimir o guardar como PDF desde el navegador, y los datos se
 * pueden descargar en CSV. Todo sale de lo que ya muestra el widget (datos de Zabbix del último refresco).
 */

class LakaInfra3DReport {

	constructor(scene) {
		this.scene = scene;
		this.el = null;
		this.opts = {scope: 'dc', rack: '', detail: true, elev: true, devices: true, problems: true, infra: true,
			cabling: true, norms: true};
	}

	t(...args) {
		return this.scene.t(...args);
	}

	get data() {
		return this.scene.data;
	}

	// ================================================================ ventana de opciones

	open(rackName = null) {
		const s = this.scene;

		if (!s.world || (s.noc && s.noc.active)) {
			return;
		}

		if (rackName) {
			this.opts.scope = 'rack';
			this.opts.rack = rackName;
		}

		if (!this.el) {
			this.el = document.createElement('div');
			this.el.className = 'laka3d-msp-overlay laka3d-rp-overlay';
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
		this.render();
		this.el.querySelector('.laka3d-msp').focus();
	}

	close() {
		if (this.el) {
			this.el.hidden = true;
		}
	}

	racks() {
		return [...this.scene.world.racks.entries()].filter(([, r]) => !r.cooler);
	}

	render() {
		const esc = LakaInfra3DScene.esc;
		const t = this.t.bind(this);
		const o = this.opts;
		const racks = this.racks();

		if (!o.rack || !this.scene.world.racks.has(o.rack)) {
			o.rack = racks.length ? racks[0][0] : '';
		}

		const check = (k, label, disabled = false) => `<label class="laka3d-rp-check"><input type="checkbox" data-rp="${k}"${o[k] ? ' checked' : ''}${disabled ? ' disabled' : ''}> ${esc(t(label))}</label>`;
		const hasNorms = !!this.data.editor;

		this.el.innerHTML = `
			<div class="laka3d-msp laka3d-rp" role="dialog" aria-modal="true" tabindex="-1" aria-label="${esc(t('Reportes'))}">
				<div class="laka3d-msp-head">
					<strong>${esc(t('Reportes'))}</strong>
					<button type="button" class="laka3d-msp-x" data-rpa="close" aria-label="${esc(t('Cerrar'))}">✕</button>
				</div>
				<div class="laka3d-rp-body">
					<fieldset>
						<legend>${esc(t('Tipo de reporte'))}</legend>
						<label class="laka3d-rp-check"><input type="radio" name="laka3d-rp-scope" data-rp="scope" value="dc"${o.scope === 'dc' ? ' checked' : ''}> <span><strong>${esc(t('Estado del data center'))}</strong><br><span class="laka3d-muted">${esc(t('Resumen ejecutivo, problemas activos, estado de cada rack, infraestructura de sala, cableado y normas.'))}</span></span></label>
						<label class="laka3d-rp-check"><input type="radio" name="laka3d-rp-scope" data-rp="scope" value="rack"${o.scope === 'rack' ? ' checked' : ''}> <span><strong>${esc(t('Estado de un rack'))}</strong><br><span class="laka3d-muted">${esc(t('Indicadores, elevación, equipos, problemas y cableado del rack.'))}</span></span></label>
						${o.scope === 'rack' ? `<label class="laka3d-rp-rack">${esc(t('Rack'))} <select data-rp="rack">${racks.map(([n, r]) => `<option value="${esc(n)}"${n === o.rack ? ' selected' : ''}>${esc(n)} · ${esc(LakaInfra3DScene.rackWhere(r.def, t))}</option>`).join('')}</select></label>` : ''}
					</fieldset>
					<fieldset>
						<legend>${esc(t('Incluir'))}</legend>
						${o.scope === 'dc' ? check('detail', 'Detalle de cada rack') : ''}
						${check('elev', 'Elevación de los racks (frente y atrás)', o.scope === 'dc' && !o.detail)}
						${check('devices', 'Lista de equipos')}
						${check('problems', 'Problemas activos')}
						${o.scope === 'dc' ? check('infra', 'Infraestructura de sala (climatización, energía, seguridad, incendio y ambiente)') : ''}
						${check('cabling', 'Cableado')}
						${check('norms', 'Revisión de normas', !hasNorms)}
						${hasNorms ? '' : `<p class="laka3d-muted">${esc(t('La revisión de normas solo está disponible para usuarios que pueden editar la sala.'))}</p>`}
					</fieldset>
					<p class="laka3d-muted">${esc(t('El reporte se abre en una ventana nueva. Usa "Imprimir o guardar PDF" para guardarlo como PDF. Muestra los datos de Zabbix del último refresco del widget.'))}</p>
				</div>
				<div class="laka3d-msp-foot laka3d-rp-foot">
					<button type="button" class="laka3d-btn" data-rpa="csv-devices">${esc(t('CSV de equipos'))}</button>
					<button type="button" class="laka3d-btn" data-rpa="csv-racks">${esc(t('CSV de racks'))}</button>
					<button type="button" class="laka3d-btn laka3d-btn-primary" data-rpa="open">${esc(t('Ver reporte'))}</button>
				</div>
			</div>`;
	}

	click(e) {
		if (e.target === this.el) {
			this.close();

			return;
		}

		const btn = e.target.closest('[data-rpa]');

		if (!btn) {
			return;
		}

		switch (btn.dataset.rpa) {
			case 'close':
				this.close();
				break;

			case 'open':
				this.show();
				break;

			case 'csv-devices':
				this.download(`laka-infra3d-equipos-${this.fileStamp()}.csv`, this.csvDevices());
				break;

			case 'csv-racks':
				this.download(`laka-infra3d-racks-${this.fileStamp()}.csv`, this.csvRacks());
				break;
		}
	}

	change(e) {
		const k = e.target.dataset.rp;

		if (!k) {
			return;
		}

		this.opts[k] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;

		if (k === 'scope' || k === 'detail') {
			this.render();
		}
	}

	// ================================================================ datos

	sev(n) {
		return (this.data.severities || [])[n] || {name: String(n), color: '#97aab3'};
	}

	status(d) {
		return (this.scene.rackView || new LakaInfra3DRackView(this.scene)).status(d);
	}

	roleName(d) {
		return (this.scene.rackView || new LakaInfra3DRackView(this.scene)).roleName(LakaInfra3DRackView.role(d));
	}

	/** Estado general: crítico (alta o desastre), con advertencias, con observaciones u operativo. */
	overall(worst) {
		if (worst >= 4) {
			return {text: this.t('Crítico'), color: this.sev(worst).color};
		}

		if (worst >= 2) {
			return {text: this.t('Con advertencias'), color: this.sev(worst).color};
		}

		if (worst >= 0) {
			return {text: this.t('Con observaciones'), color: this.sev(worst).color};
		}

		return {text: this.t('Operativo'), color: LakaInfra3DScene.OK_COLOR};
	}

	rackSummary(name, rack) {
		const devs = rack.devices.map((x) => x.d);
		const cap = this.scene.capacity ? this.scene.capacity.of(rack) : null;
		const temps = devs.map((d) => d.temp).filter((v) => v !== null && v !== undefined);
		const probs = devs.flatMap((d) => (d.problems || []).map((p) => ({p, d})));
		const worst = devs.reduce((m, d) => Math.max(m, d.sev ?? -1), -1);
		const hosts = devs.filter((d) => !d.passive);
		const down = hosts.filter((d) => (d.avail || []).some((a) => a.state === 2));

		return {name, rack, devs, cap, temps, probs, worst, hosts, down,
			tmax: temps.length ? Math.max(...temps) : null,
			maint: hosts.filter((d) => d.maint).length};
	}

	/** Revisión de normas con un editor sin pantalla (solo si el usuario puede editar la sala). */
	norms() {
		if (!this.data.editor || typeof LakaInfra3DEditor !== 'function' || !LakaInfra3DEditor.prototype.normChecks) {
			return null;
		}

		try {
			const ed = Object.create(LakaInfra3DEditor.prototype);

			ed.data = this.data;
			ed.draft = ed.initialDraft();
			ed.hosts = ed.knownHosts();
			ed.cab = null;
			ed.cabInit();

			return ed.normChecks();
		}
		catch (error) {
			console.error(error);

			return null;
		}
	}

	ago(clock) {
		const s = Math.max(0, Math.floor(Date.now() / 1000) - clock);
		const d = Math.floor(s / 86400);
		const h = Math.floor((s % 86400) / 3600);
		const m = Math.floor((s % 3600) / 60);

		return d > 0 ? `${d} d ${h} h` : (h > 0 ? `${h} h ${m} min` : `${m} min`);
	}

	when(clock) {
		return new Date(clock * 1000).toLocaleString(this.locale());
	}

	locale() {
		return {es: 'es-BO', pt: 'pt-BR', en: 'en-US'}[this.data.lang] || undefined;
	}

	fileStamp() {
		const d = new Date();
		const p = (n) => String(n).padStart(2, '0');

		return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
	}

	// ================================================================ CSV

	csvCell(v) {
		const s = String(v ?? '');

		return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
	}

	csv(rows) {
		// Punto y coma y BOM para que Excel en español y portugués lo abra bien.
		return '﻿' + rows.map((r) => r.map((c) => this.csvCell(c)).join(';')).join('\r\n');
	}

	csvDevices() {
		const t = this.t.bind(this);
		const rows = [[t('Rack'), t('Fila'), 'U', t('Altura (U)'), t('Cara'), t('Equipo'), t('Host'), t('Papel'), t('Fabricante'),
			t('Modelo'), t('Número de serie'), t('Estado'), t('Problemas'), t('Temp. (°C)'), t('Consumo (W)'), t('Peso (kg)')]];
		const only = this.opts.scope === 'rack' ? this.opts.rack : null;

		for (const [name, rack] of this.racks()) {
			if (only && name !== only) {
				continue;
			}

			for (const x of rack.devices.slice().sort((a, b) => b.d.u - a.d.u)) {
				const d = x.d;
				const inv = d.inv || {};

				rows.push([name, rack.def.mount === 'wall' ? t('Pared') : rack.def.row_label, d.u + d.n - 1, d.n, d.face === 'back' ? t('atrás') : t('frente'), d.name,
					d.host || '', this.roleName(d), inv.vendor || '', inv.model || '', inv.serial || '', this.status(d).text,
					(d.problems || []).length, d.temp ?? '', d.w || '', d.kg || '']);
			}
		}

		return this.csv(rows);
	}

	csvRacks() {
		const t = this.t.bind(this);
		const rows = [[t('Rack'), t('Fila'), t('U totales'), t('U ocupadas'), t('Ocupación (%)'), t('Equipos'), t('Problemas'),
			t('Peor severidad'), t('Temp. máx. (°C)'), t('Energía (W)'), t('Capacidad (W)'), t('Peso (kg)'), t('Carga máx. (kg)')]];

		for (const [name, rack] of this.racks()) {
			const r = this.rackSummary(name, rack);
			const c = r.cap || {};

			rows.push([name, rack.def.mount === 'wall' ? t('Pared') : rack.def.row_label, rack.def.units, c.used ?? '', c.units ? Math.round(c.used / c.units * 100) : '',
				r.devs.length, r.probs.length, r.worst >= 0 ? this.sev(r.worst).name : t('Sin problemas'), r.tmax ?? '',
				c.load ?? '', c.capW || '', c.kg ? Math.round(c.kg) : '', c.maxKg || '']);
		}

		return this.csv(rows);
	}

	download(filename, text, type = 'text/csv;charset=utf-8') {
		const blob = new Blob([text], {type});
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');

		a.href = url;
		a.download = filename;
		document.body.appendChild(a);
		a.click();
		a.remove();
		setTimeout(() => URL.revokeObjectURL(url), 2000);
	}

	// ================================================================ reporte HTML

	show() {
		const html = this.html();
		const w = window.open('', '_blank');

		// Si el navegador bloquea la ventana, se descarga el reporte como archivo HTML.
		if (!w) {
			this.download(`laka-infra3d-reporte-${this.fileStamp()}.html`, html, 'text/html;charset=utf-8');

			return;
		}

		w.document.open();
		w.document.write(html);
		w.document.close();

		const bind = () => {
			const print = w.document.querySelector('[data-print]');
			const save = w.document.querySelector('[data-save]');

			if (print) {
				print.addEventListener('click', () => w.print());
			}

			if (save) {
				save.addEventListener('click', () => this.download(`laka-infra3d-reporte-${this.fileStamp()}.html`, html, 'text/html;charset=utf-8'));
			}
		};

		w.document.readyState === 'loading' ? w.addEventListener('DOMContentLoaded', bind) : bind();
		this.lastHtml = html;
	}

	/** Estilos del dibujo del rack (los mismos de la vista del rack), copiados de la hoja de estilos del widget. */
	rackCss() {
		const out = [];

		for (const sheet of document.styleSheets) {
			let rules;

			try {
				rules = sheet.cssRules;
			}
			catch (error) {
				continue;
			}

			for (const rule of rules || []) {
				if ((rule.selectorText && rule.selectorText.includes('.rv-')) || (rule.name === 'laka3d-rv-blink')) {
					out.push(rule.cssText);
				}
			}
		}

		return out.join('\n');
	}

	html() {
		const esc = LakaInfra3DScene.esc;
		const t = this.t.bind(this);
		const o = this.opts;
		const s = this.scene;
		const data = this.data;
		const now = new Date().toLocaleString(this.locale());
		const site = data.cfg.site || '';
		const room = s.roomName();
		const isRack = o.scope === 'rack';
		const title = isRack ? `${t('Reporte del rack')} ${o.rack}` : t('Reporte de estado del data center');
		let body = '';

		if (isRack) {
			const rack = s.world.racks.get(o.rack);

			body = rack ? this.rackSection(o.rack, rack, true) : '';
		}
		else {
			body = this.dcSection();
		}

		return `<!DOCTYPE html>
<html lang="${esc(data.lang || 'es')}">
<head>
<meta charset="utf-8">
<title>${esc(title)} · ${esc(room)}</title>
<style>
${LakaInfra3DReport.CSS}
${this.rackCss()}
</style>
</head>
<body>
<div class="bar no-print">
	<span>${esc(t('LAKA Infra 3D'))} · ${esc(title)}</span>
	<button type="button" data-print>${esc(t('Imprimir o guardar PDF'))}</button>
	<button type="button" data-save>${esc(t('Descargar HTML'))}</button>
</div>
<header class="doc">
	<div>
		<div class="brand">LAKA Infra 3D</div>
		<h1>${esc(title)}</h1>
		<div class="meta">${site ? `${esc(t('Sitio'))}: <strong>${esc(site)}</strong> · ` : ''}${esc(t('Sala'))}: <strong>${esc(room)}</strong> · ${esc(t('Generado'))}: <strong>${esc(now)}</strong></div>
	</div>
	<div class="src">${esc(t('Datos de Zabbix del último refresco del widget'))}<br>${esc(t('Datos al'))} ${esc(this.when(data.time || Math.floor(Date.now() / 1000)))}</div>
</header>
${body}
<footer>© LAKA Soluciones Tecnológicas · LAKA Infra 3D · ${esc(now)}</footer>
</body>
</html>`;
	}

	/** Sistema al que pertenece un elemento de sala (climatización, seguridad, incendio, ambiente). */
	groupIndex(kind) {
		const groups = typeof LakaInfra3DEditor === 'function' && LakaInfra3DEditor.KIND_GROUPS ? LakaInfra3DEditor.KIND_GROUPS : [];
		const i = groups.findIndex(([, kinds]) => kinds.includes(kind));

		return i < 0 ? 99 : i;
	}

	groupName(kind) {
		const groups = typeof LakaInfra3DEditor === 'function' && LakaInfra3DEditor.KIND_GROUPS ? LakaInfra3DEditor.KIND_GROUPS : [];
		const g = groups[this.groupIndex(kind)];

		return g ? this.t(g[0]) : '';
	}

	kpi(label, value, extra = '', color = '') {
		const esc = LakaInfra3DScene.esc;

		return `<div class="kpi"${color ? ` style="border-top-color:${esc(color)}"` : ''}><span>${esc(label)}</span><strong>${value}</strong>${extra ? `<em>${extra}</em>` : ''}</div>`;
	}

	bar(ratio) {
		if (ratio === null || ratio === undefined) {
			return '';
		}

		const pct = Math.round(ratio * 100);
		const color = pct >= 90 ? '#e97659' : (pct >= 80 ? '#ffc859' : LakaInfra3DScene.OK_COLOR);

		return `<span class="meter"><b style="width:${Math.min(100, pct)}%;background:${color}"></b></span>`;
	}

	sevChip(n) {
		const esc = LakaInfra3DScene.esc;

		if (n < 0) {
			return `<span class="chip ok">${esc(this.t('OK'))}</span>`;
		}

		const sv = this.sev(n);

		return `<span class="chip" style="background:${esc(sv.color)}">${esc(sv.name)}</span>`;
	}

	kw(w) {
		return w === null || w === undefined ? '—' : `${(w / 1000).toFixed(2)} kW`;
	}

	/** Reporte del data center: resumen, problemas, racks, infraestructura, cableado, normas y detalle. */
	dcSection() {
		const esc = LakaInfra3DScene.esc;
		const t = this.t.bind(this);
		const o = this.opts;
		const s = this.scene;
		const racks = this.racks().map(([n, r]) => this.rackSummary(n, r));
		const devs = racks.flatMap((r) => r.devs);
		const hosts = devs.filter((d) => !d.passive);
		const objects = (this.data.objects || []);
		const probs = [...racks.flatMap((r) => r.probs.map((x) => ({...x, rack: r.name}))),
			...objects.flatMap((ob) => (ob.problems || []).map((p) => ({p, d: {name: ob.name || ob.host_name, u: null, n: 0}, rack: '', obj: ob})))]
			.sort((a, b) => b.p.sev - a.p.sev || b.p.clock - a.p.clock);
		const worst = Math.max(-1, ...probs.map((x) => x.p.sev));
		const ov = this.overall(worst);
		const tot = s.capacity ? s.capacity.totals() : null;
		const temps = devs.map((d) => d.temp).filter((v) => v !== null && v !== undefined)
			.concat(objects.filter((ob) => ob.kind === 'sensor' && ob.value !== null).map((ob) => parseFloat(ob.value)).filter((v) => isFinite(v)));
		const down = hosts.filter((d) => (d.avail || []).some((a) => a.state === 2));
		const bySev = [5, 4, 3, 2, 1, 0].map((n) => [n, probs.filter((x) => x.p.sev === n).length]).filter(([, c]) => c > 0);
		const norms = o.norms ? this.norms() : null;
		let out = '';

		// ---- resumen ejecutivo
		out += `<section>
			<h2>${esc(t('Resumen ejecutivo'))}</h2>
			<div class="overall" style="border-left-color:${esc(ov.color)}">
				<span class="dot" style="background:${esc(ov.color)}"></span>
				<div><strong>${esc(t('Estado general'))}: ${esc(ov.text)}</strong>
				<span>${esc(t('%1$s problemas activos en %2$s equipos monitoreados; %3$s con el agente o la interfaz no disponible.', String(probs.length), String(hosts.length), String(down.length)))}</span></div>
			</div>
			<div class="kpis">
				${this.kpi(t('Racks'), String(racks.length))}
				${this.kpi(t('Equipos'), String(devs.length), esc(t('%1$s monitoreados · %2$s pasivos', String(hosts.length), String(devs.length - hosts.length))))}
				${this.kpi(t('Problemas activos'), String(probs.length), bySev.map(([n, c]) => `${esc(this.sev(n).name)}: ${c}`).join(' · '), worst >= 0 ? this.sev(worst).color : LakaInfra3DScene.OK_COLOR)}
				${this.kpi(t('No disponibles'), String(down.length), '', down.length ? '#e45959' : '')}
				${tot ? this.kpi(t('Ocupación'), `${tot.used}/${tot.units} U`, `${tot.units ? Math.round(tot.used / tot.units * 100) : 0} % ${this.bar(tot.units ? tot.used / tot.units : 0)}`) : ''}
				${tot ? this.kpi(t('Energía'), tot.capW > 0 && tot.load !== null && tot.load !== undefined ? `${this.kw(tot.load)} / ${this.kw(tot.capW)}` : this.kw(tot.load), tot.capW > 0 && tot.load ? this.bar(tot.load / tot.capW) : '') : ''}
				${(() => {
					// PUE instantáneo (ISO/IEC 30134-2) y entradas de aire según ASHRAE.
					const en = this.scene.energy;

					if (!en) {
						return '';
					}

					const c = en.current();
					const a = en.ashrae();
					const racksIn = a.bands.rec + a.bands.allow + a.bands.out;

					return (c.pue !== null ? this.kpi('PUE', c.pue.toFixed(2), esc(t('ahora · categoría %1$s · DCiE %2$s %', String(c.category), String(Math.round(100 / c.pue)))), c.pue <= 1.5 ? '#59db8f' : (c.pue <= 2 ? '#ffc859' : '#e45959')) : '')
						+ (racksIn ? this.kpi(`ASHRAE ${a.cfg.ashrae}`, `${a.bands.rec}/${racksIn}`, esc(t('racks con entrada en el rango recomendado · %1$s permitido · %2$s fuera', String(a.bands.allow), String(a.bands.out))), a.bands.out ? '#e45959' : (a.bands.allow ? '#ffc859' : '#59db8f')) : '');
				})()}
				${temps.length ? this.kpi(t('Temperatura'), `${Math.max(...temps).toFixed(1)} °C`, esc(t('máxima · promedio %1$s °C', (temps.reduce((a, b) => a + b, 0) / temps.length).toFixed(1)))) : ''}
				${norms ? this.kpi(t('Normas'), String(norms.filter((x) => x.level !== 'info').length), esc(t('para corregir o revisar · %1$s recomendaciones', String(norms.filter((x) => x.level === 'info').length)))) : ''}
			</div>
		</section>`;

		// ---- problemas activos
		if (o.problems) {
			out += `<section>
				<h2>${esc(t('Problemas activos'))} (${probs.length})</h2>
				${probs.length ? `<table>
					<thead><tr><th>${esc(t('Severidad'))}</th><th>${esc(t('Equipo'))}</th><th>${esc(t('Ubicación'))}</th><th>${esc(t('Problema'))}</th><th>${esc(t('Desde'))}</th><th>${esc(t('Duración'))}</th><th>${esc(t('Reconocido'))}</th></tr></thead>
					<tbody>${probs.slice(0, 300).map((x) => `<tr>
						<td>${this.sevChip(x.p.sev)}</td>
						<td><strong>${esc(x.d.name)}</strong></td>
						<td>${x.obj ? esc(s.kindName(x.obj.kind)) : `${esc(x.rack)} · U${x.d.u + x.d.n - 1}`}</td>
						<td>${esc(x.p.name)}</td>
						<td class="nw">${esc(this.when(x.p.clock))}</td>
						<td class="nw">${esc(this.ago(x.p.clock))}</td>
						<td>${x.p.ack ? esc(t('Sí')) : esc(t('No'))}</td>
					</tr>`).join('')}</tbody>
				</table>${probs.length > 300 ? `<p class="muted">${esc(t('Se muestran los 300 más graves.'))}</p>` : ''}` : `<p class="ok-text">${esc(t('No hay problemas activos.'))}</p>`}
			</section>`;
		}

		// ---- estado de cada rack
		const normsBy = (rack) => (norms || []).filter((x) => x.rack === rack);

		out += `<section>
			<h2>${esc(t('Estado de los racks'))}</h2>
			<table>
				<thead><tr><th>${esc(t('Rack'))}</th><th>${esc(t('Fila'))}</th><th>${esc(t('Estado'))}</th><th>${esc(t('Ocupación'))}</th><th>${esc(t('Equipos'))}</th><th>${esc(t('Problemas'))}</th><th>${esc(t('No disponibles'))}</th><th>${esc(t('Temp. máx.'))}</th><th>${esc(t('Energía'))}</th><th>${esc(t('Peso'))}</th>${norms ? `<th>${esc(t('Normas'))}</th>` : ''}</tr></thead>
				<tbody>${racks.map((r) => {
					const c = r.cap || {};
					const nr = normsBy(r.name);

					return `<tr>
						<td><strong>${esc(r.name)}</strong></td>
						<td>${esc(r.rack.def.mount === 'wall' ? t('Pared') : r.rack.def.row_label)}</td>
						<td>${this.sevChip(r.worst)}</td>
						<td class="nw">${c.used ?? '—'}/${c.units ?? r.rack.def.units} U ${this.bar(c.units ? c.used / c.units : null)}</td>
						<td>${r.devs.length}</td>
						<td>${r.probs.length}</td>
						<td>${r.down.length}</td>
						<td>${r.tmax !== null ? `${r.tmax} °C` : '—'}</td>
						<td class="nw">${c.capW > 0 && c.load !== null ? `${this.kw(c.load)} / ${this.kw(c.capW)} ${this.bar(c.load / c.capW)}` : this.kw(c.load)}</td>
						<td class="nw">${c.kg ? Math.round(c.kg) : 0}${c.maxKg ? ' / ' + c.maxKg : ''} kg</td>
						${norms ? `<td>${nr.filter((x) => x.level !== 'info').length} / ${nr.length}</td>` : ''}
					</tr>`;
				}).join('')}</tbody>
			</table>
		</section>`;

		// ---- infraestructura de sala
		if (o.infra && objects.filter((ob) => ob.kind !== 'door').length) {
			out += `<section>
				<h2>${esc(t('Infraestructura de sala'))}</h2>
				<table>
					<thead><tr><th>${esc(t('Sistema'))}</th><th>${esc(t('Tipo'))}</th><th>${esc(t('Nombre'))}</th><th>${esc(t('Host de Zabbix'))}</th><th>${esc(t('Valor'))}</th><th>${esc(t('Estado'))}</th></tr></thead>
					<tbody>${objects.filter((ob) => ob.kind !== 'door').sort((a, b) => this.groupIndex(a.kind) - this.groupIndex(b.kind)).map((ob) => `<tr>
						<td class="muted">${esc(this.groupName(ob.kind))}</td>
						<td>${esc(s.kindName(ob.kind))}${LakaInfra3DScene.VARIANTS[ob.kind] ? `<br><span class="muted">${esc(LakaInfra3DScene.variantName(ob, t))}</span>` : ''}</td>
						<td><strong>${esc(ob.name || '')}</strong></td>
						<td>${esc(ob.host_name || '—')}</td>
						<td>${ob.value !== null && ob.value !== undefined ? `${esc(ob.value)} ${esc(ob.units || '')}${ob.hum !== null && ob.hum !== undefined ? ` · ${esc(ob.hum)} %` : ''}` : '—'}</td>
						<td>${ob.linked ? this.sevChip(ob.sev) : `<span class="muted">${esc(t('Sin vincular'))}</span>`}</td>
					</tr>`).join('')}</tbody>
				</table>
			</section>`;
		}

		if (o.cabling) {
			out += this.cablingSection(null);
		}

		if (norms && o.norms) {
			out += this.normsSection(norms);
		}

		if (o.detail) {
			for (const r of racks) {
				out += this.rackSection(r.name, r.rack, false);
			}
		}

		return out;
	}

	/** Reporte o sección de un rack. */
	rackSection(name, rack, standalone) {
		const esc = LakaInfra3DScene.esc;
		const t = this.t.bind(this);
		const o = this.opts;
		const r = this.rackSummary(name, rack);
		const c = r.cap || {};
		const ov = this.overall(r.worst);
		const rv = this.scene.rackView || new LakaInfra3DRackView(this.scene);
		const devs = r.devs.slice().sort((a, b) => (b.u + b.n) - (a.u + a.n));
		const norms = standalone && o.norms ? this.norms() : null;
		let out = `<section class="${standalone ? '' : 'rack-page'}">
			<h2>${esc(t('Rack'))} ${esc(name)} <small>${esc(LakaInfra3DScene.rackWhere(rack.def, t))} · ${rack.def.units}U</small></h2>
			<div class="overall" style="border-left-color:${esc(ov.color)}">
				<span class="dot" style="background:${esc(ov.color)}"></span>
				<div><strong>${esc(t('Estado'))}: ${esc(ov.text)}</strong>
				<span>${esc(t('%1$s problemas activos · %2$s equipos · %3$s no disponibles · %4$s en mantenimiento', String(r.probs.length), String(r.devs.length), String(r.down.length), String(r.maint)))}</span></div>
			</div>
			<div class="kpis">
				${this.kpi(t('Ocupación'), `${c.used ?? 0}/${rack.def.units} U`, `${c.free ?? rack.def.units} ${esc(t('U libres'))} · ${esc(t('mayor hueco'))} ${c.largest ?? 0} U ${this.bar(c.units ? c.used / c.units : 0)}`)}
				${this.kpi(t('Energía'), c.capW > 0 && c.load !== null ? `${this.kw(c.load)} / ${this.kw(c.capW)}` : this.kw(c.load), c.capW > 0 && c.load ? this.bar(c.load / c.capW) : '')}
				${this.kpi(t('Peso'), `${c.kg ? Math.round(c.kg) : 0}${c.maxKg ? ' / ' + c.maxKg : ''} kg`, c.maxKg ? this.bar(c.kg / c.maxKg) : '')}
				${this.kpi(t('Temp. máx.'), r.tmax !== null ? `${r.tmax} °C` : '—')}
				${this.kpi(t('Problemas'), String(r.probs.length), '', r.worst >= 0 ? this.sev(r.worst).color : '')}
			</div>`;

		if (o.elev && (standalone || o.detail)) {
			const px = Math.max(10, Math.min(16, Math.floor(620 / (rack.def.units + 1))));

			out += `<div class="elevs laka3d-rv">
				${rv.elevationSvg(rack, 'front', px, true)}
				${rv.elevationSvg(rack, 'back', px, rack.devices.some((x) => x.d.face === 'back'))}
			</div>`;
		}

		if (o.devices) {
			out += `<h3>${esc(t('Equipos'))} (${devs.length})</h3>
				${devs.length ? `<table>
					<thead><tr><th>U</th><th>${esc(t('Equipo'))}</th><th>${esc(t('Papel'))}</th><th>${esc(t('Modelo'))}</th><th>${esc(t('Número de serie'))}</th><th>${esc(t('Altura · cara'))}</th><th>${esc(t('Temp.'))}</th><th>${esc(t('Estado'))}</th></tr></thead>
					<tbody>${devs.map((d) => {
						const inv = d.inv || {};
						const st = this.status(d);

						return `<tr class="${d.passive ? 'muted' : ''}">
							<td class="nw"><strong>U${d.u + d.n - 1}</strong>${d.n > 1 ? `–${d.u}` : ''}</td>
							<td><strong>${esc(d.name)}</strong></td>
							<td>${esc(this.roleName(d))}</td>
							<td>${esc([inv.vendor, inv.model].filter(Boolean).join(' ') || '—')}</td>
							<td>${esc(inv.serial || '—')}</td>
							<td class="nw">${d.n}U · ${esc(d.face === 'back' ? t('atrás') : t('frente'))}</td>
							<td>${d.temp !== null && d.temp !== undefined ? `${d.temp} °C` : '—'}</td>
							<td><span class="chip${st.cls === 'is-ok' ? ' ok' : (st.cls === 'is-passive' ? ' passive' : '')}" style="${st.cls === 'is-ok' || st.cls === 'is-passive' ? '' : `background:${esc(st.color)}`}">${esc(st.text)}</span></td>
						</tr>`;
					}).join('')}</tbody>
				</table>` : `<p class="muted">${esc(t('Rack vacío.'))}</p>`}`;
		}

		if (o.problems && r.probs.length) {
			out += `<h3>${esc(t('Problemas activos'))} (${r.probs.length})</h3>
				<table>
					<thead><tr><th>${esc(t('Severidad'))}</th><th>${esc(t('Equipo'))}</th><th>U</th><th>${esc(t('Problema'))}</th><th>${esc(t('Duración'))}</th><th>${esc(t('Reconocido'))}</th></tr></thead>
					<tbody>${r.probs.sort((a, b) => b.p.sev - a.p.sev).map((x) => `<tr>
						<td>${this.sevChip(x.p.sev)}</td><td><strong>${esc(x.d.name)}</strong></td><td>U${x.d.u + x.d.n - 1}</td>
						<td>${esc(x.p.name)}</td><td class="nw">${esc(this.ago(x.p.clock))}</td><td>${x.p.ack ? esc(t('Sí')) : esc(t('No'))}</td>
					</tr>`).join('')}</tbody>
				</table>`;
		}

		if (standalone && o.cabling) {
			out += this.cablingSection(name);
		}

		if (norms) {
			out += this.normsSection(norms.filter((x) => x.rack === name || x.rack === null));
		}

		return out + '</section>';
	}

	/** Cableado: totales y lista de cables (de toda la sala o de un rack), con etiquetas TIA-606. */
	cablingSection(rackName) {
		const esc = LakaInfra3DScene.esc;
		const t = this.t.bind(this);
		const cab = this.data.cabling || {};
		const list = (cab.list || []).map((x) => LakaInfra3DCabling.parseCable(x));

		if (!list.length) {
			return `<section><h2>${esc(t('Cableado'))}</h2><p class="muted">${esc(t('No hay cables documentados.'))}</p></section>`;
		}

		const dv = this.scene.devView || new LakaInfra3DDevView(this.scene);
		const info = (ep) => dv.endpointInfo(ep);
		const rows = list.map((c) => ({c, a: info(c.a), b: info(c.b)}))
			.filter((x) => !rackName || x.a.rack === rackName || x.b.rack === rackName);
		const kindName = {net: t('Cobre (UTP)'), fiber: t('Fibra'), power: t('Energía')};
		const count = (k) => list.filter((c) => c.k === k).length;
		const panels = this.scene.world.devices.filter((x) => LakaInfra3DRackView.role(x.d) === 'patch');
		let ports = 0;
		let usedPorts = 0;

		for (const p of panels) {
			const cfg = LakaInfra3DCabling.panel(cab, p.d.key || p.d.id, p.d.n);

			ports += cfg.ports;

			for (let n = 1; n <= cfg.ports; n++) {
				if (LakaInfra3DCabling.cableAt(cab, `${p.d.key || p.d.id}#F-pp-${n}`) || LakaInfra3DCabling.cableAt(cab, `${p.d.key || p.d.id}#R-pp-${n}`)) {
					usedPorts++;
				}
			}
		}

		return `<section>
			<h2>${esc(t('Cableado'))}${rackName ? ` · ${esc(t('Rack'))} ${esc(rackName)}` : ''}</h2>
			${rackName ? '' : `<div class="kpis">
				${this.kpi(t('Cables'), String(list.length), esc(`${kindName.net}: ${count('net')} · ${kindName.fiber}: ${count('fiber')} · ${kindName.power}: ${count('power')}`))}
				${this.kpi(t('Patch panels'), String(panels.length), esc(t('%1$s de %2$s puertos en uso', String(usedPorts), String(ports))), '', )}
				${this.kpi(t('Identificador del espacio (FS)'), esc(cab.fs || '—'))}
			</div>`}
			${rows.length ? `<table>
				<thead><tr><th>${esc(t('Etiqueta (TIA-606)'))}</th><th>${esc(t('Tipo'))}</th><th>${esc(t('Extremo A'))}</th><th>${esc(t('Extremo B'))}</th><th>${esc(t('Largo'))}</th></tr></thead>
				<tbody>${rows.slice(0, 1000).map((x) => `<tr>
					<td class="mono">${esc(dv.cableLabel(x.c))}</td>
					<td><span class="sw" style="background:${esc(x.c.c || LakaInfra3DDevView.KIND_COLOR[x.c.k])}"></span>${esc(kindName[x.c.k] || x.c.k)}</td>
					<td>${esc(x.a.name)} · ${esc(x.a.port)}${x.a.where ? ` <span class="muted">(${esc(x.a.where)})</span>` : ''}</td>
					<td>${esc(x.b.name)} · ${esc(x.b.port)}${x.b.where ? ` <span class="muted">(${esc(x.b.where)})</span>` : ''}</td>
					<td>${x.c.len ? `${x.c.len} m` : '—'}</td>
				</tr>`).join('')}</tbody>
			</table>` : `<p class="muted">${esc(t('No hay cables documentados.'))}</p>`}
		</section>`;
	}

	normsSection(norms) {
		const esc = LakaInfra3DScene.esc;
		const t = this.t.bind(this);
		const sev = this.data.severities || [];
		const color = {error: (sev[4] || {}).color || '#e97659', warn: (sev[2] || {}).color || '#ffc859', info: (sev[1] || {}).color || '#7499ff'};
		const name = {error: t('Corregir'), warn: t('Revisar'), info: t('Recomendación')};

		return `<section>
			<h2>${esc(t('Revisión de normas'))} (${norms.length})</h2>
			${norms.length ? `<table>
				<thead><tr><th>${esc(t('Nivel'))}</th><th>${esc(t('Rack'))}</th><th>${esc(t('Observación'))}</th><th>${esc(t('Qué hacer'))}</th><th>${esc(t('Referencia'))}</th></tr></thead>
				<tbody>${norms.map((x) => `<tr>
					<td><span class="chip" style="background:${esc(color[x.level])}">${esc(name[x.level])}</span></td>
					<td>${esc(x.rack || '—')}</td><td>${esc(x.text)}</td><td>${esc(x.fix)}</td><td class="muted">${esc(x.ref)}</td>
				</tr>`).join('')}</tbody>
			</table>` : `<p class="ok-text">${esc(t('No se encontraron observaciones.'))}</p>`}
		</section>`;
	}

	// Estilos del reporte: página clara para imprimir, con los colores del tema azul de Zabbix.
	static CSS = `
		* { box-sizing: border-box; }
		body { margin: 0; font: 13px/1.45 Arial, Tahoma, Verdana, sans-serif; color: #1f2c33; background: #ebeef0; }
		.bar { position: sticky; top: 0; z-index: 2; display: flex; gap: 8px; align-items: center; padding: 8px 16px; background: #1f2c33; color: #fff; }
		.bar span { flex: 1; font-weight: bold; }
		.bar button { font: inherit; padding: 6px 12px; border: 1px solid #768d99; border-radius: 2px; background: #0275b8; color: #fff; cursor: pointer; }
		.bar button + button { background: transparent; }
		header.doc, section, footer { max-width: 1100px; margin: 12px auto; background: #fff; border: 1px solid #dfe4e7; padding: 18px 22px; }
		header.doc { display: flex; justify-content: space-between; gap: 16px; border-top: 4px solid #0275b8; }
		.brand { color: #0275b8; font-weight: bold; letter-spacing: 1px; text-transform: uppercase; font-size: 11px; }
		h1 { margin: 4px 0 6px; font-size: 22px; }
		h2 { margin: 0 0 10px; font-size: 17px; border-bottom: 2px solid #ebeef0; padding-bottom: 6px; }
		h2 small { font-weight: normal; color: #768d99; font-size: 12px; margin-left: 8px; }
		h3 { margin: 16px 0 8px; font-size: 14px; }
		.meta, .src { color: #768d99; }
		.src { text-align: right; font-size: 11px; }
		.overall { display: flex; gap: 12px; align-items: center; padding: 10px 12px; margin-bottom: 12px; background: #f4f6f7; border-left: 5px solid; }
		.overall div { display: flex; flex-direction: column; }
		.dot { width: 14px; height: 14px; border-radius: 50%; flex: 0 0 auto; }
		.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; margin-bottom: 8px; }
		.kpi { border: 1px solid #dfe4e7; border-top: 3px solid #768d99; padding: 8px 10px; display: flex; flex-direction: column; gap: 2px; }
		.kpi span { color: #768d99; font-size: 11px; }
		.kpi strong { font-size: 17px; }
		.kpi em { font-style: normal; font-size: 11px; color: #4f5b63; }
		.meter { display: inline-block; vertical-align: middle; width: 70px; height: 6px; background: #ebeef0; border-radius: 3px; overflow: hidden; margin-left: 6px; }
		.meter b { display: block; height: 100%; }
		table { width: 100%; border-collapse: collapse; margin: 4px 0 8px; }
		th { text-align: left; font-weight: normal; color: #768d99; font-size: 11px; padding: 6px 8px; border-bottom: 2px solid #dfe4e7; background: #f4f6f7; }
		td { padding: 5px 8px; border-bottom: 1px solid #ebeef0; vertical-align: top; }
		tr.muted td, .muted { color: #768d99; }
		.nw { white-space: nowrap; }
		.mono { font-family: Consolas, 'DejaVu Sans Mono', monospace; font-size: 11px; }
		.chip { display: inline-block; padding: 1px 8px; border-radius: 2px; font-size: 11px; font-weight: bold; color: #1f2c33; white-space: nowrap; }
		.chip.ok { background: transparent; border: 1px solid #429e47; color: #429e47; }
		.chip.passive { background: transparent; border: 1px solid #c4ccd2; color: #768d99; font-weight: normal; }
		.ok-text { color: #429e47; }
		.sw { display: inline-block; width: 14px; height: 6px; border-radius: 2px; margin-right: 6px; vertical-align: 1px; border: 1px solid rgba(0,0,0,.2); }
		.elevs { display: flex; gap: 14px; flex-wrap: wrap; padding: 10px; background: #0b0d10; border-radius: 6px; margin: 8px 0; }
		.elevs svg { display: block; font-family: Arial, sans-serif; }
		footer { text-align: center; color: #768d99; font-size: 11px; }
		section section { border: 0; padding: 0; margin: 16px 0 0; max-width: none; }
		section section h2 { font-size: 15px; }
		@media print {
			body { background: #fff; }
			.no-print { display: none !important; }
			header.doc, section, footer { border: 0; margin: 0 0 10px; padding: 0; max-width: none; }
			section { break-inside: auto; }
			.rack-page { break-before: page; }
			tr, .kpi, .overall, .elevs { break-inside: avoid; }
			.elevs, .chip, .dot, .meter b, .sw, .kpi { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
			@page { size: A4; margin: 12mm; }
		}
	`;
}
