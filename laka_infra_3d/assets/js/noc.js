/*
 * LAKA Infra 3D – gemelo digital de data center para Zabbix 7.0 – 8.0
 * © LAKA Soluciones Tecnológicas
 * Autor: Willian Tola
 * Licencia GPLv3
 *
 * Modo NOC: vista para la pantalla de la sala de monitoreo.
 * - Pantalla completa, reloj, indicadores de la sala y lista de problemas activos.
 * - Recorrido automático: vista general → cada equipo con problemas → mapa de calor → vuelve a empezar.
 * - Alerta de problema nuevo (banner, vuelo hasta el equipo y sonido opcional).
 * - Se pausa cuando el operador toca la vista y continúa solo al minuto.
 * - Arranca solo cuando el tablero de Zabbix está en modo quiosco (opcional en el formulario).
 */

class LakaInfra3DNoc {

	static PAUSE_MS = 60000;		// Pausa del recorrido tras una interacción.
	static MAX_STOPS = 8;			// Equipos con problemas por vuelta del recorrido.
	static MAX_LIST = 40;			// Problemas en la lista lateral.
	static NEW_MS = 5 * 60000;		// Tiempo que un problema se marca como "nuevo".

	constructor(scene) {
		this.scene = scene;
		this.active = false;
		this.fullscreen = false;
		this.autoTried = false;
		this.known = null;			// eventid conocidos (null = todavía sin línea base).
		this.fresh = new Map();		// eventid => momento en que apareció.
		this.items = [];
		this.round = null;
		this.pausedUntil = 0;
		this.updatedAt = 0;
		this.audio = null;
		this.prevMode = null;
		this.alertTimer = null;

		this.buildDom();

		this.clock = setInterval(() => this.everySecond(), 1000);

		this.onFullscreen = () => {
			// Si el usuario sale de pantalla completa (Esc), sale también del modo NOC.
			if (this.active && this.fullscreen && document.fullscreenElement !== this.scene.root) {
				this.fullscreen = false;
				this.exit();
			}
		};
		document.addEventListener('fullscreenchange', this.onFullscreen);

		this.onKey = (e) => {
			if (this.active && e.key === 'Escape' && !this.fullscreen) {
				this.exit();
			}
		};
		document.addEventListener('keydown', this.onKey);
	}

	t(...args) {
		return this.scene.t(...args);
	}

	get data() {
		return this.scene.data;
	}

	get cfg() {
		return Object.assign({autostart: true, cycle: 12, min_sev: 2, sound: false},
			(this.data && this.data.cfg && this.data.cfg.noc) || {}
		);
	}

	// ---------------------------------------------------------------- DOM

	buildDom() {
		const root = this.scene.root;

		this.el = document.createElement('div');
		this.el.className = 'laka3d-noc';
		this.el.hidden = true;
		this.el.innerHTML = `
			<div class="laka3d-noc-top">
				<div class="laka3d-noc-title"><strong></strong><span></span></div>
				<div class="laka3d-noc-kpis"></div>
				<div class="laka3d-noc-clock"><strong></strong><span></span></div>
				<button type="button" class="laka3d-btn laka3d-noc-exit"></button>
			</div>
			<aside class="laka3d-noc-side">
				<h4></h4>
				<div class="laka3d-noc-list"></div>
			</aside>
			<button type="button" class="laka3d-noc-alert" hidden></button>
			<div class="laka3d-noc-step" role="status">
				<span class="laka3d-noc-step-text"></span>
				<span class="laka3d-noc-progress"><i></i></span>
			</div>
		`;
		root.appendChild(this.el);

		this.kpis = this.el.querySelector('.laka3d-noc-kpis');
		this.list = this.el.querySelector('.laka3d-noc-list');
		this.sideTitle = this.el.querySelector('.laka3d-noc-side h4');
		this.alertEl = this.el.querySelector('.laka3d-noc-alert');
		this.stepText = this.el.querySelector('.laka3d-noc-step-text');
		this.progress = this.el.querySelector('.laka3d-noc-progress i');
		this.clockMain = this.el.querySelector('.laka3d-noc-clock strong');
		this.clockSub = this.el.querySelector('.laka3d-noc-clock span');

		this.el.querySelector('.laka3d-noc-exit').addEventListener('click', () => this.exit());
		this.list.addEventListener('keydown', (e) => {
			if ((e.key === 'Enter' || e.key === ' ') && e.target.closest('[data-i]')) {
				e.preventDefault();
				e.target.closest('[data-i]').click();
			}
		});
		this.list.addEventListener('click', (e) => {
			const row = e.target.closest('[data-i]');

			if (row) {
				this.goTo(this.items[parseInt(row.dataset.i, 10)], true);
			}
		});
		this.alertEl.addEventListener('click', () => {
			if (this.alertItem) {
				this.goTo(this.alertItem, true);
			}

			this.hideAlert();
		});
	}

	locale() {
		return {es: 'es-ES', pt: 'pt-BR', en: 'en-US'}[this.data && this.data.lang] || undefined;
	}

	// ---------------------------------------------------------------- entrada y salida

	/**
	 * Entra al modo NOC. Con pantalla completa solo si lo pidió el usuario (el navegador exige un clic).
	 */
	enter(fullscreen = true) {
		if (this.active || !this.scene.world) {
			return;
		}

		const s = this.scene;

		this.active = true;
		this.prevMode = s.mode;
		s.stopTour();
		s.closePanel();

		if (s.rackView) {
			s.rackView.close();
		}

		if (s.devView) {
			s.devView.close();
		}

		if (s.report) {
			s.report.close();
		}

		s.clearSelection();
		s.setAutoRotate(false);
		s.root.classList.add('is-noc');
		this.el.hidden = false;
		this.pausedUntil = 0;

		// El audio se prepara con el clic del usuario para que el navegador lo permita después.
		if (this.cfg.sound && !this.audio) {
			try {
				this.audio = new (window.AudioContext || window.webkitAudioContext)();
			}
			catch (error) {
				this.audio = null;
			}
		}

		if (fullscreen && s.root.requestFullscreen) {
			s.root.requestFullscreen().then(() => {
				this.fullscreen = true;
			}).catch(() => {
				this.fullscreen = false;
			});
		}

		this.render();
		this.newRound(performance.now());
		s.renderLegend();
	}

	exit() {
		if (!this.active) {
			return;
		}

		const s = this.scene;

		this.active = false;
		this.round = null;
		this.orbit = null;
		s.clearClip();
		this.el.hidden = true;
		s.root.classList.remove('is-noc');
		s.clearSelection();
		this.hideAlert();

		if (this.prevMode && s.mode !== this.prevMode) {
			s.setMode(this.prevMode);
		}

		if (this.fullscreen && document.fullscreenElement === s.root) {
			document.exitFullscreen().catch(() => {});
		}

		this.fullscreen = false;
		// Se vuelve a la preferencia del usuario (sala abierta o con paredes).
		s.applyWalls();
		s.flyTo(s.world.home.pos, s.world.home.target);
		s.renderLegend();
	}

	toggle() {
		if (this.active) {
			this.exit();
		}
		else {
			this.enter(true);
		}
	}

	/** El operador tocó la vista: el recorrido se detiene un minuto. */
	interact() {
		if (this.active) {
			this.pausedUntil = performance.now() + LakaInfra3DNoc.PAUSE_MS;
			this.everySecond();
		}
	}

	// ---------------------------------------------------------------- datos

	/**
	 * Llamado en cada actualización del widget: arma la lista de problemas y detecta los nuevos.
	 */
	update() {
		const data = this.data;

		if (!data || !this.scene.world) {
			return;
		}

		this.updatedAt = Date.now();
		this.items = this.collect();

		// Problemas nuevos: los que no estaban en la actualización anterior.
		const ids = new Set(this.items.map((x) => x.eventid));
		const added = this.known === null ? [] : this.items.filter((x) => !this.known.has(x.eventid));

		this.known = ids;

		for (const x of added) {
			this.fresh.set(x.eventid, Date.now());
		}

		for (const [id, at] of this.fresh) {
			if (!ids.has(id) || Date.now() - at > LakaInfra3DNoc.NEW_MS) {
				this.fresh.delete(id);
			}
		}

		// Arranque automático cuando el tablero está en modo quiosco de Zabbix.
		if (!this.autoTried) {
			this.autoTried = true;

			if (this.cfg.autostart && LakaInfra3DNoc.isKiosk()) {
				this.enter(false);
			}
		}

		if (!this.active) {
			return;
		}

		this.render();

		if (added.length) {
			const top = added.slice().sort((a, b) => b.sev - a.sev || b.clock - a.clock)[0];

			this.showAlert(top, added.length);
			this.beep(top.sev);
			this.goTo(top, false);
		}
	}

	/** El tablero de Zabbix agrega la clase layout-kioskmode en modo quiosco (7.0 – 8.0). */
	static isKiosk() {
		return !!document.querySelector('.layout-kioskmode');
	}

	/**
	 * Problemas activos de los equipos y de la infraestructura de la sala, desde la severidad mínima.
	 */
	collect() {
		const s = this.scene;
		const min = this.cfg.min_sev;
		const items = [];
		const seen = new Set();

		for (const dev of s.world.devices) {
			const d = dev.d;

			if (d.passive) {
				continue;
			}

			for (const p of d.problems || []) {
				const key = p.eventid || `${d.id}-${p.name}`;

				if (p.sev >= min && !seen.has(key)) {
					seen.add(key);
					items.push({eventid: key, sev: p.sev, name: p.name, clock: p.clock, ack: p.ack, host: d.name,
						where: `${this.t('Rack')} ${d.rack} · U${d.u}`, dev
					});
				}
			}
		}

		for (const entry of s.world.objects) {
			const o = entry.o;

			for (const p of o.problems || []) {
				const key = p.eventid || `${o.id}-${p.name}`;

				if (p.sev >= min && !seen.has(key)) {
					seen.add(key);
					items.push({eventid: key, sev: p.sev, name: p.name, clock: p.clock, ack: p.ack,
						host: o.host_name || o.name, where: o.name || s.kindName(o.kind), entry
					});
				}
			}
		}

		return items.sort((a, b) => b.sev - a.sev || b.clock - a.clock);
	}

	// ---------------------------------------------------------------- dibujo

	render() {
		const esc = LakaInfra3DScene.esc;
		const data = this.data;
		const s = this.scene;
		const sev = data.severities;
		const devices = s.world.devices.filter((x) => !x.d.passive);
		const bySev = new Array(6).fill(0);
		let maint = 0;

		for (const dev of devices) {
			if (dev.d.sev >= 0) {
				bySev[dev.d.sev]++;
			}

			if (dev.d.maint) {
				maint++;
			}
		}

		const ok = devices.filter((x) => x.d.sev < 0).length;
		const temps = devices.map((x) => x.d.temp).filter((v) => typeof v === 'number');

		for (const entry of s.world.objects) {
			const o = entry.o;

			if (['sensor', 'crac', 'inrow', 'split'].includes(o.kind) && typeof o.value === 'number'
					&& /c/i.test(o.units || '')) {
				temps.push(o.value);
			}
		}

		const doors = s.world.objects.filter((x) => x.o.kind === 'door');
		const open = doors.filter((x) => x.o.value !== null && x.o.value !== undefined && Number(x.o.value) !== 0);
		const tmax = temps.length ? Math.max(...temps) : null;

		this.el.querySelector('.laka3d-noc-title strong').textContent = this.t('Modo NOC');
		this.el.querySelector('.laka3d-noc-title span').textContent = `${data.cfg.site ? data.cfg.site + ' · ' : ''}${s.roomName()}`;
		this.el.querySelector('.laka3d-noc-exit').textContent = this.t('Salir del modo NOC');

		let html = `<div class="laka3d-noc-kpi"><span>${esc(this.t('Equipos'))}</span><strong>${devices.length}</strong></div>`
			+ `<div class="laka3d-noc-kpi" style="--c:#59db8f"><span>OK</span><strong>${ok}</strong></div>`;

		for (let i = 5; i >= 0; i--) {
			if (bySev[i] > 0 || i >= 2) {
				html += `<div class="laka3d-noc-kpi${bySev[i] > 0 ? ' is-on' : ''}" style="--c:${esc(sev[i].color)}"><span>${esc(sev[i].name)}</span><strong>${bySev[i]}</strong></div>`;
			}
		}

		if (maint) {
			html += `<div class="laka3d-noc-kpi" style="--c:#a78bfa"><span>${esc(this.t('En mantenimiento'))}</span><strong>${maint}</strong></div>`;
		}

		// Capacidad de la sala: ocupación de U y energía medida frente a la disponible.
		if (s.capacity) {
			const tot = s.capacity.totals();

			if (tot.units) {
				const ratio = tot.used / tot.units;

				html += `<div class="laka3d-noc-kpi is-on" style="--c:${LakaInfra3DCapacity.color(ratio)}"><span>${esc(this.t('Ocupación'))}</span><strong>${Math.round(ratio * 100)} %</strong></div>`;
			}

			if (tot.capW > 0) {
				html += `<div class="laka3d-noc-kpi is-on" style="--c:${LakaInfra3DCapacity.color(tot.loadW / tot.capW)}"><span>${esc(this.t('Energía'))}</span><strong>${(tot.loadW / 1000).toFixed(1)} kW</strong></div>`;
			}
		}

		if (tmax !== null) {
			html += `<div class="laka3d-noc-kpi is-on" style="--c:${esc(s.tempColor(tmax).getStyle())}"><span>${esc(this.t('Temp. máx.'))}</span><strong>${tmax.toFixed(1)} °C</strong></div>`;
		}

		if (doors.length) {
			html += `<div class="laka3d-noc-kpi${open.length ? ' is-on' : ''}" style="--c:${open.length ? '#ffc859' : '#59db8f'}"><span>${esc(this.t('Puertas abiertas'))}</span><strong>${open.length}/${doors.length}</strong></div>`;
		}

		this.kpis.innerHTML = html;

		// La lista y la alerta empiezan debajo de la barra superior (puede ocupar dos líneas).
		this.el.style.setProperty('--noc-top', `${this.el.querySelector('.laka3d-noc-top').offsetHeight + 16}px`);
		this.sideTitle.textContent = `${this.t('Problemas activos')} (${this.items.length})`;

		const now = Date.now() / 1000;

		this.list.innerHTML = this.items.slice(0, LakaInfra3DNoc.MAX_LIST).map((x, i) => `
			<div class="laka3d-noc-item${this.fresh.has(x.eventid) ? ' is-new' : ''}" role="button" tabindex="0" data-i="${i}" style="--c:${esc(sev[x.sev].color)}">
				<span class="laka3d-noc-sev">${esc(sev[x.sev].name)}</span>
				<strong>${esc(x.host)}</strong>
				<span class="laka3d-noc-pname">${esc(x.name)}</span>
				<em>${esc(x.where)} · ${esc(LakaInfra3DNoc.duration(now - x.clock))}${x.ack ? ' · ' + esc(this.t('reconocido')) : ''}${this.fresh.has(x.eventid) ? ` · <b>${esc(this.t('Nuevo'))}</b>` : ''}</em>
			</div>`).join('')
			|| `<p class="laka3d-ok">${esc(this.t('Sin problemas activos'))}</p>`;

		this.everySecond();
	}

	static duration(sec) {
		sec = Math.max(0, Math.floor(sec));

		const d = Math.floor(sec / 86400);
		const h = Math.floor((sec % 86400) / 3600);
		const m = Math.floor((sec % 3600) / 60);

		if (d > 0) {
			return `${d}d ${h}h`;
		}

		if (h > 0) {
			return `${h}h ${m}m`;
		}

		return m > 0 ? `${m}m` : `${sec}s`;
	}

	/** Reloj, antigüedad de los datos y cuenta regresiva de la pausa. */
	everySecond() {
		if (!this.active) {
			return;
		}

		const now = new Date();
		const loc = this.locale();

		this.clockMain.textContent = now.toLocaleTimeString(loc, {hour: '2-digit', minute: '2-digit', second: '2-digit'});

		const age = this.updatedAt ? Math.round((Date.now() - this.updatedAt) / 1000) : 0;

		this.clockSub.textContent = `${now.toLocaleDateString(loc, {weekday: 'short', day: 'numeric', month: 'short'})} · ${this.t('Actualizado hace %1$s', LakaInfra3DNoc.duration(age))}`;

		const left = this.pausedUntil - performance.now();

		if (left > 0) {
			const pause = this.t('Recorrido en pausa · continúa en %1$s s', String(Math.ceil(left / 1000)));

			this.stepText.textContent = this.round && this.round.caption ? `${this.round.caption} — ${pause}` : pause;
			this.el.classList.add('is-paused');
		}
		else {
			this.el.classList.remove('is-paused');

			if (this.round && this.round.caption) {
				this.stepText.textContent = this.round.caption;
			}
		}
	}

	// ---------------------------------------------------------------- recorrido

	/**
	 * Vuelta del recorrido:
	 * 1) vista general de la sala completa, con paredes y puertas;
	 * 2) sin paredes, un giro completo alrededor de todos los racks;
	 * 3) cada rack con problemas, de frente y entero (no equipo por equipo), con el más grave marcado;
	 * 4) elementos de la sala con problemas y, si hay temperaturas, el mapa de calor.
	 */
	newRound(now) {
		const stops = [];
		const racks = new Map();
		const used = new Set();

		for (const x of this.items) {
			if (x.dev) {
				const name = x.dev.d.rack;

				if (!racks.has(name)) {
					racks.set(name, []);
				}

				racks.get(name).push(x);
			}
			else if (!used.has(x.entry.o.id)) {
				used.add(x.entry.o.id);
				stops.push({type: 'problem', item: x});
			}
		}

		// Racks ordenados por su problema más grave (los ítems ya vienen ordenados por severidad).
		const rackStops = [...racks.entries()].map(([name, list]) => ({type: 'rack', rack: name, list, item: list[0]}));
		const all = [...rackStops, ...stops].slice(0, LakaInfra3DNoc.MAX_STOPS);
		const steps = [{type: 'home'}, {type: 'orbit'}, ...all];
		const hasHeat = this.scene.world.devices.some((x) => typeof x.d.temp === 'number')
			|| this.scene.world.objects.some((x) => x.o.kind === 'sensor' && typeof x.o.value === 'number');

		if (hasHeat) {
			steps.push({type: 'heat'});
		}

		this.round = {steps, i: -1, until: 0, start: now, caption: ''};
		this.next(now);
	}

	next(now) {
		const r = this.round;

		r.i++;

		if (r.i >= r.steps.length) {
			this.newRound(now);

			return;
		}

		this.run(r.steps[r.i], now, this.cfg.cycle * 1000);
	}

	run(step, now, ms) {
		const s = this.scene;
		const r = this.round;

		if (step.type !== 'heat' && s.mode !== 'status') {
			s.setMode('status');
		}

		// Paredes solo en la vista general; en el giro y frente a los racks, la sala abierta.
		s.setWalls(step.type === 'home');
		s.clearClip();
		this.orbit = null;

		if (step.type === 'home') {
			s.clearSelection();
			s.closePanel();
			s.flyTo(s.world.home.pos, s.world.home.target, 1600);
			r.caption = this.items.length
				? this.t('Vista general · %1$s problemas activos', String(this.items.length))
				: this.t('Vista general · Sin problemas activos');
		}
		else if (step.type === 'orbit') {
			s.clearSelection();
			s.closePanel();
			this.startOrbit(now);
			ms = Math.max(ms * 2, 30000);
			r.caption = this.items.length
				? this.t('Recorrido por los racks · %1$s problemas activos', String(this.items.length))
				: this.t('Recorrido por los racks · Sin problemas activos');
		}
		else if (step.type === 'rack') {
			const rack = s.world.racks.get(step.rack);
			const top = step.item;
			const dev = s.world.devicesById.get(top.dev.d.id) || top.dev;
			const sev = this.data.severities[top.sev];

			s.closePanel();
			s.selected = dev;
			s.placeOutline(dev);

			if (rack) {
				s.frameRack(rack, dev.d.face === 'back');
			}

			const hosts = [...new Set(step.list.map((x) => x.host))];

			r.caption = `${this.t('Rack')} ${step.rack} · ${this.t('%1$s problemas', String(step.list.length))} · ${top.host} · ${sev.name}: ${top.name}`
				+ (hosts.length > 1 ? ` · ${this.t('Equipos con problemas: %1$s', String(hosts.length))}` : '');
		}
		else if (step.type === 'heat') {
			s.clearSelection();
			s.setMode('heat');
			s.action('top');

			const temps = s.world.devices.map((x) => x.d.temp).filter((v) => typeof v === 'number');

			r.caption = temps.length
				? `${this.t('Mapa de calor')} · ${this.t('Temp. máx.')} ${Math.max(...temps).toFixed(1)} °C`
				: this.t('Mapa de calor');
		}
		else {
			const x = step.item;
			const sev = this.data.severities[x.sev];

			this.focus(x);
			r.caption = `${x.host} · ${sev.name}: ${x.name} · ${x.where} · ${LakaInfra3DNoc.duration(Date.now() / 1000 - x.clock)}`;
		}

		r.until = now + ms;
		r.ms = ms;
		r.stepStart = now;
		this.stepText.textContent = r.caption;
		this.el.style.setProperty('--noc-sev', step.item ? this.data.severities[step.item.sev].color : 'transparent');
	}

	/**
	 * Giro completo alrededor de todos los racks: centro y radio según el espacio que ocupan.
	 */
	startOrbit(now) {
		const s = this.scene;
		const THREE = s.THREE;
		const box = new THREE.Box3();
		let maxH = 2;

		for (const r of s.world.racks.values()) {
			box.expandByPoint(r.center);
			maxH = Math.max(maxH, r.H);
		}

		if (box.isEmpty()) {
			box.expandByPoint(s.world.home.target);
		}

		const center = box.getCenter(new THREE.Vector3());
		const size = box.getSize(new THREE.Vector3());
		// Distancia para que entren todos los racks en pantalla durante todo el giro.
		const half = Math.hypot(size.x, size.z) / 2 + 1.2;
		const fit = half / Math.tan(s.camera.fov * Math.PI / 360);
		const radius = Math.max(6, fit * 0.85);
		const height = maxH + radius * 0.55;
		const cam = s.camera.position;
		const start = Math.atan2(cam.z - center.z, cam.x - center.x);

		center.y = maxH * 0.45;
		this.orbit = {center, radius, height, start, t0: now + 1500, ms: 0};

		// Primero se acerca al punto de partida del giro; después gira solo.
		s.flyTo(new THREE.Vector3(center.x + radius * Math.cos(start), height, center.z + radius * Math.sin(start)), center, 1500);
	}

	/** Avanza el giro en cada cuadro (una vuelta completa en la duración del paso). */
	stepOrbit(now) {
		const o = this.orbit;
		const s = this.scene;

		if (!o || now < o.t0 || s.fly) {
			return;
		}

		const r = this.round;
		const span = Math.max(1, r.until - o.t0);
		const a = o.start + 2 * Math.PI * Math.min(1, (now - o.t0) / span);

		s.camera.position.set(o.center.x + o.radius * Math.cos(a), o.height, o.center.z + o.radius * Math.sin(a));
		s.controls.target.copy(o.center);
	}

	/** Lleva la cámara a un problema: equipo (frente del rack, con contorno) o elemento de la sala. */
	focus(x) {
		const s = this.scene;

		if (x.dev) {
			const dev = s.world.devicesById.get(x.dev.d.id) || x.dev;
			const frame = s.world.racks.get(dev.rack).frame;

			const rack = s.world.racks.get(dev.rack);

			s.selected = dev;
			s.placeOutline(dev);

			// Se muestra el rack entero (no el equipo suelto), con el equipo marcado.
			if (rack) {
				s.frameRack(rack, dev.d.face === 'back');
			}
			else {
				s.flyToFront(frame, dev.center, 1.6 * (dev.d.face === 'back' ? -1 : 1), 0.25);
			}
		}
		else if (x.entry) {
			// Tras una reconstrucción de la sala se usa el elemento nuevo con el mismo identificador.
			s.openObject(s.world.objectsById.get(x.entry.o.id) || x.entry);
			s.closePanel();
		}
	}

	/** Ir a un problema desde la lista o desde una alerta. Manual = el operador lo eligió (pausa). */
	goTo(x, manual) {
		if (!x || !this.active) {
			return;
		}

		const now = performance.now();

		if (manual) {
			this.pausedUntil = now + LakaInfra3DNoc.PAUSE_MS;
		}

		this.run({type: 'problem', item: x}, now, this.cfg.cycle * 1500);
		this.everySecond();
	}

	/** Se llama en cada cuadro de la escena. */
	tick(now) {
		if (!this.active || !this.round) {
			return;
		}

		const r = this.round;
		const step = r.steps[r.i];

		// Si la sala se reconstruyó (datos nuevos), se vuelve a aplicar el estado de las paredes.
		if (this.scene.world !== this.lastWorld) {
			this.lastWorld = this.scene.world;
			this.scene.setWalls(!step || step.type === 'home');
		}

		if (now < this.pausedUntil) {
			r.until = Math.max(r.until, this.pausedUntil);
			this.progress.style.width = '0%';

			return;
		}

		if (step && step.type === 'orbit') {
			this.stepOrbit(now);
		}

		const k = r.ms ? Math.min(1, (now - (r.until - r.ms)) / r.ms) : 0;

		this.progress.style.width = `${Math.round(k * 100)}%`;

		if (now >= r.until) {
			this.next(now);
		}
	}

	// ---------------------------------------------------------------- alertas

	showAlert(x, count) {
		const esc = LakaInfra3DScene.esc;
		const sev = this.data.severities[x.sev];

		this.alertItem = x;
		this.alertEl.style.setProperty('--c', sev.color);
		this.alertEl.innerHTML = `<strong>${esc(count > 1 ? this.t('%1$s problemas nuevos', String(count)) : this.t('Problema nuevo'))}</strong>`
			+ `<span>${esc(sev.name)} · ${esc(x.host)} · ${esc(x.name)}</span><em>${esc(x.where)}</em>`;
		this.alertEl.hidden = false;
		clearTimeout(this.alertTimer);
		this.alertTimer = setTimeout(() => this.hideAlert(), 30000);
	}

	hideAlert() {
		clearTimeout(this.alertTimer);
		this.alertEl.hidden = true;
		this.alertItem = null;
	}

	/** Dos tonos cortos; más agudos para severidad Alta o Desastre. */
	beep(sev) {
		if (!this.cfg.sound) {
			return;
		}

		try {
			this.audio = this.audio || new (window.AudioContext || window.webkitAudioContext)();

			const ctx = this.audio;
			const base = sev >= 4 ? 988 : 784;

			[0, 0.22].forEach((delay, i) => {
				const osc = ctx.createOscillator();
				const gain = ctx.createGain();
				const t0 = ctx.currentTime + delay;

				osc.type = 'sine';
				osc.frequency.value = i === 0 ? base : base * 1.25;
				gain.gain.setValueAtTime(0.0001, t0);
				gain.gain.exponentialRampToValueAtTime(0.25, t0 + 0.02);
				gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.18);
				osc.connect(gain).connect(ctx.destination);
				osc.start(t0);
				osc.stop(t0 + 0.2);
			});
		}
		catch (error) {
			// Sin audio (navegador sin permiso): la alerta visual alcanza.
		}
	}

	dispose() {
		clearInterval(this.clock);
		clearTimeout(this.alertTimer);
		document.removeEventListener('fullscreenchange', this.onFullscreen);
		document.removeEventListener('keydown', this.onKey);

		if (this.fullscreen && document.fullscreenElement === this.scene.root) {
			document.exitFullscreen().catch(() => {});
		}

		if (this.audio) {
			this.audio.close().catch(() => {});
		}
	}
}
