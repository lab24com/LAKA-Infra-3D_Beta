/*
 * LAKA Infra 3D – gemelo digital de data center para Zabbix 7.0 – 8.0
 * © LAKA Soluciones Tecnológicas
 * Autor: Willian Tola
 * Licencia GPLv3
 *
 * Escena 3D: sala, racks, equipos, interacción, ventanas de rack y de equipo.
 * Usa Three.js empaquetado en laka-three.js (global LakaInfra3DThree).
 */

class LakaInfra3DScene {

	// Medidas reales en metros.
	static W = 0.6;			// ancho de rack
	static DEP = 1.0;		// fondo de rack
	static GAP = 0.03;		// separación entre racks
	static UH = 0.0445;		// 1U = 44,45 mm
	static WALL_T = 0.2;		// espesor de la pared donde se empotran las puertas
	static DOOR_H = 2.28;		// alto del vano de la puerta
	static BASE = 0.1;		// zócalo
	static TOP = 0.06;		// techo
	static AISLE = 1.8;		// pasillo frío
	static HOT = 1.2;		// pasillo caliente
	static OK_COLOR = '#59db8f';
	static TILE = 0.6;		// baldosa de piso técnico (600 mm)
	static OFF_COLOR = '#768d99';
	static MAINT_COLOR = '#a78bfa';

	constructor(root, callbacks = {}) {
		const {THREE, OrbitControls} = window.LakaInfra3DThree;

		this.THREE = THREE;
		this.root = root;
		this.cb = callbacks;
		this.data = null;
		this.mode = 'status';
		this.selected = null;
		this.panelState = null;		// {kind: 'rack'|'device'|'warnings', id}
		this.rackFace = 'front';
		this.running = false;
		this.fly = null;
		this.disposables = [];
		this.texCache = new Map();
		this.lastFocus = null;

		this.buildDom();

		// Preferencias de vista por widget (cobertura de cámaras, coordenadas de la grilla): sobreviven a recargar.
		this.prefsKey = callbacks.prefsKey || null;
		const prefs = this.loadPrefs();

		this.coverOn = !!prefs.cover;
		this.gridOn = !!prefs.grid;
		// Sala abierta: sin paredes ni puertas, para recorrer los racks libremente.
		this.wallsOpen = !!prefs.open;
		this.root.querySelector('[data-act="cover"]').setAttribute('aria-pressed', String(this.coverOn));
		this.root.querySelector('[data-act="grid"]').setAttribute('aria-pressed', String(this.gridOn));
		this.root.querySelector('[data-act="walls"]').setAttribute('aria-pressed', String(this.wallsOpen));

		this.renderer = new THREE.WebGLRenderer({antialias: true, alpha: false});
		this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
		this.renderer.outputColorSpace = THREE.SRGBColorSpace;
		this.stage.appendChild(this.renderer.domElement);

		this.scene = new THREE.Scene();
		this.camera = new THREE.PerspectiveCamera(45, 1, 0.05, 400);
		this.controls = new OrbitControls(this.camera, this.renderer.domElement);
		this.controls.enableDamping = true;
		this.controls.dampingFactor = 0.08;
		this.controls.minDistance = 0.6;
		this.controls.maxPolarAngle = Math.PI / 2 - 0.03;
		this.controls.screenSpacePanning = true;
		this.controls.addEventListener('start', () => {
			this.fly = null;
			this.entering = null;
			this.stopTour();

			if (this.noc) {
				this.noc.interact();
			}
		});

		this.hemi = new THREE.HemisphereLight('#cfe3ff', '#20262c', 1.1);
		this.key = new THREE.DirectionalLight('#ffffff', 1.4);
		this.key.position.set(6, 12, 8);
		this.fillLight = new THREE.DirectionalLight('#8fb7ff', 0.5);
		this.fillLight.position.set(-8, 6, -10);

		this.pulseColor = new THREE.Color();
		this.ray = new THREE.Raycaster();
		this.ndc = new THREE.Vector2();
		this.world = null;

		this.bindEvents();

		this.resizeObserver = new ResizeObserver(() => this.resize());
		this.resizeObserver.observe(this.stage);

		this.loop = this.loop.bind(this);

		// Capacidad y planificador (assets/js/capacity.js).
		this.capacity = typeof LakaInfra3DCapacity === 'function' ? new LakaInfra3DCapacity(this) : null;

		// Modo NOC (assets/js/noc.js).
		this.noc = typeof LakaInfra3DNoc === 'function' ? new LakaInfra3DNoc(this) : null;

		// Vista detallada del rack (assets/js/rackview.js).
		this.rackView = typeof LakaInfra3DRackView === 'function' ? new LakaInfra3DRackView(this) : null;

		// Vista detallada del equipo, con cableado (assets/js/devview.js).
		this.devView = typeof LakaInfra3DDevView === 'function' ? new LakaInfra3DDevView(this) : null;

		// Reportes de estado (assets/js/report.js).
		this.report = typeof LakaInfra3DReport === 'function' ? new LakaInfra3DReport(this) : null;
		// Operación: órdenes de trabajo, ciclo de vida y etiquetas QR (assets/js/ops.js).
		this.ops = typeof LakaInfra3DOps === 'function' ? new LakaInfra3DOps(this) : null;
		this.power = typeof LakaInfra3DPower === 'function' ? new LakaInfra3DPower(this) : null;
		this.energy = typeof LakaInfra3DEnergy === 'function' ? new LakaInfra3DEnergy(this) : null;
	}

	// ---------------------------------------------------------------- textos

	t(text, ...args) {
		let out = (this.data && this.data.i18n && this.data.i18n[text]) || text;

		args.forEach((arg, i) => {
			out = out.replace(`%${i + 1}$s`, arg).replace(`%${i + 1}$d`, arg);
		});

		return out;
	}

	static esc(value) {
		return String(value ?? '').replace(/[&<>"']/g, (c) => ({
			'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
		}[c]));
	}

	/**
	 * Tema de Zabbix: blue-theme, dark-theme, hc-light, hc-dark y, desde 8.0, blue-classic-theme,
	 * dark-classic-theme y dark-blue-theme.
	 */
	theme() {
		return document.documentElement.getAttribute('theme') || 'blue-theme';
	}

	/**
	 * true si el widget usa el estilo de colores "Vivo" y el tema no es de alto contraste.
	 */
	isVivid() {
		return !!(this.data && this.data.cfg && this.data.cfg.style === 'vivid') && !this.theme().startsWith('hc-');
	}

	isDark() {
		return this.theme().includes('dark');
	}

	/**
	 * Colores de la escena alineados con el frontend de Zabbix (fondo de página/widget de cada tema).
	 */
	palette() {
		const theme = this.theme();

		// Estilo "Vivo" (configuración del widget). Alto contraste conserva sus colores por accesibilidad.
		if (this.isVivid()) {
			return this.isDark()
				? {bg: '#060b18', floor: '#0f2a4a', cab: '#0d1626', side: '#14223a', rail: '#00a3ff', body: '#16253f',
					okFront: '#1fbf75', label: 'rgba(8,14,30,0.92)', labelText: '#eef7ff', wall: '#1d4f8f'}
				: {bg: '#e6f0fb', floor: '#b7d0ec', cab: '#1a2638', side: '#223249', rail: '#0a84ff', body: '#24344c',
					okFront: '#1fbf75', label: 'rgba(255,255,255,0.95)', labelText: '#0d2440', wall: '#9cc3ee'};
		}

		if (theme === 'dark-blue-theme') {
			return {bg: '#001833', floor: '#24456b', cab: '#0b1f38', side: '#102a4a', rail: '#1d3b61', body: '#14304f',
				okFront: '#4f6d8c', label: 'rgba(0,31,66,0.92)', labelText: '#e5f1ff', wall: '#003a7a'};
		}

		if (this.isDark()) {
			return {bg: '#2b2b2b', floor: '#4a4f54', cab: '#1f2124', side: '#2a2d31', rail: '#3b4045', body: '#2e3236',
				okFront: '#5f676e', label: 'rgba(43,43,43,0.92)', labelText: '#f2f2f2', wall: '#4f4f4f'};
		}

		return {bg: '#ebeef0', floor: '#c9d0d6', cab: '#2d343b', side: '#39414a', rail: '#4b545d', body: '#353c43',
			okFront: '#6b7782', label: 'rgba(255,255,255,0.94)', labelText: '#1f2c33', wall: '#dfe4e7'};
	}

	// ---------------------------------------------------------------- DOM

	buildDom() {
		this.root.classList.add('laka3d');
		this.root.innerHTML = `
			<div class="laka3d-stage"></div>
			<div class="laka3d-toolbar">
				<div class="laka3d-seg" role="group">
					<button type="button" data-mode="status" aria-pressed="true"></button>
					<button type="button" data-mode="heat" aria-pressed="false"></button>
					<button type="button" data-mode="capacity" aria-pressed="false"></button>
					<button type="button" data-mode="power" aria-pressed="false"></button>
				</div>
				<input type="search" class="laka3d-search" autocomplete="off">
				<datalist></datalist>
				<button type="button" class="laka3d-warn" hidden></button>
				<button type="button" class="laka3d-site-btn" hidden>${LakaInfra3DScene.icon('site')}<span></span></button>
				<button type="button" class="laka3d-edit" hidden>${LakaInfra3DScene.icon('edit')}<span></span></button>
				<button type="button" class="laka3d-report-btn">${LakaInfra3DScene.icon('report')}<span></span></button>
				<button type="button" class="laka3d-ops-btn">${LakaInfra3DScene.icon('wrench')}<span></span></button>
				<button type="button" class="laka3d-noc-btn">${LakaInfra3DScene.icon('noc')}<span></span></button>
			</div>
			<div class="laka3d-controls">
				<button type="button" data-act="zin">${LakaInfra3DScene.icon('plus')}</button>
				<button type="button" data-act="zout">${LakaInfra3DScene.icon('minus')}</button>
				<button type="button" data-act="rotate" aria-pressed="false">${LakaInfra3DScene.icon('rotate')}</button>
				<button type="button" data-act="top">${LakaInfra3DScene.icon('top')}</button>
				<button type="button" data-act="aisle">${LakaInfra3DScene.icon('aisle')}</button>
				<button type="button" data-act="home">${LakaInfra3DScene.icon('home')}</button>
				<button type="button" data-act="flow" aria-pressed="false">${LakaInfra3DScene.icon('flow')}</button>
				<button type="button" data-act="cover" aria-pressed="false" hidden>${LakaInfra3DScene.icon('cover')}</button>
				<button type="button" data-act="grid" aria-pressed="false">${LakaInfra3DScene.icon('grid')}</button>
				<button type="button" data-act="walls" aria-pressed="false">${LakaInfra3DScene.icon('walls')}</button>
				<button type="button" data-act="tour" aria-pressed="false">${LakaInfra3DScene.icon('tour')}</button>
			</div>
			<div class="laka3d-caption" role="status" hidden></div>
			<div class="laka3d-panel" hidden></div>
			<div class="laka3d-legend"></div>
			<div class="laka3d-tip" hidden></div>
			<div class="laka3d-toast" role="status" hidden></div>
			<div class="laka3d-brand">© LAKA Soluciones Tecnológicas</div>
		`;

		const id = 'laka3d-hosts-' + Math.random().toString(36).slice(2);

		this.stage = this.root.querySelector('.laka3d-stage');
		this.panel = this.root.querySelector('.laka3d-panel');
		this.tip = this.root.querySelector('.laka3d-tip');
		this.toastEl = this.root.querySelector('.laka3d-toast');
		this.legend = this.root.querySelector('.laka3d-legend');
		this.search = this.root.querySelector('.laka3d-search');
		this.datalist = this.root.querySelector('datalist');
		this.datalist.id = id;
		this.search.setAttribute('list', id);
		this.warnBtn = this.root.querySelector('.laka3d-warn');
		this.editBtn = this.root.querySelector('.laka3d-edit');
		this.nocBtn = this.root.querySelector('.laka3d-noc-btn');
		this.reportBtn = this.root.querySelector('.laka3d-report-btn');
		this.opsBtn = this.root.querySelector('.laka3d-ops-btn');
		this.siteBtn = this.root.querySelector('.laka3d-site-btn');
		this.caption = this.root.querySelector('.laka3d-caption');
	}

	static icon(name) {
		const paths = {
			plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
			minus: '<line x1="5" y1="12" x2="19" y2="12"/>',
			rotate: '<path d="M21 12a9 9 0 1 1-3-6.7"/><polyline points="21 3 21 9 15 9"/>',
			top: '<rect x="4" y="4" width="16" height="16" rx="2"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="12" y1="4" x2="12" y2="20"/>',
			aisle: '<path d="M3 20 9 4h6l6 16"/><line x1="12" y1="8" x2="12" y2="10"/><line x1="12" y1="14" x2="12" y2="17"/>',
			home: '<path d="M3 11 12 4l9 7"/><path d="M5 10v10h14V10"/>',
			edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
			flow: '<path d="M3 8h11a3 3 0 1 0-3-3"/><path d="M3 12h16a3 3 0 1 1-3 3"/><path d="M3 16h7"/>',
			walls: '<path d="M3 20V8l9-5 9 5v12"/><path d="M3 20h18"/><path d="M8 20v-6h8v6" stroke-dasharray="2 2"/>',
			grid: '<rect x="3" y="3" width="18" height="18" rx="1"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/>',
			cover: '<path d="M4 7h10l3 3v0l3-2v8l-3-2-3 3H4z"/><path d="M8 18l-3 3"/><path d="M12 18l3 3"/>',
			tour: '<circle cx="12" cy="12" r="9"/><path d="m10 8 6 4-6 4Z"/>',
			site: '<path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21Z"/><circle cx="12" cy="9.5" r="2.5"/>',
			report: '<path d="M6 2h9l5 5v15H6z"/><polyline points="15 2 15 7 20 7"/><line x1="9" y1="17" x2="9" y2="13"/><line x1="12" y1="17" x2="12" y2="11"/><line x1="15" y1="17" x2="15" y2="14"/>',
			rack: '<rect x="5" y="2" width="14" height="20" rx="1.5"/><line x1="8" y1="7" x2="16" y2="7"/><line x1="8" y1="11" x2="16" y2="11"/><line x1="8" y1="15" x2="16" y2="15"/>',
			wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z"/>',
			qr: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><line x1="14" y1="14" x2="14" y2="17"/><line x1="17" y1="14" x2="21" y2="14"/><line x1="17" y1="17" x2="21" y2="21"/><line x1="14" y1="21" x2="17" y2="21"/>',
			noc: '<rect x="2" y="4" width="20" height="13" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/><polyline points="6 12 9 9 12 12 15 8 18 11"/>'
		};

		return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
	}

	applyTexts() {
		const t = this.t.bind(this);
		const labels = {zin: 'Acercar', zout: 'Alejar', rotate: 'Giro automático', top: 'Vista superior',
			aisle: 'Vista del pasillo', home: 'Vista inicial', flow: 'Flujo de aire', cover: 'Cobertura de cámaras', grid: 'Coordenadas de la grilla', walls: 'Sala abierta (sin paredes)', tour: 'Recorrido guiado'};

		this.root.querySelector('[data-mode="status"]').textContent = t('Estado');
		this.root.querySelector('[data-mode="heat"]').textContent = t('Calor');
		this.root.querySelector('[data-mode="capacity"]').textContent = t('Capacidad');
		this.root.querySelector('[data-mode="power"]').textContent = t('Energía');
		this.root.querySelector('.laka3d-seg').setAttribute('aria-label', t('Modo de color'));
		this.editBtn.querySelector('span').textContent = t('Editar sala');
		this.reportBtn.querySelector('span').textContent = t('Reportes');
		this.reportBtn.title = t('Reportes de estado del data center y de cada rack (imprimir, PDF o CSV)');
		this.opsBtn.querySelector('span').textContent = t('Operación');
		this.opsBtn.title = t('Órdenes de trabajo, ciclo de vida de los equipos y etiquetas QR');
		this.opsBtn.hidden = !this.ops;
		this.nocBtn.querySelector('span').textContent = t('Modo NOC');
		this.nocBtn.title = t('Pantalla de NOC: recorrido automático y alertas de problemas nuevos');
		this.search.placeholder = t('Buscar host…');
		this.search.setAttribute('aria-label', t('Buscar host'));

		for (const [act, label] of Object.entries(labels)) {
			const btn = this.root.querySelector(`[data-act="${act}"]`);

			btn.setAttribute('aria-label', t(label));
			btn.title = t(label);
		}
	}

	// ---------------------------------------------------------------- eventos

	bindEvents() {
		const canvas = this.renderer.domElement;
		let down = null;

		this.on(canvas, 'pointerdown', (e) => {
			down = {x: e.clientX, y: e.clientY};
		});

		this.on(canvas, 'pointerup', (e) => {
			if (down === null || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) {
				down = null;

				return;
			}

			down = null;

			const hit = this.pick(e);

			if (hit && hit.device) {
				// Clic en un equipo: la cámara va al equipo y se abre su vista detallada.
				this.selectDevice(hit.device, {detail: true});
			}
			else if (hit && hit.object) {
				this.openObject(hit.object);
			}
			else if (hit && hit.rack) {
				// Clic en un rack: la cámara va al rack y se abre su vista detallada.
				this.openRack(hit.rack, true, true);
			}
		});

		this.on(canvas, 'pointermove', (e) => {
			if (e.pointerType !== 'mouse' || e.buttons) {
				this.tip.hidden = true;

				return;
			}

			const hit = this.pick(e);
			let text = null;

			if (hit && hit.device) {
				const d = hit.device.d;
				text = `${d.name} · ${this.sevName(d)}`;
			}
			else if (hit && hit.object) {
				const o = hit.object.o;
				const value = this.objectValue(o);

				text = `${o.name || this.kindName(o.kind)} · ${this.kindName(o.kind)}${value !== '' ? ' · ' + value : ''}`;
			}
			else if (hit && hit.rack) {
				text = `${this.t('Rack')} ${hit.rack}`;
			}

			if (text === null) {
				this.tip.hidden = true;
				canvas.style.cursor = 'grab';

				return;
			}

			const r = this.root.getBoundingClientRect();

			this.tip.textContent = text;
			this.tip.style.left = `${e.clientX - r.left + 14}px`;
			this.tip.style.top = `${e.clientY - r.top + 14}px`;
			this.tip.hidden = false;
			canvas.style.cursor = 'pointer';
		});

		this.on(canvas, 'pointerleave', () => {
			this.tip.hidden = true;
		});

		this.root.querySelectorAll('[data-mode]').forEach((btn) => {
			this.on(btn, 'click', () => this.setMode(btn.dataset.mode));
		});

		this.on(this.root.querySelector('.laka3d-controls'), 'click', (e) => {
			const btn = e.target.closest('[data-act]');

			if (btn) {
				this.action(btn.dataset.act);
			}
		});

		this.on(this.search, 'change', () => this.doSearch());
		this.on(this.search, 'keydown', (e) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				this.doSearch();
			}
		});

		this.on(this.warnBtn, 'click', () => this.openWarnings());
		this.on(this.editBtn, 'click', () => this.cb.onEdit && this.cb.onEdit('room'));
		this.on(this.nocBtn, 'click', () => this.noc && this.noc.toggle());
		this.on(this.reportBtn, 'click', () => this.report && this.report.open());
		this.on(this.opsBtn, 'click', () => this.ops && this.ops.open());
		this.on(this.siteBtn, 'click', () => this.cb.onSites && this.cb.onSites());
		this.on(canvas, 'wheel', () => this.noc && this.noc.interact(), {passive: true});
		this.on(this.legend, 'click', (e) => {
			if (e.target.closest('[data-act="unplaced"]') && this.cb.onEdit) {
				this.cb.onEdit('devices');
			}

			if (e.target.closest('[data-act="planner"]') && this.capacity) {
				this.capacity.openPlanner();
			}

			if (e.target.closest('[data-act="ops-wo"]') && this.ops) {
				this.ops.open('wo');
			}

			if (e.target.closest('[data-act="ops-life"]') && this.ops) {
				this.ops.open('life');
			}
		});

		this.on(this.panel, 'click', (e) => this.panelClick(e));
		this.on(this.panel, 'change', (e) => {
			if (this.power && this.panelState && this.panelState.kind === 'power') {
				this.power.panelChange(e);
			}
		});

		this.on(document, 'visibilitychange', () => {
			if (!document.hidden && this.running) {
				requestAnimationFrame(this.loop);
			}
		});
	}

	on(target, type, handler, options) {
		target.addEventListener(type, handler, options);
		this.disposables.push(() => target.removeEventListener(type, handler, options));
	}

	pick(e) {
		if (!this.world) {
			return null;
		}

		const r = this.renderer.domElement.getBoundingClientRect();

		this.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
		this.ray.setFromCamera(this.ndc, this.camera);

		const hit = this.ray.intersectObjects(this.world.pickables, false)[0];

		if (!hit) {
			return null;
		}

		const info = hit.object.userData;

		if (info.kind === 'object') {
			return {object: info.entry};
		}

		if (hit.instanceId === undefined) {
			return null;
		}

		if (info.kind === 'device') {
			return {device: info.devs[hit.instanceId]};
		}

		if (info.kind === 'rack') {
			return {rack: info.ids[hit.instanceId]};
		}

		return null;
	}

	action(act) {
		if (!this.world) {
			return;
		}

		const THREE = this.THREE;
		const b = this.world.bounds;

		switch (act) {
			case 'zin':
			case 'zout': {
				const dir = this.camera.position.clone().sub(this.controls.target);
				const len = THREE.MathUtils.clamp(dir.length() * (act === 'zin' ? 0.75 : 1.33),
					this.controls.minDistance, this.controls.maxDistance
				);

				this.flyTo(this.controls.target.clone().add(dir.setLength(len)), this.controls.target.clone(), 350);
				break;
			}

			case 'rotate':
				this.setAutoRotate(!this.controls.autoRotate);
				break;

			case 'top':
				this.flyTo(new THREE.Vector3(b.cx + 0.01, Math.max(b.w, b.d) * 1.15 + 4, b.cz + 0.6),
					new THREE.Vector3(b.cx, 0, b.cz)
				);
				break;

			case 'aisle':
				this.flyTo(this.world.aisleView.pos, this.world.aisleView.target);
				break;

			case 'flow':
				this.toggleFlow();
				break;

			case 'cover':
				this.toggleCoverage();
				break;

			case 'grid':
				this.toggleGrid();
				break;

			case 'walls':
				this.toggleWalls();
				break;

			case 'tour':
				if (this.tour) {
					this.stopTour();
				}
				else {
					this.startTour();
				}

				break;

			case 'home':
				this.closePanel();
				this.flyTo(this.world.home.pos, this.world.home.target);
				break;
		}
	}

	setAutoRotate(on) {
		this.controls.autoRotate = on;
		this.controls.autoRotateSpeed = 1.0;
		this.root.querySelector('[data-act="rotate"]').setAttribute('aria-pressed', String(on));
	}

	/**
	 * Abre el rack indicado en la dirección (#laka3d-rack=NOMBRE), como lo generan las etiquetas QR.
	 */
	openFromHash() {
		const m = /(?:^|[#&])laka3d-rack=([^&]+)/.exec(window.location.hash || '');

		if (!m || !this.world) {
			return;
		}

		let name = '';

		try {
			name = decodeURIComponent(m[1]);
		}
		catch (e) {
			return;
		}

		if (this.world.racks.has(name)) {
			this.openRack(name);
		}
	}

	doSearch() {
		const q = this.search.value.trim().toLowerCase();

		if (q === '' || !this.world) {
			return;
		}

		const list = this.world.devices;
		const dev = list.find((x) => x.d.name.toLowerCase() === q || x.d.host.toLowerCase() === q)
			|| list.find((x) => x.d.name.toLowerCase().includes(q) || x.d.host.toLowerCase().includes(q));

		if (dev) {
			this.selectDevice(dev);
			this.search.blur();
		}
		else {
			this.toast(this.t('No se encontró ningún equipo con ese nombre.'));
		}
	}

	// ---------------------------------------------------------------- datos

	/**
	 * Recibe los datos del controlador. Si la disposición cambió, reconstruye la sala;
	 * si no, solo actualiza estados, colores y ventanas abiertas.
	 */
	setData(data) {
		const first = this.data === null;
		const style = data.cfg.style || 'zabbix';
		// Un cambio de estilo de colores también rearma la escena (la paleta 3D depende de él).
		const rebuild = first || this.data.sig !== data.sig || this.root.dataset.style !== style;

		this.data = data;
		// Estilo de colores: la hoja de estilos cambia las variables con data-style="vivid".
		this.root.dataset.style = style;

		if (typeof LakaInfra3DCabling === 'function') {
			LakaInfra3DCabling.applyRoles(data.cabling);
		}
		this.applyTexts();
		this.editBtn.hidden = !data.editor;

		if (first) {
			this.mode = data.cfg.mode;
		}

		if (rebuild) {
			this.buildWorld();
			this.applyWalls();

			if (this.capacity) {
				this.capacity.rebuilt();
			}

			if (this.power) {
				this.power.rebuilt();
			}

			if (first) {
				this.camera.position.copy(this.world.home.pos);
				this.controls.target.copy(this.world.home.target);
				this.setAutoRotate(data.cfg.auto_rotate);
				// Enlace directo desde una etiqueta QR: #laka3d-rack=R01 abre ese rack.
				setTimeout(() => this.openFromHash(), 300);
			}
		}
		else {
			const byId = new Map(data.devices.map((d) => [d.id, d]));

			for (const dev of this.world.devices) {
				const fresh = byId.get(dev.d.id);

				if (fresh) {
					dev.d = fresh;
				}
			}

			this.world.devicesById = new Map(this.world.devices.map((x) => [x.d.id, x]));

			// La potencia medida de cada rack cambia en cada lectura.
			for (const def of data.racks) {
				const rack = this.world.racks.get(def.name);

				if (rack) {
					rack.def.power_w = def.power_w;
					rack.def.pdu_count = def.pdu_count;
					rack.def.pdu_sev = def.pdu_sev;
				}
			}

			const objects = new Map((data.objects || []).map((o) => [o.id, o]));

			for (const entry of this.world.objects) {
				if (objects.has(entry.o.id)) {
					entry.o = objects.get(entry.o.id);
				}
			}
		}

		this.applyMode();
		this.renderLegend();
		this.renderWarnings();
		this.fillSearch();

		if (this.selected) {
			const again = this.world.devicesById.get(this.selected.d.id);

			if (again) {
				this.selected = again;
				this.placeOutline(again);
			}
			else {
				this.clearSelection();
			}
		}

		this.refreshPanel();

		if (data.focus && data.focus !== this.lastFocus) {
			const dev = this.world.devicesById.get(String(data.focus));

			if (dev) {
				this.selectDevice(dev, {broadcast: false});
			}
		}

		this.lastFocus = data.focus || null;

		// Sitio y sala actuales; el navegador se muestra si hay más de una sala o permiso para crear.
		const roomCount = (data.sites || []).reduce((n, site) => n + site.rooms.length, 0);

		this.siteBtn.hidden = !(roomCount > 1 || data.editor);
		this.siteBtn.querySelector('span').textContent = `${data.cfg.site ? data.cfg.site + ' · ' : ''}${this.roomName()}`;
		this.siteBtn.title = this.t('Sitios y salas');

		if (this.noc) {
			this.noc.update();
		}
	}

	fillSearch() {
		this.datalist.innerHTML = '';

		for (const dev of this.world.devices) {
			if (!dev.d.passive) {
				const option = document.createElement('option');
				option.value = dev.d.name;
				this.datalist.appendChild(option);
			}
		}
	}

	sevColor(d) {
		if (d.sev >= 0) {
			return this.data.severities[d.sev].color;
		}

		return d.maint ? LakaInfra3DScene.MAINT_COLOR : LakaInfra3DScene.OK_COLOR;
	}

	sevName(d) {
		if (d.passive) {
			return this.t('Equipo pasivo');
		}

		if (d.sev >= 0) {
			return this.data.severities[d.sev].name;
		}

		return d.maint ? this.t('En mantenimiento') : this.t('Sin problemas');
	}

	tempColor(t) {
		const stops = [[18, [59, 130, 196]], [26, [63, 178, 127]], [32, [242, 184, 75]], [37, [240, 140, 67]],
			[42, [214, 60, 60]]];

		if (t === null || t === undefined) {
			return new this.THREE.Color('#4b5560');
		}

		if (t <= stops[0][0]) {
			return new this.THREE.Color(`rgb(${stops[0][1].join(',')})`);
		}

		for (let i = 0; i < stops.length - 1; i++) {
			const [t0, c0] = stops[i];
			const [t1, c1] = stops[i + 1];

			if (t <= t1) {
				const k = (t - t0) / (t1 - t0);

				return new this.THREE.Color(`rgb(${c0.map((v, j) => Math.round(v + (c1[j] - v) * k)).join(',')})`);
			}
		}

		return new this.THREE.Color('rgb(214,60,60)');
	}

	// ---------------------------------------------------------------- texturas

	canvasTex(key, w, h, draw) {
		if (this.texCache.has(key)) {
			return this.texCache.get(key);
		}

		const c = document.createElement('canvas');
		c.width = w;
		c.height = h;
		draw(c.getContext('2d'), w, h);

		const tex = new this.THREE.CanvasTexture(c);
		tex.colorSpace = this.THREE.SRGBColorSpace;
		tex.anisotropy = 4;
		this.texCache.set(key, tex);

		return tex;
	}

	frontTex(type, n) {
		const h = 32 * Math.min(n, 8);
		const base = (g, w, hh) => {
			g.fillStyle = '#e4e7ea';
			g.fillRect(0, 0, w, hh);
		};

		const draw = {
			server: (g, w, hh) => {
				base(g, w, hh);
				g.fillStyle = '#9aa3ab';
				const rows = n >= 2 ? 2 : 1;
				const per = n === 1 ? 8 : 6;

				for (let r = 0; r < rows; r++) {
					for (let i = 0; i < per; i++) {
						const bh = (hh - 10) / rows;
						g.fillRect(150 + i * 46, 5 + r * bh + 3, 38, bh - 6);
					}
				}

				g.fillStyle = '#7b858e';

				for (let i = 0; i < 10; i++) {
					g.fillRect(40 + i * 9, 6, 4, hh - 12);
				}
			},
			storage: (g, w, hh) => {
				base(g, w, hh);
				g.fillStyle = '#9aa3ab';
				const rows = Math.max(1, Math.min(4, n - 1));

				for (let r = 0; r < rows; r++) {
					for (let i = 0; i < 12; i++) {
						g.fillRect(40 + i * 37, 8 + r * ((hh - 16) / rows), 31, (hh - 16) / rows - 6);
					}
				}
			},
			network: (g, w, hh) => {
				base(g, w, hh);
				g.fillStyle = '#6f7a84';
				const rows = n >= 2 ? 2 : 1;

				for (let r = 0; r < rows; r++) {
					for (let i = 0; i < 24; i++) {
						g.fillRect(70 + i * 16 + Math.floor(i / 6) * 6, 7 + r * (hh / rows), 12, hh / rows - 14);
					}
				}
			},
			ups: (g, w, hh) => {
				base(g, w, hh);
				g.fillStyle = '#4a5560';
				g.fillRect(50, hh * 0.25, 120, hh * 0.5);
				g.fillStyle = '#9aa3ab';

				for (let i = 0; i < 16; i++) {
					g.fillRect(220 + i * 16, 10, 8, hh - 20);
				}
			},
			pdu: (g, w, hh) => {
				base(g, w, hh);
				g.fillStyle = '#4a5560';

				for (let i = 0; i < 12; i++) {
					g.fillRect(40 + i * 38, hh * 0.25, 24, hh * 0.5);
				}
			},
			patch: (g, w, hh) => {
				g.fillStyle = '#5a636c';
				g.fillRect(0, 0, w, hh);
				g.fillStyle = '#1d2226';

				for (let r = 0; r < n; r++) {
					for (let i = 0; i < 24; i++) {
						g.fillRect(40 + i * 18, 9 + r * 32, 12, 14);
					}
				}
			},
			other: (g, w, hh) => {
				base(g, w, hh);
				g.fillStyle = '#9aa3ab';
				g.fillRect(40, hh * 0.3, w - 80, hh * 0.4);
			}
		}[type] || ((g, w, hh) => base(g, w, hh));

		return this.canvasTex(`front:${type}:${n}`, 512, h, draw);
	}

	labelTex(text) {
		const pal = this.palette();

		return this.canvasTex(`label:${text}:${this.isDark()}`, 256, 96, (g, w, h) => {
			g.fillStyle = pal.label;
			g.beginPath();

			if (g.roundRect) {
				g.roundRect(8, 14, w - 16, h - 28, 16);
			}
			else {
				g.rect(8, 14, w - 16, h - 28);
			}

			g.fill();
			g.fillStyle = pal.labelText;
			g.font = '700 44px Arial, sans-serif';
			g.textAlign = 'center';
			g.textBaseline = 'middle';
			g.fillText(text.length > 9 ? text.slice(0, 8) + '…' : text, w / 2, h / 2 + 2);
		});
	}

	// ---------------------------------------------------------------- construcción

	disposeWorld() {
		if (!this.world) {
			return;
		}

		this.world.group.traverse((obj) => {
			if (obj.geometry) {
				obj.geometry.dispose();
			}

			if (obj.material) {
				for (const m of Array.isArray(obj.material) ? obj.material : [obj.material]) {
					m.dispose();
				}
			}

			if (obj.isInstancedMesh) {
				obj.dispose();
			}
		});

		for (const tex of this.world.textures) {
			tex.dispose();
		}

		for (const entry of this.world.objects || []) {
			if (entry.label.material.map) {
				entry.label.material.map.dispose();
			}
		}

		if (this.heat && this.heat.mesh.material.map) {
			this.heat.mesh.material.map.dispose();
		}

		this.stopTour();

		this.scene.remove(this.world.group);
		this.world = null;
	}

	/**
	 * Calcula la posición de cada rack según la disposición y arma toda la escena.
	 * Racks y equipos se dibujan con InstancedMesh: una sola llamada de dibujo por tipo de pieza,
	 * así la sala se mantiene fluida con miles de equipos.
	 */
	buildWorld() {
		const THREE = this.THREE;
		const L = LakaInfra3DScene;
		const pal = this.palette();
		const data = this.data;
		const layout = data.cfg.layout;

		this.disposeWorld();

		this.scene.background = new THREE.Color(pal.bg);
		this.scene.add(this.hemi, this.key, this.fillLight);

		const group = new THREE.Group();
		this.scene.add(group);

		const world = {group, racks: new Map(), devices: [], pickables: [], aisles: [], textures: [], pulsing: []};

		// ---- filas: posición en Z y hacia dónde miran
		// Los racks de pared (row_index -1) no forman fila.
		const isWallRack = (r) => r.mount === 'wall';
		const rowIndexes = [...new Set(data.racks.filter((r) => !isWallRack(r)).map((r) => r.row_index))].sort((a, b) => a - b);
		const rowZ = new Map();
		const rowFacing = new Map();

		// Etiqueta de cada fila (para saber si está invertida) y plan de filas y pasillos.
		const labelOf = new Map(data.racks.map((r) => [r.row_index, r.row_label]));
		const rowPlan = LakaInfra3DScene.rowPlan(rowIndexes.map((ri) => labelOf.get(ri)), layout, data.cfg.aisle,
			data.cfg.flips || []
		);

		rowIndexes.forEach((ri, k) => {
			rowZ.set(ri, rowPlan.rows[k].z);
			rowFacing.set(ri, rowPlan.rows[k].facing);
		});

		const rowsByIndex = new Map();

		for (const rack of data.racks) {
			if (isWallRack(rack)) {
				continue;
			}

			if (!rowsByIndex.has(rack.row_index)) {
				rowsByIndex.set(rack.row_index, []);
			}

			rowsByIndex.get(rack.row_index).push(rack);
		}

		// ---- racks: matriz de cada uno
		const m4 = new THREE.Matrix4();
		const tmp = new THREE.Matrix4();
		const yAxis = new THREE.Vector3(0, 1, 0);
		let maxH = 0;

		// X de cada lugar de la fila sumando los anchos (racks de 600/800 mm y aires en fila de 300 mm).
		const rackX = new Map();

		for (const list of rowsByIndex.values()) {
			let x = 0;

			for (const def of list.slice().sort((a, b) => a.index - b.index)) {
				const width = def.width || L.W;

				rackX.set(def.name, x + width / 2);
				x += width + L.GAP;
			}
		}

		for (const def of data.racks) {
			if (isWallRack(def)) {
				continue;
			}

			// Un aire perimetral en la fila mide 1,95 m de alto; los demás lugares, lo que el rack.
			const H = def.kind === 'cooler' && def.model === 'crac' ? 1.95 : def.units * L.UH + L.BASE + L.TOP;
			const facing = rowFacing.get(def.row_index);
			const quat = new THREE.Quaternion().setFromAxisAngle(yAxis, facing === -1 ? Math.PI : 0);
			const pos = new THREE.Vector3(rackX.get(def.name), 0, rowZ.get(def.row_index));
			const matrix = new THREE.Matrix4().compose(pos, quat, new THREE.Vector3(1, 1, 1));

			maxH = Math.max(maxH, H);
			world.racks.set(def.name, {
				// cooler = lugar de la fila que no es gabinete (aire, UPS o baterías): sin equipos ni estructura.
				def, H, width: def.width || L.W, cooler: (def.kind || 'rack') !== 'rack', frame: {pos, quat, matrix},
				center: new THREE.Vector3(0, H / 2, 0).applyMatrix4(matrix),
				devices: [], barIndex: 0
			});
		}

		// ---- pasillos: frío (frentes), caliente (espaldas) o mixto, con el ancho de las filas que lo bordean
		const rowExtent = (ri) => {
			const list = (rowsByIndex.get(ri) || []).map((r) => world.racks.get(r.name));

			return {x0: Math.min(...list.map((r) => r.frame.pos.x - r.width / 2)),
				x1: Math.max(...list.map((r) => r.frame.pos.x + r.width / 2)),
				h: Math.min(...list.map((r) => r.H))};
		};
		const aisleRects = rowPlan.aisles.map((a) => {
			const ea = rowExtent(rowIndexes[a.a]);
			const eb = a.b !== null ? rowExtent(rowIndexes[a.b]) : ea;

			return Object.assign({}, a, {x0: Math.min(ea.x0, eb.x0), x1: Math.max(ea.x1, eb.x1), h: Math.min(ea.h, eb.h)});
		});

		// ---- límites de la sala: racks, pasillos y elementos sueltos (los de pared se acomodan a estos límites)
		const box = new THREE.Box3();

		for (const rack of world.racks.values()) {
			box.expandByPoint(new THREE.Vector3(-rack.width / 2, 0, -L.DEP / 2).applyMatrix4(rack.frame.matrix));
			box.expandByPoint(new THREE.Vector3(rack.width / 2, rack.H, L.DEP / 2).applyMatrix4(rack.frame.matrix));
		}

		for (const a of aisleRects) {
			box.expandByPoint(new THREE.Vector3(a.x0, 0, a.z0));
			box.expandByPoint(new THREE.Vector3(a.x1, 0, a.z1));
		}

		const rackBox = box.clone();

		for (const o of data.objects || []) {
			if (o.mount === 'floor') {
				box.expandByPoint(new THREE.Vector3(o.x, 0, o.z));
			}
		}

		if (box.isEmpty()) {
			box.set(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 2, 1));
		}

		const margin = 1.5;
		const size = data.cfg.room_size || {w: 0, d: 0};
		const b = {minX: box.min.x - margin, maxX: box.max.x + margin, minZ: box.min.z - margin, maxZ: box.max.z + margin};

		// Medidas fijas de la sala: centradas en los racks.
		if (size.w > 0 || size.d > 0) {
			const ref = rackBox.isEmpty() ? box : rackBox;
			const cx = (ref.min.x + ref.max.x) / 2;
			const cz = (ref.min.z + ref.max.z) / 2;

			if (size.w > 0) {
				b.minX = cx - size.w / 2;
				b.maxX = cx + size.w / 2;
			}

			if (size.d > 0) {
				b.minZ = cz - size.d / 2;
				b.maxZ = cz + size.d / 2;
			}
		}

		b.w = b.maxX - b.minX;
		b.d = b.maxZ - b.minZ;
		b.cx = (b.minX + b.maxX) / 2;
		b.cz = (b.minZ + b.maxZ) / 2;
		world.bounds = b;

		// ---- racks de pared: colgados en su pared, a la altura indicada y con su fondo (350/450/600 mm).
		// La matriz escala el fondo, así gabinete, rieles y equipos quedan del fondo real.
		for (const def of data.racks.filter(isWallRack)) {
			const H = def.units * L.UH + L.BASE + L.TOP;
			const depth = def.depth > 0 ? def.depth : 0.45;
			const width = def.width || L.W;
			const len = def.wall === 'n' || def.wall === 's' ? b.maxX - b.minX : b.maxZ - b.minZ;
			const off = Math.min(Math.max(def.offset || 0, width / 2), Math.max(width / 2, len - width / 2));
			const inset = depth / 2 + 0.02;
			// Base por defecto: el techo del gabinete a 2 m del piso.
			const y = def.height > 0 ? def.height : Math.max(0.3, 2.0 - H);
			let x;
			let z;
			let rot;

			switch (def.wall) {
				case 's':
					[x, z, rot] = [b.minX + off, b.maxZ - inset, 180];
					break;

				case 'w':
					[x, z, rot] = [b.minX + inset, b.minZ + off, 270];
					break;

				case 'e':
					[x, z, rot] = [b.maxX - inset, b.minZ + off, 90];
					break;

				default:
					[x, z, rot] = [b.minX + off, b.minZ + inset, 0];
			}

			const quat = new THREE.Quaternion().setFromAxisAngle(yAxis, -rot * Math.PI / 180);
			const pos = new THREE.Vector3(x, y, z);
			const matrix = new THREE.Matrix4().compose(pos, quat, new THREE.Vector3(1, 1, depth / L.DEP));

			maxH = Math.max(maxH, y + H);
			world.racks.set(def.name, {
				def, H, width, cooler: false, wall: true, depth, frame: {pos, quat, matrix},
				center: new THREE.Vector3(0, H / 2, 0).applyMatrix4(matrix),
				devices: [], barIndex: 0
			});
		}

		// Piezas del gabinete agrupadas por alto del rack (cada alto tiene su geometría).
		const cabMat = new THREE.MeshStandardMaterial({color: pal.cab, roughness: 0.6, metalness: 0.4});
		const sideMat = new THREE.MeshStandardMaterial({color: pal.side, roughness: 0.7, metalness: 0.2});
		const railMat = new THREE.MeshStandardMaterial({color: pal.rail, roughness: 0.5, metalness: 0.6});
		const byUnits = new Map();

		for (const rack of world.racks.values()) {
			if (rack.cooler) {
				continue;
			}

			const k = `${rack.def.units}|${rack.width}`;

			if (!byUnits.has(k)) {
				byUnits.set(k, []);
			}

			byUnits.get(k).push(rack);
		}

		for (const racks of byUnits.values()) {
			const units = racks[0].def.units;
			const RW = racks[0].width;
			const H = units * L.UH + L.BASE + L.TOP;
			const t = 0.025;
			const zTop = H - L.TOP;
			// Gabinete abierto adelante y atrás (rieles en las dos caras) para ver los equipos montados atrás.
			const parts = [
				[0.03, zTop - L.BASE, 0.03, -RW / 2 + 0.06, (zTop + L.BASE) / 2, -L.DEP / 2 + 0.05, railMat],
				[0.03, zTop - L.BASE, 0.03, RW / 2 - 0.06, (zTop + L.BASE) / 2, -L.DEP / 2 + 0.05, railMat],
				[t, H, L.DEP, -RW / 2 + t / 2, H / 2, 0, sideMat],
				[t, H, L.DEP, RW / 2 - t / 2, H / 2, 0, sideMat],
				[RW, L.TOP, L.DEP, 0, H - L.TOP / 2, 0, cabMat],
				[RW, L.BASE, L.DEP, 0, L.BASE / 2, 0, cabMat],
				[0.03, zTop - L.BASE, 0.03, -RW / 2 + 0.06, (zTop + L.BASE) / 2, L.DEP / 2 - 0.05, railMat],
				[0.03, zTop - L.BASE, 0.03, RW / 2 - 0.06, (zTop + L.BASE) / 2, L.DEP / 2 - 0.05, railMat]
			];

			for (const [w, h, d, x, y, z, mat] of parts) {
				const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(w, h, d), mat, racks.length);
				const local = new THREE.Matrix4().makeTranslation(x, y, z);

				racks.forEach((rack, i) => {
					mesh.setMatrixAt(i, m4.multiplyMatrices(rack.frame.matrix, local));
				});

				mesh.userData = {kind: 'rack', ids: racks.map((r) => r.def.name)};
				this.finishInstanced(mesh, group, world);
			}
		}

		// Barra de estado sobre cada rack (color por instancia).
		const allRacks = [...world.racks.values()];
		const racksList = allRacks.filter((r) => !r.cooler);
		const bars = new THREE.InstancedMesh(new THREE.BoxGeometry(L.W, 0.03, 0.03),
			new THREE.MeshBasicMaterial({color: '#ffffff'}), Math.max(1, racksList.length)
		);

		racksList.forEach((rack, i) => {
			rack.barIndex = i;
			bars.setMatrixAt(i, m4.multiplyMatrices(rack.frame.matrix,
				tmp.makeTranslation(0, rack.H + 0.005, L.DEP / 2 - 0.015).scale(new THREE.Vector3(rack.width / L.W, 1, 1))
			));
			bars.setColorAt(i, new THREE.Color('#59636d'));
		});
		bars.count = racksList.length;
		bars.userData = {kind: 'rack', ids: racksList.map((r) => r.def.name)};
		this.finishInstanced(bars, group, world);
		world.bars = bars;

		// PDU verticales (0U) en la parte trasera del rack, con sus tomas dibujadas.
		world.vpdus = [];

		const vpduGroups = new Map();

		for (const rack of racksList) {
			const count = rack.def.vpdu || 0;

			for (let i = 0; i < count; i++) {
				const k = rack.def.outlets || 24;

				if (!vpduGroups.has(k)) {
					vpduGroups.set(k, []);
				}

				vpduGroups.get(k).push({rack, i});
			}
		}

		for (const [outlets, list] of vpduGroups) {
			const tex = this.canvasTex(`vpdu-${outlets}`, 32, 512, (g, w, h) => {
				g.fillStyle = '#1d2226';
				g.fillRect(0, 0, w, h);
				g.fillStyle = '#9aa3ab';

				for (let n = 0; n < outlets; n++) {
					g.fillRect(9, 28 + n * ((h - 56) / outlets), 14, Math.max(4, (h - 56) / outlets * 0.55));
				}

				g.fillStyle = '#59db8f';
				g.fillRect(10, 8, 12, 10);
			});
			const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1),
				new THREE.MeshStandardMaterial({map: tex, roughness: 0.6, metalness: 0.3}), list.length
			);

			list.forEach(({rack, i}, n) => {
				const inner = rack.H - L.BASE - L.TOP;
				const side = i % 2 === 0 ? -1 : 1;
				const x = side * (rack.width / 2 - (i < 2 ? 0.045 : 0.1));
				const local = new THREE.Matrix4().compose(
					new THREE.Vector3(x, L.BASE + inner / 2, -L.DEP / 2 + 0.09),
					new THREE.Quaternion(), new THREE.Vector3(0.05, inner * 0.9, 0.05)
				);

				mesh.setMatrixAt(n, m4.multiplyMatrices(rack.frame.matrix, local));
				mesh.setColorAt(n, new THREE.Color('#ffffff'));
				world.vpdus.push({mesh, n, rack, letter: i});
			});

			mesh.frustumCulled = false;
			group.add(mesh);
		}

		// Nombres de los racks.
		if (data.cfg.labels) {
			for (const rack of racksList) {
				const label = new THREE.Sprite(new THREE.SpriteMaterial({map: this.labelTex(rack.def.name), transparent: true}));
				label.scale.set(0.38, 0.145, 1);
				label.position.copy(new THREE.Vector3(0, rack.H + 0.2, L.DEP / 2 - 0.1).applyMatrix4(rack.frame.matrix));
				group.add(label);
			}
		}

		// ---- equipos
		const devs = [];

		for (const d of data.devices) {
			const rack = world.racks.get(d.rack);

			if (!rack) {
				continue;
			}

			const n = Math.max(1, d.n);
			const y = L.BASE + (d.u - 1) * L.UH + n * L.UH / 2;
			const local = new THREE.Matrix4().makeTranslation(0, y, 0.01);

			if (d.face === 'back') {
				local.multiply(tmp.makeRotationY(Math.PI));
			}

			const matrix = new THREE.Matrix4().multiplyMatrices(rack.frame.matrix, local);
			const quat = new THREE.Quaternion();
			const center = new THREE.Vector3();

			matrix.decompose(center, quat, new THREE.Vector3());

			const dev = {d, rack: d.rack, n, w: rack.width - 0.15, matrix, center, quat, body: null, front: null, led: null};

			devs.push(dev);
			rack.devices.push(dev);
		}

		const bodyMat = new THREE.MeshStandardMaterial({color: pal.body, roughness: 0.6, metalness: 0.3});
		const groupBy = (list, keyFn) => {
			const map = new Map();

			for (const item of list) {
				const k = keyFn(item);

				if (!map.has(k)) {
					map.set(k, []);
				}

				map.get(k).push(item);
			}

			return map;
		};

		// Cuerpo de cada equipo, agrupado por alto.
		for (const list of groupBy(devs, (x) => `${x.n}|${x.w}`).values()) {
			const {n, w} = list[0];
			const hgt = n * L.UH - 0.004;
			const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(w, hgt, L.DEP - 0.12), bodyMat,
				list.length
			);

			list.forEach((dev, i) => {
				mesh.setMatrixAt(i, dev.matrix);
				dev.body = {mesh, i};
			});

			mesh.userData = {kind: 'device', devs: list};
			this.finishInstanced(mesh, group, world);
		}

		// Frente de cada equipo (textura según tipo y alto, color por instancia).
		for (const [, list] of groupBy(devs, (x) => `${x.d.type}|${x.n}|${x.w}`)) {
			const {n, w} = list[0];
			const hgt = n * L.UH - 0.004;
			const mat = new THREE.MeshStandardMaterial({map: this.frontTex(list[0].d.type, n), color: '#ffffff',
				roughness: 0.5, metalness: 0.15
			});
			const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(w, hgt), mat, list.length);
			const offset = new THREE.Matrix4().makeTranslation(0, 0, (L.DEP - 0.12) / 2 + 0.002);

			list.forEach((dev, i) => {
				mesh.setMatrixAt(i, m4.multiplyMatrices(dev.matrix, offset));
				mesh.setColorAt(i, new THREE.Color('#ffffff'));
				dev.front = {mesh, i};
			});

			mesh.userData = {kind: 'device', devs: list};
			this.finishInstanced(mesh, group, world);
		}

		// Luz de estado (no se ilumina: siempre brillante).
		const lit = devs.filter((x) => x.d.type !== 'patch');

		if (lit.length) {
			const leds = new THREE.InstancedMesh(new THREE.BoxGeometry(0.012, 0.025, 0.006),
				new THREE.MeshBasicMaterial({color: '#ffffff'}), lit.length
			);
			lit.forEach((dev, i) => {
				const offset = tmp.makeTranslation(-dev.w / 2 + 0.025, 0, (L.DEP - 0.12) / 2 + 0.006);

				leds.setMatrixAt(i, m4.multiplyMatrices(dev.matrix, offset));
				leds.setColorAt(i, new THREE.Color('#000000'));
				dev.led = {mesh: leds, i};
			});

			leds.userData = {kind: 'led'};
			this.finishInstanced(leds, group, null);
		}

		world.devices = devs;


		// ---- infraestructura de la sala (aires, UPS, tablero, sensores, puertas)
		world.objects = [];

		for (const o of data.objects || []) {
			const entry = this.buildObject(o, world);

			if (entry) {
				group.add(entry.group);
				world.objects.push(entry);
			}
		}

		world.objectsById = new Map(world.objects.map((x) => [x.o.id, x]));

		// El botón de cobertura solo aparece si la sala tiene cámaras.
		this.root.querySelector('[data-act="cover"]').hidden = !world.objects.some((x) => x.cover);

		// Paredes translúcidas cuando la sala tiene medidas o infraestructura (el modo NOC las oculta al girar).
		world.walls = [];

		if (size.w > 0 || size.d > 0 || world.objects.length) {
			const wallMat = new THREE.MeshBasicMaterial({color: pal.wall, transparent: true, opacity: 0.16,
				depthWrite: false, side: THREE.DoubleSide
			});
			const trimMat = new THREE.MeshBasicMaterial({color: pal.wall, transparent: true, opacity: 0.55});
			const WH = 2.9;
			const DH = LakaInfra3DScene.DOOR_H;

			// Cada pared se arma por tramos: deja el vano de las puertas empotradas y el dintel encima.
			for (const wall of ['n', 's', 'w', 'e']) {
				const along = wall === 'n' || wall === 's';
				const len = along ? b.w : b.d;
				const holes = this.wallOpenings(data.objects || [], wall, len);
				const put = (from, to, y0, y1) => {
					if (to - from < 0.01 || y1 - y0 < 0.01) {
						return;
					}

					const mesh = new THREE.Mesh(new THREE.PlaneGeometry(to - from, y1 - y0), wallMat);
					const mid = (from + to) / 2;

					mesh.position.set(along ? b.minX + mid : (wall === 'w' ? b.minX : b.maxX), (y0 + y1) / 2,
						along ? (wall === 'n' ? b.minZ : b.maxZ) : b.minZ + mid
					);
					mesh.rotation.y = along ? 0 : Math.PI / 2;
					group.add(mesh);
					world.walls.push(mesh);
				};
				let cursor = 0;

				for (const [h0, h1] of holes) {
					put(cursor, h0, 0, WH);
					put(h0, h1, DH, WH);
					cursor = h1;
				}

				put(cursor, len, 0, WH);

				const trim = new THREE.Mesh(new THREE.BoxGeometry(len, 0.04, 0.04), trimMat);

				trim.position.set(along ? b.cx : (wall === 'w' ? b.minX : b.maxX), WH, along ? (wall === 'n' ? b.minZ : b.maxZ) : b.cz);
				trim.rotation.y = along ? 0 : Math.PI / 2;
				group.add(trim);
				world.walls.push(trim);
			}
		}

		// ---- piso técnico
		const tileTex = this.canvasTex('tile', 256, 256, (g, w, h) => {
			g.fillStyle = '#d8dde2';
			g.fillRect(0, 0, w, h);
			g.strokeStyle = '#7d8790';
			g.lineWidth = 8;
			g.strokeRect(0, 0, w, h);
		}).clone();

		tileTex.wrapS = tileTex.wrapT = THREE.RepeatWrapping;
		tileTex.repeat.set(b.w / 0.6, b.d / 0.6);
		// La textura arranca en la esquina de abajo; se corre para que las baldosas coincidan con la grilla.
		tileTex.offset.set(0, (Math.ceil(b.d / 0.6 - 1e-6) - b.d / 0.6) % 1);
		tileTex.needsUpdate = true;
		world.textures.push(tileTex);

		const floor = new THREE.Mesh(new THREE.PlaneGeometry(b.w, b.d),
			new THREE.MeshStandardMaterial({map: tileTex, color: pal.floor, roughness: 0.9})
		);

		floor.rotation.x = -Math.PI / 2;
		floor.position.set(b.cx, 0, b.cz);
		group.add(floor);

		// ---- baldosas perforadas en los pasillos fríos
		const perfTex = this.canvasTex('perf', 256, 256, (g, w, h) => {
			g.fillStyle = '#d8dde2';
			g.fillRect(0, 0, w, h);
			g.strokeStyle = '#7d8790';
			g.lineWidth = 8;
			g.strokeRect(0, 0, w, h);
			g.fillStyle = '#5d6a75';

			for (let i = 0; i < 9; i++) {
				for (let j = 0; j < 9; j++) {
					g.beginPath();
					g.arc(40 + i * 22, 40 + j * 22, 5, 0, Math.PI * 2);
					g.fill();
				}
			}
		});

		const hotMat = new THREE.MeshStandardMaterial({color: '#6b3f3a', roughness: 0.9, emissive: '#2a0d0a',
			emissiveIntensity: 0.35, transparent: true, opacity: 0.85
		});
		const addAisle = (a) => {
			const w = a.x1 - a.x0;
			const d = a.z1 - a.z0;

			if (!(w > 0 && d > 0)) {
				return;
			}

			let m;

			if (a.type === 'hot') {
				// Pasillo caliente: piso ciego, con un tono cálido.
				m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), hotMat);
			}
			else {
				// Pasillo frío o mixto: baldosas perforadas por donde sube el aire frío.
				const tex = perfTex.clone();

				tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
				tex.repeat.set(Math.max(1, Math.round(w / 0.6)), Math.max(1, Math.round(d / 0.6)));
				tex.needsUpdate = true;
				world.textures.push(tex);
				m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshStandardMaterial({
					map: tex, color: '#4d86ad', roughness: 0.8, emissive: '#0d2a40', emissiveIntensity: 0.5
				}));
			}

			m.rotation.x = -Math.PI / 2;
			m.position.set((a.x0 + a.x1) / 2, 0.003, (a.z0 + a.z1) / 2);
			group.add(m);
			world.aisles.push(a);

			// Contención: techo y puertas en los extremos del pasillo contenido (entre dos filas).
			if (a.b !== null && data.cfg.contain && data.cfg.contain === a.type) {
				this.buildContainment(a, group);
			}
		};

		for (const a of aisleRects) {
			addAisle(a);
		}

		// ---- cámaras de referencia
		const span = Math.max(b.w, b.d);
		const firstAisle = world.aisles.find((a) => a.sides.length) || world.aisles[0];

		this.controls.maxDistance = span * 3 + 10;

		world.home = {
			pos: new THREE.Vector3(b.minX - span * 0.28, maxH + span * 0.4, b.cz + span * 0.22),
			target: new THREE.Vector3(b.cx, 0.6, b.cz)
		};

		world.aisleView = firstAisle
			? {
				pos: new THREE.Vector3(firstAisle.x0 - 2.2, 1.6, (firstAisle.z0 + firstAisle.z1) / 2),
				target: new THREE.Vector3((firstAisle.x0 + firstAisle.x1) / 2, 1.0, (firstAisle.z0 + firstAisle.z1) / 2)
			}
			: world.home;

		// ---- contorno de selección
		const outline = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
			new THREE.LineBasicMaterial({color: '#ffffff', depthTest: false, transparent: true})
		);

		outline.renderOrder = 20;
		outline.visible = false;
		group.add(outline);
		world.outline = outline;

		world.devicesById = new Map(devs.map((x) => [x.d.id, x]));
		this.world = world;
		this.flow = null;
		this.heat = null;

		if (this.flowOn) {
			this.buildFlow();
		}

		if (this.gridOn) {
			this.buildGrid();
		}

		this.resize();
	}

	/**
	 * Cierra un InstancedMesh: marca matrices y colores, calcula sus límites (para el recorte y la
	 * selección con el mouse) y lo agrega a la escena.
	 */
	finishInstanced(mesh, group, world) {
		mesh.instanceMatrix.needsUpdate = true;

		if (mesh.instanceColor) {
			mesh.instanceColor.needsUpdate = true;
		}

		mesh.computeBoundingBox();
		mesh.computeBoundingSphere();
		group.add(mesh);

		if (world) {
			world.pickables.push(mesh);
		}
	}

	// ---------------------------------------------------------------- infraestructura

	kindName(kind) {
		return this.t(LakaInfra3DScene.KIND_NAMES[kind] || kind);
	}

	// Nombres de los elementos de sala (también los usan el editor y los reportes).
	static KIND_NAMES = {crac: 'Aire de precisión', inrow: 'Aire en fila', split: 'Split de pared', ups: 'UPS de sala',
		battery: 'Banco de baterías', panel: 'Tablero eléctrico', sensor: 'Sensor ambiental', door: 'Puerta',
		access: 'Control de acceso', camera: 'Cámara de seguridad', motion: 'Sensor de movimiento',
		smoke: 'Detector de incendio', vesda: 'Detección por aspiración (VESDA)', firepanel: 'Central de alarma de incendio',
		suppression: 'Sistema de supresión', extinguisher: 'Extintor', epo: 'Pulsador de apagado de emergencia (EPO)',
		light: 'Luz de emergencia', leak: 'Sensor de fugas de agua', ground: 'Barra de tierra (TGB)',
		generator: 'Grupo electrógeno', ats: 'Transferencia automática (ATS)', transformer: 'Transformador / acometida',
		cdu: 'Unidad de distribución de refrigerante (CDU)', rdhx: 'Intercambiador de puerta trasera', wap: 'Punto de acceso Wi-Fi',
		water: 'Medidor de agua', solar: 'Inversor solar / renovable'};

	// Variantes de cada elemento (campo "batt" del objeto).
	static VARIANTS = {
		camera: ['Domo', 'Bala', 'PTZ'],
		access: ['Tarjeta de proximidad', 'Biométrico (huella)', 'Biométrico + tarjeta', 'Teclado (PIN)', 'Reconocimiento facial'],
		smoke: ['Humo (fotoeléctrico)', 'Temperatura (térmico)', 'Multicriterio (humo y temperatura)'],
		suppression: ['Agente limpio HFC-227ea (FM-200)', 'Agente limpio FK-5-1-12 (Novec 1230)', 'Gas inerte (IG-541 / IG-55)',
			'Agua nebulizada', 'Rociadores de preacción'],
		extinguisher: ['CO₂', 'Agente limpio']
	};

	// Elementos chicos que van a una altura (en la pared o el techo): su posición es la del aparato.
	static SMALL_KINDS = ['sensor', 'access', 'camera', 'motion', 'smoke', 'vesda', 'firepanel', 'extinguisher', 'epo', 'light',
		'ground', 'wap', 'water'];

	// Altura de instalación por defecto (m).
	static DEFAULT_HEIGHT = {sensor: 1.5, access: 1.2, camera: 2.6, motion: 2.6, smoke: 3.0, vesda: 1.5, firepanel: 1.5,
		extinguisher: 1.0, epo: 1.3, light: 2.4, ground: 1.2, wap: 2.8, water: 0.6};

	static variantName(o, t = (x) => x) {
		const list = LakaInfra3DScene.VARIANTS[o.kind];

		return list ? t(list[Math.max(1, Math.min(list.length, o.batt || 1)) - 1]) : '';
	}

	/**
	 * Arma el modelo 3D de un objeto de infraestructura. Las medidas son las típicas de cada equipo.
	 * Un sensor con rack va pegado al frente (o atrás) del rack, arriba, al medio o abajo.
	 */
	buildObject(o, world) {
		const THREE = this.THREE;
		const L = LakaInfra3DScene;
		const group = new THREE.Group();
		const pick = [];
		const box = (w, h, d, x, y, z, color, extra = {}) => {
			const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d),
				new THREE.MeshStandardMaterial(Object.assign({color, roughness: 0.6, metalness: 0.2}, extra))
			);

			m.position.set(x, y, z);
			group.add(m);
			pick.push(m);

			return m;
		};
		const grille = (w, h, x, y, z) => {
			const tex = this.canvasTex('grille', 256, 256, (g, cw, ch) => {
				g.fillStyle = '#a7b0b8';
				g.fillRect(0, 0, cw, ch);
				g.fillStyle = '#5d6a75';

				for (let i = 0; i < 16; i++) {
					g.fillRect(0, i * 16 + 4, cw, 7);
				}
			});
			const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({map: tex}));

			m.position.set(x, y, z);
			group.add(m);
			pick.push(m);
		};
		const statusMat = new THREE.MeshBasicMaterial({color: L.OFF_COLOR});
		const status = (w, x, y, z) => {
			const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.035, 0.035), statusMat);

			m.position.set(x, y, z);
			group.add(m);
		};

		let height = 2.0;
		let leaf = null;
		let dot = null;
		const slotOf = (x) => (x.mount === 'row' && world.racks.has(x.rack) ? world.racks.get(x.rack) : null);

		switch (o.kind) {
			case 'crac': {
				// Aire de precisión perimetral (CRAC/CRAH): chico 1,0 m, mediano 1,8 m, grande 2,5 m,
				// o el ancho de su lugar cuando está al final de una fila (pasillo caliente).
				const dim = LakaInfra3DScene.objectDims(o, slotOf(o));
				const panels = Math.max(1, Math.round(dim.w / 0.9));
				const pw = dim.w / panels;

				box(dim.w, dim.h, dim.d, 0, dim.h / 2, 0, '#d9dee2');

				for (let n = 0; n < panels; n++) {
					grille(pw - 0.1, dim.h * 0.55, -dim.w / 2 + pw * (n + 0.5), dim.h * 0.62, dim.d / 2 + 0.002);
				}

				box(0.26, 0.14, 0.01, -dim.w / 2 + 0.25, dim.h * 0.28, dim.d / 2 + 0.005, '#000000',
					{emissive: '#59db8f', emissiveIntensity: 0.8}
				);
				status(dim.w, 0, dim.h + 0.02, dim.d / 2 - 0.02);
				height = dim.h + 0.05;
				break;
			}

			case 'inrow': {
				// En fila toma el ancho y el alto del lugar que ocupa.
				const slot = o.mount === 'row' && world.racks.has(o.rack) ? world.racks.get(o.rack) : null;
				const iw = slot ? slot.width : 0.3;
				const ih = slot ? slot.H : 2.0;

				box(iw, ih, 1.0, 0, ih / 2, 0, '#d9dee2');
				grille(Math.max(0.1, iw - 0.06), ih * 0.8, 0, ih * 0.55, 0.502);
				status(iw, 0, ih + 0.02, 0.48);
				height = ih + 0.05;
				break;
			}

			case 'split':
				box(0.9, 0.28, 0.22, 0, 2.35, 0, '#f2f4f5');
				box(0.84, 0.04, 0.01, 0, 2.25, 0.112, '#9aa3ab');
				status(0.12, 0.36, 2.44, 0.11);
				height = 2.5;
				break;

			case 'ups': {
				// UPS: torre chica, gabinete mediano o modular grande; al lado, sus gabinetes de baterías.
				const dim = LakaInfra3DScene.objectDims(o, slotOf(o));
				const uw = dim.unit;

				box(uw, dim.h, dim.d, -dim.w / 2 + uw / 2, dim.h / 2, 0, '#2b3137');
				box(Math.min(0.28, uw * 0.6), 0.18, 0.01, -dim.w / 2 + uw / 2, dim.h * 0.78, dim.d / 2 + 0.005, '#000000',
					{emissive: '#7499ff', emissiveIntensity: 0.9}
				);

				// Módulos de potencia en el frente de las UPS medianas y grandes.
				for (let n = 0; uw >= 0.6 && n < 4; n++) {
					box(uw - 0.12, 0.1, 0.01, -dim.w / 2 + uw / 2, dim.h * 0.3 + n * 0.13, dim.d / 2 + 0.005, '#3c454d');
				}

				for (let n = 0; n < dim.batt; n++) {
					const bx = -dim.w / 2 + uw + 0.8 * n + 0.4;

					box(0.78, dim.h, dim.d, bx, dim.h / 2, 0, '#22272c');
					box(0.6, 0.04, 0.01, bx, dim.h * 0.85, dim.d / 2 + 0.005, '#ffc859');
				}

				status(dim.w, 0, dim.h + 0.02, dim.d / 2 - 0.02);
				height = dim.h + 0.05;
				break;
			}

			case 'battery': {
				// Banco de baterías: uno a tres gabinetes de 0,6 m, o el lugar de la fila que ocupa.
				const dim = LakaInfra3DScene.objectDims(o, slotOf(o));
				const cabinets = Math.max(1, Math.round(dim.w / 0.6));
				const cw = dim.w / cabinets;

				for (let n = 0; n < cabinets; n++) {
					const bx = -dim.w / 2 + cw * (n + 0.5);

					box(cw - 0.02, dim.h, dim.d, bx, dim.h / 2, 0, '#22272c');
					box(cw * 0.7, 0.04, 0.01, bx, dim.h * 0.85, dim.d / 2 + 0.005, '#ffc859');

					for (let k = 0; k < 6; k++) {
						box(cw * 0.7, 0.012, 0.01, bx, dim.h * 0.2 + k * dim.h * 0.1, dim.d / 2 + 0.005, '#3c454d');
					}
				}

				status(dim.w, 0, dim.h + 0.02, dim.d / 2 - 0.02);
				height = dim.h + 0.05;
				break;
			}

			case 'ats':
				// Tablero de transferencia: gabinete de pared con su conmutador y luces de red / generador.
				box(0.7, 1.2, 0.3, 0, 1.1, 0, '#9aa3ab');
				box(0.18, 0.26, 0.02, 0, 1.25, 0.16, '#3c454d');
				box(0.05, 0.05, 0.01, -0.2, 1.55, 0.155, '#000000', {emissive: '#59db8f', emissiveIntensity: 0.9});
				box(0.05, 0.05, 0.01, 0.2, 1.55, 0.155, '#000000', {emissive: '#f2b84b', emissiveIntensity: 0.6});
				status(0.7, 0, 1.75, 0.13);
				height = 1.8;
				break;

			case 'generator': {
				// Grupo electrógeno en cabina insonorizada: celosías a los lados, escape arriba y tablero de control.
				box(3.2, 1.9, 1.2, 0, 0.95, 0, '#5d6a75');
				box(3.3, 0.12, 1.3, 0, 0.06, 0, '#2b3137');

				for (let n = 0; n < 5; n++) {
					box(0.36, 1.1, 0.01, -1.2 + n * 0.6, 1.0, 0.605, '#46525c');
				}

				box(0.5, 0.4, 0.01, 1.25, 1.35, 0.605, '#1f2c33');
				box(0.16, 0.5, 0.16, -1.1, 2.15, 0, '#2b3137');
				status(3.2, 0, 1.97, 0.55);
				height = 2.4;
				break;
			}

			case 'transformer': {
				// Transformador seco o celda de acometida: gabinete con aletas de disipación al frente.
				box(1.6, 1.8, 1.2, 0, 0.9, 0, '#7d8790');

				for (let n = 0; n < 7; n++) {
					box(0.04, 1.3, 0.08, -0.6 + n * 0.2, 0.85, 0.63, '#5d6a75');
				}

				box(0.5, 0.3, 0.01, 0, 1.55, 0.605, '#ffc859');
				status(1.6, 0, 1.87, 0.55);
				height = 1.9;
				break;
			}

			case 'panel':
				box(0.8, 1.4, 0.25, 0, 1.2, 0, '#8a949c');
				box(0.7, 0.02, 0.01, 0, 1.6, 0.13, '#5d6a75');
				status(0.8, 0, 1.92, 0.11);
				height = 1.95;
				break;

			case 'sensor': {
				box(0.07, 0.07, 0.035, 0, 0, 0, '#eef1f4');
				dot = new THREE.Mesh(new THREE.SphereGeometry(0.014, 12, 8), statusMat);
				dot.position.set(0, 0, 0.02);
				group.add(dot);

				if (o.mount === 'floor') {
					// Sensor suelto: sobre un soporte a 1,5 m.
					group.children.forEach((child) => child.position.y += 1.5);
					box(0.02, 1.47, 0.02, 0, 0.735, 0, '#9aa3ab');
				}

				height = o.mount === 'floor' ? 1.6 : 0.1;
				break;
			}

			case 'door': {
				// Puerta empotrada en la pared: marco del espesor de la pared, umbral y una o dos hojas.
				// La hoja gira sobre su bisagra; abre hacia la sala (cara frente) o hacia afuera (cara atrás).
				const frame = '#7d8790';
				const DW = LakaInfra3DScene.doorWidth(o);
				const T = LakaInfra3DScene.WALL_T;

				box(0.07, 2.2, T + 0.04, -DW / 2 - 0.035, 1.1, 0, frame);
				box(0.07, 2.2, T + 0.04, DW / 2 + 0.035, 1.1, 0, frame);
				box(DW + 0.14, 0.08, T + 0.04, 0, 2.24, 0, frame);
				box(DW, 0.015, T + 0.04, 0, 0.0075, 0, '#5b646c');

				const leafMat = new THREE.MeshStandardMaterial({color: '#4a5560', roughness: 0.5, metalness: 0.4});
				const handleMat = new THREE.MeshStandardMaterial({color: '#c9d1d8', roughness: 0.3, metalness: 0.8});
				const hinges = o.leaves === 2 ? ['l', 'r'] : [o.hinge || 'l'];
				const lw = o.leaves === 2 ? DW / 2 : DW;

				leaf = [];

				for (const side of hinges) {
					const dir = side === 'l' ? 1 : -1;
					const g = new THREE.Group();
					const panel = new THREE.Mesh(new THREE.BoxGeometry(lw - 0.01, 2.17, 0.045), leafMat);
					const window = new THREE.Mesh(new THREE.BoxGeometry(lw * 0.35, 0.5, 0.05),
						new THREE.MeshStandardMaterial({color: '#9fb4c4', roughness: 0.1, metalness: 0.2, transparent: true,
							opacity: 0.55})
					);
					const handle = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.025, 0.1), handleMat);

					g.position.set(-dir * DW / 2, 0, 0);
					panel.position.set(dir * lw / 2, 1.09, 0);
					window.position.set(dir * lw / 2, 1.6, 0);
					handle.position.set(dir * (lw - 0.1), 1.05, 0);
					g.add(panel, window, handle);
					g.userData.dir = dir;
					pick.push(panel);
					group.add(g);
					leaf.push(g);
				}

				dot = new THREE.Mesh(new THREE.SphereGeometry(0.03, 12, 8), statusMat);
				dot.position.set(DW / 2 + 0.035, 2.34, T / 2 + 0.03);
				group.add(dot);
				height = 2.45;
				break;
			}

			case 'access': {
				// Lector de control de acceso junto a la puerta: pantalla y, si es biométrico, lector de huella.
				box(0.1, 0.17, 0.035, 0, 0, 0, '#2b3137');
				box(0.07, 0.05, 0.005, 0, 0.045, 0.019, '#000000', {emissive: '#4796c4', emissiveIntensity: 0.9});

				if ([2, 3].includes(o.batt)) {
					box(0.035, 0.045, 0.006, 0, -0.035, 0.019, '#59636d');
				}
				else if (o.batt === 4) {
					for (let k = 0; k < 9; k++) {
						box(0.016, 0.012, 0.004, -0.022 + (k % 3) * 0.022, -0.02 - Math.floor(k / 3) * 0.018, 0.019, '#c4ccd2');
					}
				}
				else if (o.batt === 5) {
					box(0.02, 0.02, 0.006, 0, 0.075, 0.019, '#0b0d10');
				}

				dot = new THREE.Mesh(new THREE.SphereGeometry(0.008, 10, 8), statusMat);
				dot.position.set(0.035, -0.07, 0.019);
				group.add(dot);
				height = 0.2;
				break;
			}

			case 'camera': {
				// Cámara: domo, bala o PTZ en un soporte; el cono muestra hacia dónde mira.
				const white = '#eef1f4';

				box(0.06, 0.06, 0.02, 0, 0, 0, '#c4ccd2');

				if (o.batt === 2) {
					box(0.03, 0.03, 0.1, 0, 0, 0.05, '#c4ccd2');
					box(0.08, 0.075, 0.2, 0, -0.01, 0.17, white);
					box(0.05, 0.05, 0.005, 0, -0.01, 0.272, '#0b0d10');
				}
				else {
					box(0.03, 0.03, 0.12, 0, 0, 0.06, '#c4ccd2');

					const dome = new THREE.Mesh(new THREE.SphereGeometry(0.07, 18, 12, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2),
						new THREE.MeshStandardMaterial({color: o.batt === 3 ? '#2b3137' : '#1b1f23', roughness: 0.2, metalness: 0.3,
							transparent: true, opacity: 0.85})
					);

					dome.position.set(0, -0.02, 0.14);
					group.add(dome);
					pick.push(dome);
					box(0.15, 0.03, 0.15, 0, -0.005, 0.14, white);
				}

				// La cobertura ya no es un cono 3D: se dibuja en el piso (buildCoverage) y solo se muestra a pedido.
				dot = new THREE.Mesh(new THREE.SphereGeometry(0.01, 10, 8), statusMat);
				dot.position.set(0.04, 0.02, 0.012);
				group.add(dot);
				height = 0.15;
				break;
			}

			case 'motion':
				box(0.08, 0.11, 0.05, 0, 0, 0, '#eef1f4');
				box(0.05, 0.04, 0.01, 0, -0.02, 0.028, '#9aa3ab', {transparent: true, opacity: 0.8});
				dot = new THREE.Mesh(new THREE.SphereGeometry(0.008, 10, 8), statusMat);
				dot.position.set(0, 0.035, 0.028);
				group.add(dot);
				height = 0.15;
				break;

			case 'smoke': {
				// Detector en el techo (o la pared): base y cuerpo redondos con LED.
				const mat = new THREE.MeshStandardMaterial({color: '#f4f6f7', roughness: 0.5});
				const base = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.065, 0.015, 24), mat);
				const body = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.058, 0.035, 24), mat);

				const wall = o.mount !== 'ceiling';

				dot = new THREE.Mesh(new THREE.SphereGeometry(0.008, 10, 8), statusMat);

				// En el techo cuelga hacia abajo; en la pared mira hacia la sala.
				if (wall) {
					base.rotation.x = Math.PI / 2;
					body.rotation.x = Math.PI / 2;
					base.position.set(0, 0, 0.008);
					body.position.set(0, 0, 0.03);
					dot.position.set(0.035, 0, 0.045);
				}
				else {
					base.position.set(0, -0.008, 0);
					body.position.set(0, -0.03, 0);
					dot.position.set(0.035, -0.045, 0);
				}

				group.add(base, body, dot);
				pick.push(base, body);
				height = 0.1;
				break;
			}

			case 'vesda': {
				// Detector por aspiración: equipo en la pared y la tubería de muestreo que sube al techo.
				box(0.35, 0.27, 0.12, 0, 0, 0, '#d4d8dc');
				box(0.2, 0.06, 0.005, 0, 0.05, 0.062, '#000000', {emissive: '#59db8f', emissiveIntensity: 0.7});

				for (let k = 0; k < 4; k++) {
					box(0.03, 0.012, 0.005, -0.06 + k * 0.04, -0.05, 0.062, ['#59db8f', '#ffc859', '#ffa059', '#e45959'][k]);
				}

				const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.013, 0.013, Math.max(0.3, 3.0 - (o.height || 1.5)), 10),
					new THREE.MeshStandardMaterial({color: '#e45959', roughness: 0.6})
				);

				pipe.position.set(0.1, 0.135 + Math.max(0.3, 3.0 - (o.height || 1.5)) / 2, 0);
				group.add(pipe);
				status(0.35, 0, -0.15, 0.04);
				height = 0.3;
				break;
			}

			case 'firepanel':
				box(0.45, 0.55, 0.12, 0, 0, 0, '#c0392b');
				box(0.26, 0.1, 0.005, 0, 0.14, 0.062, '#000000', {emissive: '#ffc859', emissiveIntensity: 0.6});

				for (let k = 0; k < 6; k++) {
					box(0.04, 0.02, 0.005, -0.12 + (k % 3) * 0.12, -0.03 - Math.floor(k / 3) * 0.06, 0.062, '#f4f6f7');
				}

				status(0.45, 0, 0.3, 0.04);
				height = 0.35;
				break;

			case 'suppression': {
				// Cilindros del agente con su válvula y manómetro, sobre el piso.
				const dim = LakaInfra3DScene.objectDims(o, null);
				const n = Math.max(1, Math.min(3, o.size || 1));
				const color = [3].includes(o.batt) ? '#59636d' : (o.batt >= 4 ? '#4796c4' : '#c0392b');

				for (let k = 0; k < n; k++) {
					const cx = -dim.w / 2 + 0.19 + k * 0.38;
					const cyl = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 1.35, 20),
						new THREE.MeshStandardMaterial({color, roughness: 0.4, metalness: 0.3})
					);

					cyl.position.set(cx, 0.675, 0);
					group.add(cyl);
					pick.push(cyl);
					box(0.08, 0.14, 0.08, cx, 1.42, 0, '#9aa3ab');
					box(0.05, 0.05, 0.01, cx, 1.42, 0.045, '#f4f6f7');
				}

				status(dim.w, 0, 1.55, 0.1);
				height = 1.6;
				break;
			}

			case 'extinguisher': {
				const cyl = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.5, 18),
					new THREE.MeshStandardMaterial({color: '#c0392b', roughness: 0.35, metalness: 0.2})
				);

				cyl.position.set(0, -0.25, 0.08);
				group.add(cyl);
				pick.push(cyl);
				box(0.05, 0.08, 0.05, 0, 0.04, 0.08, '#1b1f23');
				box(0.03, 0.18, 0.03, 0.08, -0.12, 0.13, '#1b1f23');

				if (o.batt === 1) {
					// Extintor de CO₂: bocina negra.
					box(0.06, 0.09, 0.06, 0.08, -0.25, 0.13, '#1b1f23');
				}

				box(0.12, 0.04, 0.02, 0, 0.02, 0.01, '#9aa3ab');
				height = 0.15;
				break;
			}

			case 'epo': {
				// Pulsador de apagado de emergencia: caja amarilla, hongo rojo y tapa transparente.
				box(0.16, 0.16, 0.06, 0, 0, 0, '#ffc859');

				const btn = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.03, 18),
					new THREE.MeshStandardMaterial({color: '#e45959', roughness: 0.4})
				);

				btn.rotation.x = Math.PI / 2;
				btn.position.set(0, 0, 0.045);
				group.add(btn);
				pick.push(btn);
				box(0.15, 0.15, 0.005, 0, 0, 0.065, '#ffffff', {transparent: true, opacity: 0.25});
				height = 0.2;
				break;
			}

			case 'light':
				box(0.36, 0.1, 0.06, 0, 0, 0, '#f4f6f7');
				box(0.3, 0.03, 0.005, 0, -0.02, 0.032, '#ffffff', {emissive: '#ffffff', emissiveIntensity: 0.6});
				box(0.08, 0.02, 0.005, 0, 0.03, 0.032, '#000000', {emissive: '#59db8f', emissiveIntensity: 0.9});
				height = 0.15;
				break;

			case 'leak': {
				// Sensor de fugas: cable sensor amarillo sobre el piso (2, 5 o 10 m) y su módulo.
				const dim = LakaInfra3DScene.objectDims(o, null);

				box(dim.w, 0.012, 0.02, 0, 0.006, 0, '#ffc859');
				box(0.12, 0.05, 0.08, -dim.w / 2 - 0.06, 0.025, 0, '#2b3137');
				dot = new THREE.Mesh(new THREE.SphereGeometry(0.01, 10, 8), statusMat);
				dot.position.set(-dim.w / 2 - 0.06, 0.055, 0.03);
				group.add(dot);
				height = 0.1;
				break;
			}

			case 'cdu':
				// CDU: gabinete de piso con su pantalla, cañerías de suministro (azul) y retorno (rojo) arriba.
				box(0.6, 2.0, 1.2, 0, 1.0, 0, '#c9d1d6');
				box(0.5, 1.6, 0.01, 0, 1.0, 0.605, '#b3bcc2');
				box(0.18, 0.12, 0.01, 0, 1.55, 0.612, '#1f2c33', {emissive: '#2f80ed', emissiveIntensity: 0.4});
				box(0.08, 0.35, 0.08, -0.14, 2.17, -0.3, '#2f80ed');
				box(0.08, 0.35, 0.08, 0.14, 2.17, -0.3, '#e45959');
				status(0.6, 0, 2.05, 0.45);
				height = 2.4;
				break;

			case 'rdhx':
				// Intercambiador de puerta trasera: panel con serpentín y ventiladores.
				box(0.6, 2.0, 0.15, 0, 1.0, 0, '#3b5b7a');

				for (let k = 0; k < 5; k++) {
					box(0.36, 0.3, 0.01, 0, 0.35 + k * 0.33, 0.08, '#1f2c33');
				}

				box(0.04, 1.8, 0.04, -0.27, 1.0, -0.06, '#2f80ed');
				box(0.04, 1.8, 0.04, 0.27, 1.0, -0.06, '#e45959');
				status(0.6, 0, 2.05, 0.05);
				height = 2.2;
				break;

			case 'wap':
				// Punto de acceso inalámbrico en el techo: disco blanco con su luz de estado.
				box(0.22, 0.04, 0.22, 0, 0, 0, '#f4f6f7');
				dot = new THREE.Mesh(new THREE.SphereGeometry(0.012, 10, 8), statusMat);
				dot.position.set(0, -0.025, 0);
				group.add(dot);
				height = 0.1;
				break;

			case 'water':
				// Medidor de agua en la cañería: cuerpo azul con su visor.
				box(0.4, 0.05, 0.05, 0, 0, -0.03, '#8a969e');
				box(0.16, 0.16, 0.12, 0, 0, 0, '#2f80ed');
				box(0.1, 0.1, 0.005, 0, 0, 0.062, '#e8f2fb');
				dot = new THREE.Mesh(new THREE.SphereGeometry(0.01, 10, 8), statusMat);
				dot.position.set(0.06, 0.06, 0.065);
				group.add(dot);
				height = 0.2;
				break;

			case 'solar':
				// Inversor de la generación solar o renovable, en la pared, con su pantalla.
				box(0.5, 0.7, 0.2, 0, 1.2, 0, '#e8ecef');
				box(0.3, 0.12, 0.005, 0, 1.38, 0.102, '#1f3d5c', {emissive: '#2f80ed', emissiveIntensity: 0.3});
				box(0.36, 0.06, 0.005, 0, 1.0, 0.102, '#ffc859');
				status(0.5, 0, 1.6, 0.06);
				height = 1.7;
				break;

			case 'ground':
				// Barra de tierra de cobre sobre aisladores (ANSI/TIA-607).
				box(0.6, 0.1, 0.012, 0, 0, 0.045, '#b87333', {metalness: 0.7, roughness: 0.3});
				box(0.04, 0.06, 0.04, -0.25, 0, 0.02, '#2b3137');
				box(0.04, 0.06, 0.04, 0.25, 0, 0.02, '#2b3137');

				for (let k = 0; k < 8; k++) {
					box(0.012, 0.012, 0.003, -0.21 + k * 0.06, 0.02, 0.052, '#5b3a1a');
				}

				box(0.04, 0.4, 0.012, 0.32, -0.2, 0.03, '#2f9e44');
				height = 0.15;
				break;

			default:
				return null;
		}

		// Ubicación: pegado a un rack (sensores) o en coordenadas de la sala.
		const quat = new THREE.Quaternion();

		const wallPos = o.mount === 'wall' ? this.wallPlacement(o, world.bounds) : null;

		if (o.mount === 'row' && world.racks.has(o.rack)) {
			const rack = world.racks.get(o.rack);

			group.position.copy(rack.frame.pos);
			quat.copy(rack.frame.quat);
		}
		else if (wallPos) {
			group.position.copy(wallPos.pos);
			quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -wallPos.rot * Math.PI / 180);
		}
		else if (o.mount === 'ceiling') {
			// En el techo: a la altura indicada (3 m por defecto), colgando hacia abajo.
			group.position.set(o.x, o.height > 0 ? o.height : 3.0, o.z);
			quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -(o.rot || 0) * Math.PI / 180);
		}
		else if (o.kind === 'sensor' && o.rack && world.racks.has(o.rack)) {
			const rack = world.racks.get(o.rack);
			const back = o.face === 'back';
			const y = {top: rack.H - 0.3, mid: rack.H / 2, bottom: 0.35}[o.level] || rack.H - 0.3;
			const local = new THREE.Vector3(rack.width / 2 - 0.06, y, (back ? -1 : 1) * (L.DEP / 2 + 0.02));

			group.position.copy(local.applyMatrix4(rack.frame.matrix));
			quat.copy(rack.frame.quat);

			if (back) {
				quat.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI));
			}
		}
		else {
			// Suelto en la sala: los aparatos chicos (salvo el sensor, que tiene su soporte) a su altura.
			const lift = LakaInfra3DScene.SMALL_KINDS.includes(o.kind) && o.kind !== 'sensor'
				? (o.height > 0 ? o.height : LakaInfra3DScene.DEFAULT_HEIGHT[o.kind]) : 0;

			group.position.set(o.x, lift, o.z);
			quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -(o.rot || 0) * Math.PI / 180);
		}

		group.quaternion.copy(quat);
		group.updateMatrixWorld(true);

		const entry = {o, group, statusMat, leaf, dot, label: null, height, quat, doorOpen: 0, manual: null,
			center: new THREE.Vector3(0, LakaInfra3DScene.SMALL_KINDS.includes(o.kind) && o.mount !== 'floor' ? 0 : Math.min(height, 1.6) * 0.6, 0)
				.applyMatrix4(group.matrixWorld)
		};

		for (const m of pick) {
			m.userData = {kind: 'object', entry};
			world.pickables.push(m);
		}

		entry.label = new THREE.Sprite(new THREE.SpriteMaterial({transparent: true, depthTest: true}));
		entry.label.position.copy(new THREE.Vector3(0, height + 0.22, 0).applyMatrix4(group.matrixWorld));
		world.group.add(entry.label);

		if (o.kind === 'camera') {
			entry.cover = this.buildCoverage(entry, world);
			world.group.add(entry.cover);
		}

		return entry;
	}

	/**
	 * Cobertura de una cámara proyectada en el piso: un sector plano (domo 90°, bala 60°, PTZ 360°)
	 * recortado por las paredes de la sala, con dos líneas finas desde el lente hasta los bordes.
	 * Reemplaza al cono 3D, que tapaba los racks. Queda oculta salvo que se elija la cámara
	 * o se active "Cobertura de cámaras" en la barra.
	 */
	buildCoverage(entry, world) {
		const THREE = this.THREE;
		const o = entry.o;
		const b = world.bounds;
		const cover = new THREE.Group();
		const eye = entry.group.position.clone();
		const ceiling = o.mount === 'ceiling';
		const variant = o.batt || 1;
		// Domo en techo mira hacia abajo: círculo. PTZ: barrido completo.
		const full = variant === 3 || (ceiling && variant !== 2);
		const fov = full ? Math.PI * 2 : (variant === 2 ? 60 : 90) * Math.PI / 180;
		const range = full ? Math.min(4.5, Math.max(2.5, eye.y * 1.3)) : (variant === 2 ? 9 : 6);
		const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(entry.quat);

		fwd.y = 0;

		if (fwd.lengthSq() < 1e-6) {
			fwd.set(0, 0, 1);
		}

		fwd.normalize();

		const base = Math.atan2(fwd.x, fwd.z);
		const floorY = 0.012;
		const foot = new THREE.Vector3(eye.x, floorY, eye.z);
		// Distancia hasta la pared en una dirección (la sala es un rectángulo).
		const reach = (dx, dz) => {
			let t = range;

			if (b && isFinite(b.minX)) {
				if (dx > 1e-6) t = Math.min(t, (b.maxX - foot.x) / dx);
				if (dx < -1e-6) t = Math.min(t, (b.minX - foot.x) / dx);
				if (dz > 1e-6) t = Math.min(t, (b.maxZ - foot.z) / dz);
				if (dz < -1e-6) t = Math.min(t, (b.minZ - foot.z) / dz);
			}

			return Math.max(0, t);
		};
		const steps = full ? 48 : 24;
		const rim = [];

		for (let k = 0; k <= steps; k++) {
			const a = full ? (k / steps) * Math.PI * 2 : base - fov / 2 + (k / steps) * fov;
			const dx = Math.sin(a);
			const dz = Math.cos(a);
			const r = reach(dx, dz);

			rim.push(new THREE.Vector3(foot.x + dx * r, floorY, foot.z + dz * r));
		}

		// Relleno: abanico de triángulos desde el pie de la cámara.
		const pos = [];

		for (let k = 0; k < rim.length - 1; k++) {
			pos.push(foot.x, floorY, foot.z, rim[k].x, floorY, rim[k].z, rim[k + 1].x, floorY, rim[k + 1].z);
		}

		const geo = new THREE.BufferGeometry();

		geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));

		const color = '#4796c4';
		const fill = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({color, transparent: true, opacity: 0.16,
			depthWrite: false, side: THREE.DoubleSide
		}));

		fill.renderOrder = 2;
		cover.add(fill);

		// Borde del área vista.
		const edge = full ? rim : [foot, ...rim, foot];
		const lineMat = new THREE.LineBasicMaterial({color, transparent: true, opacity: 0.7, depthWrite: false});

		const segs = [];

		for (let k = 0; k < edge.length - 1; k++) {
			segs.push(edge[k], edge[k + 1]);
		}

		cover.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(segs), lineMat));

		// Líneas de visión desde el lente: dos bordes del sector, o una vertical si mira hacia abajo.
		const sight = new THREE.LineBasicMaterial({color, transparent: true, opacity: 0.45, depthWrite: false});
		const pairs = full ? [eye, foot] : [eye, rim[0], eye, rim[rim.length - 1], eye, rim[Math.floor(rim.length / 2)]];

		cover.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pairs), sight));
		cover.visible = false;

		// Vista sugerida al elegir la cámara: el centro del área que cubre.
		let cx = 0;
		let cz = 0;

		for (const p of rim) {
			cx += p.x;
			cz += p.z;
		}

		const center = full ? foot.clone() : new THREE.Vector3((cx / rim.length + foot.x) / 2, 0, (cz / rim.length + foot.z) / 2);

		// Vista alta y algo oblicua: se ve el sector completo sin que la pared tape.
		const lookR = full ? range : Math.max(...rim.map((p) => p.distanceTo(foot)));
		const side = new THREE.Vector3(fwd.z, 0, -fwd.x);

		entry.coverView = {
			target: center,
			pos: center.clone()
				.addScaledVector(fwd, full ? 0 : -lookR * 0.25)
				.addScaledVector(side, lookR * 0.5)
				.add(new THREE.Vector3(0, Math.max(5, lookR * 1.6), full ? lookR * 0.6 : 0))
		};

		return cover;
	}

	/** Muestra la cobertura de todas las cámaras (botón) o solo la de la cámara elegida. */
	updateCoverage() {
		if (!this.world || !this.world.objects) {
			return;
		}

		const sel = this.panelState && this.panelState.kind === 'object' ? this.panelState.id : null;

		for (const entry of this.world.objects) {
			if (entry.cover) {
				entry.cover.visible = this.coverOn || entry.o.id === sel;
			}
		}
	}

	toggleCoverage() {
		this.coverOn = !this.coverOn;
		this.root.querySelector('[data-act="cover"]').setAttribute('aria-pressed', String(this.coverOn));
		this.updateCoverage();
		this.savePrefs();
	}

	/** Ubicación de un rack para mostrar: "Fila A · posición 2" o "Rack de pared · Pared izquierda". */
	static rackWhere(def, t) {
		if (def.mount === 'wall') {
			const walls = {n: 'Pared de arriba', s: 'Pared de abajo', w: 'Pared izquierda', e: 'Pared derecha'};

			return `${t('Rack de pared')} · ${t(walls[def.wall] || walls.n)}`;
		}

		return `${t('Fila')} ${def.row_label} · ${t('posición')} ${def.index + 1}`;
	}

	// ---------------------------------------------------------------- preferencias de vista

	loadPrefs() {
		if (!this.prefsKey) {
			return {};
		}

		try {
			const raw = window.localStorage.getItem(this.prefsKey);
			const prefs = raw ? JSON.parse(raw) : {};

			return prefs && typeof prefs === 'object' ? prefs : {};
		}
		catch (error) {
			return {};
		}
	}

	savePrefs() {
		if (!this.prefsKey) {
			return;
		}

		try {
			if (!this.coverOn && !this.gridOn && !this.wallsOpen) {
				window.localStorage.removeItem(this.prefsKey);
			}
			else {
				window.localStorage.setItem(this.prefsKey, JSON.stringify({cover: this.coverOn, grid: this.gridOn, open: this.wallsOpen}));
			}
		}
		catch (error) {
			// Sin almacenamiento local: la preferencia vale hasta recargar la página.
		}
	}

	// ---------------------------------------------------------------- coordenadas de la grilla

	/**
	 * Coordenada de baldosa (piso técnico de 600 mm, ANSI/TIA-942): letras por columna (eje X, desde la
	 * pared izquierda) y número de dos dígitos por fila (eje Z, desde la pared de arriba). Ej.: AJ05.
	 */
	static colName(i) {
		let n = i + 1;
		let out = '';

		while (n > 0) {
			const r = (n - 1) % 26;

			out = String.fromCharCode(65 + r) + out;
			n = Math.floor((n - 1) / 26);
		}

		return out;
	}

	gridRef(x, z) {
		const b = this.world && this.world.bounds;

		if (!b || !isFinite(b.minX)) {
			return '';
		}

		const T = LakaInfra3DScene.TILE;
		const cols = Math.max(1, Math.ceil(b.w / T - 1e-6));
		const rows = Math.max(1, Math.ceil(b.d / T - 1e-6));
		const c = Math.min(cols - 1, Math.max(0, Math.floor((x - b.minX) / T)));
		const r = Math.min(rows - 1, Math.max(0, Math.floor((z - b.minZ) / T)));

		return LakaInfra3DScene.colName(c) + String(r + 1).padStart(2, '0');
	}

	/**
	 * Sala abierta: oculta paredes, puertas y lo montado en la pared para recorrer rack por rack. Con la sala
	 * abierta, la rueda del mouse acerca hacia donde apunta el cursor (zoomToCursor), así uno se desplaza
	 * libremente entre las filas. La preferencia se guarda por widget.
	 */
	toggleWalls() {
		this.wallsOpen = !this.wallsOpen;
		this.root.querySelector('[data-act="walls"]').setAttribute('aria-pressed', String(this.wallsOpen));
		this.applyWalls();
		this.savePrefs();
	}

	applyWalls() {
		// En el modo NOC manda el recorrido (paredes solo en la vista general).
		if (this.noc && this.noc.active) {
			return;
		}

		this.setWalls(!this.wallsOpen);
		this.controls.zoomToCursor = this.wallsOpen;
	}

	toggleGrid() {
		this.gridOn = !this.gridOn;
		this.root.querySelector('[data-act="grid"]').setAttribute('aria-pressed', String(this.gridOn));

		if (this.gridOn && this.world && !this.world.grid) {
			this.buildGrid();
		}

		if (this.world && this.world.grid) {
			this.world.grid.visible = this.gridOn;
		}

		this.savePrefs();
	}

	/**
	 * Capa de coordenadas sobre el piso: el código de cada baldosa en su centro y, por fuera de las
	 * paredes, las letras de columna (arriba y abajo) y los números de fila (izquierda y derecha).
	 */
	buildGrid() {
		const THREE = this.THREE;
		const world = this.world;
		const b = world.bounds;

		if (!b || !isFinite(b.minX) || b.w <= 0 || b.d <= 0) {
			return;
		}

		const T = LakaInfra3DScene.TILE;
		const cols = Math.max(1, Math.ceil(b.w / T - 1e-6));
		const rows = Math.max(1, Math.ceil(b.d / T - 1e-6));
		const dark = this.isDark();
		const grid = new THREE.Group();
		// Resolución por baldosa: alcanza para leer de cerca sin pasar de 4096 px por lado.
		const px = Math.max(24, Math.min(96, Math.floor(4096 / Math.max(cols, rows))));
		const c = document.createElement('canvas');

		c.width = cols * px;
		c.height = rows * px;

		const g = c.getContext('2d');

		g.clearRect(0, 0, c.width, c.height);
		g.textAlign = 'center';
		g.textBaseline = 'middle';
		g.font = `700 ${Math.round(px * 0.26)}px Arial, sans-serif`;

		for (let ci = 0; ci < cols; ci++) {
			for (let ri = 0; ri < rows; ri++) {
				g.fillStyle = dark ? 'rgba(232, 237, 242, 0.62)' : 'rgba(31, 44, 51, 0.62)';
				g.fillText(LakaInfra3DScene.colName(ci) + String(ri + 1).padStart(2, '0'), (ci + 0.5) * px, (ri + 0.5) * px);
			}
		}

		// Cada 5 baldosas, línea más marcada para contar rápido.
		g.strokeStyle = 'rgba(71, 150, 196, 0.85)';
		g.lineWidth = Math.max(2, px / 24);

		for (let ci = 0; ci <= cols; ci += 5) {
			g.beginPath();
			g.moveTo(ci * px, 0);
			g.lineTo(ci * px, c.height);
			g.stroke();
		}

		for (let ri = 0; ri <= rows; ri += 5) {
			g.beginPath();
			g.moveTo(0, ri * px);
			g.lineTo(c.width, ri * px);
			g.stroke();
		}

		const tex = new THREE.CanvasTexture(c);

		tex.colorSpace = THREE.SRGBColorSpace;
		tex.anisotropy = 4;
		world.textures.push(tex);

		const gw = cols * T;
		const gd = rows * T;
		const plane = new THREE.Mesh(new THREE.PlaneGeometry(gw, gd),
			new THREE.MeshBasicMaterial({map: tex, transparent: true, depthWrite: false})
		);

		plane.rotation.x = -Math.PI / 2;
		plane.position.set(b.minX + gw / 2, 0.006, b.minZ + gd / 2);
		plane.renderOrder = 1;
		grid.add(plane);

		// Rótulos de los ejes, por fuera de las paredes.
		const axis = (text, x, z) => {
			const tex2 = this.canvasTex(`grid:${text}:${dark}`, 128, 64, (g2, w, h) => {
				g2.fillStyle = 'rgba(71, 150, 196, 0.92)';
				g2.beginPath();

				if (g2.roundRect) {
					g2.roundRect(6, 8, w - 12, h - 16, 12);
				}
				else {
					g2.rect(6, 8, w - 12, h - 16);
				}

				g2.fill();
				g2.fillStyle = '#ffffff';
				g2.font = '700 34px Arial, sans-serif';
				g2.textAlign = 'center';
				g2.textBaseline = 'middle';
				g2.fillText(text, w / 2, h / 2 + 1);
			});
			const sp = new THREE.Sprite(new THREE.SpriteMaterial({map: tex2, transparent: true, depthWrite: false}));

			sp.position.set(x, 0.12, z);
			sp.scale.set(0.42, 0.21, 1);
			grid.add(sp);
		};

		for (let ci = 0; ci < cols; ci++) {
			const x = b.minX + (ci + 0.5) * T;
			const name = LakaInfra3DScene.colName(ci);

			axis(name, x, b.minZ - 0.3);
			axis(name, x, b.minZ + gd + 0.3);
		}

		for (let ri = 0; ri < rows; ri++) {
			const z = b.minZ + (ri + 0.5) * T;
			const name = String(ri + 1).padStart(2, '0');

			axis(name, b.minX - 0.35, z);
			axis(name, b.minX + gw + 0.35, z);
		}

		grid.visible = this.gridOn;
		world.group.add(grid);
		world.grid = grid;
	}

	/**
	 * Posición de un elemento pegado a una pared: la pared (n, s, e, o) y la distancia desde su esquina.
	 * Queda con la espalda contra la pared y el frente hacia la sala. La puerta queda centrada en la pared.
	 */
	wallPlacement(o, b) {
		const depth = LakaInfra3DScene.objectDims(o, null).d;
		const inset = depth / 2 + (o.kind === 'door' ? 0 : 0.02);
		const len = o.wall === 'n' || o.wall === 's' ? b.maxX - b.minX : b.maxZ - b.minZ;
		// La puerta no puede salirse de la pared: su vano queda entero dentro del tramo.
		const half = o.kind === 'door' ? LakaInfra3DScene.doorWidth(o) / 2 + 0.07 : 0;
		const off = Math.min(Math.max(o.offset, half), len - half);
		let x;
		let z;
		let rot;

		switch (o.wall) {
			case 's':
				x = b.minX + off;
				z = b.maxZ - inset;
				rot = 180;
				break;

			case 'w':
				x = b.minX + inset;
				z = b.minZ + off;
				rot = 270;
				break;

			case 'e':
				x = b.maxX - inset;
				z = b.minZ + off;
				rot = 90;
				break;

			default:
				x = b.minX + off;
				z = b.minZ + inset;
				rot = 0;
		}

		// Sensores y splits: a la altura indicada (por defecto 1,5 m y 2,35 m).
		let y = 0;

		if (LakaInfra3DScene.SMALL_KINDS.includes(o.kind)) {
			y = o.height > 0 ? o.height : LakaInfra3DScene.DEFAULT_HEIGHT[o.kind];
		}
		else if (o.kind === 'split' && o.height > 0) {
			y = o.height - 2.35;
		}

		return {pos: new this.THREE.Vector3(x, y, z), rot};
	}

	/**
	 * Plan de filas y pasillos, compartido por la vista 3D y el editor.
	 * - layout 0 (filas enfrentadas): de a pares; con pasillo central "cold" los frentes se miran (pasillo frío
	 *   entre el par) y con "hot" se miran las espaldas (pasillo caliente entre el par, fríos afuera).
	 * - layout 1 y 2 (paralelas o una sola fila): todas miran igual; "hot" las invierte.
	 * - flips: filas invertidas a mano (por etiqueta), para salas que no siguen un patrón.
	 * Entre dos filas el pasillo es frío (frentes enfrentados, 1,8 m), caliente (espaldas, 1,2 m) o mixto (1,4 m).
	 * A los extremos: pasillo frío si la fila mira hacia afuera, caliente si da la espalda.
	 * facing = +1: el frente mira hacia +Z.
	 */
	static rowPlan(labels, layout, aisle, flips) {
		const L = LakaInfra3DScene;
		const hot = aisle === 'hot';
		// En una sola fila no hay filas que invertir: el sentido lo da el pasillo central.
		const flipped = new Set(layout === 2 ? [] : (flips || []));
		const rows = labels.map((label, k) => {
			let facing = layout === 0 ? (k % 2 === 0 ? 1 : -1) : 1;

			if (hot) {
				facing = -facing;
			}

			if (flipped.has(label)) {
				facing = -facing;
			}

			return {label, facing, z: 0};
		});
		const gap = (fa, fb) => (fa === 1 && fb === -1 ? L.AISLE : (fa === -1 && fb === 1 ? L.HOT : 1.4));
		const aisles = [];

		rows.forEach((row, k) => {
			if (k > 0) {
				const prev = rows[k - 1];

				row.z = prev.z + L.DEP + gap(prev.facing, row.facing);

				const z0 = prev.z + L.DEP / 2;
				const z1 = row.z - L.DEP / 2;
				const sides = [];

				if (prev.facing === 1) {
					sides.push({z: z0, dir: -1});
				}

				if (row.facing === -1) {
					sides.push({z: z1, dir: 1});
				}

				aisles.push({a: k - 1, b: k, z0, z1, sides,
					type: sides.length === 2 ? 'cold' : (sides.length === 0 ? 'hot' : 'mixed')
				});
			}
		});

		if (rows.length) {
			const first = rows[0];
			const last = rows[rows.length - 1];
			const end = (row, k, outward) => {
				// outward = -1 hacia -Z (antes de la primera fila), +1 hacia +Z (después de la última).
				const face = row.z + outward * L.DEP / 2;
				const front = row.facing === outward;
				const width = front ? L.AISLE : L.HOT;
				const z0 = outward === 1 ? face : face - width;
				const z1 = outward === 1 ? face + width : face;

				return {a: k, b: null, z0, z1, sides: front ? [{z: face, dir: -outward}] : [], type: front ? 'cold' : 'hot'};
			};

			aisles.unshift(end(first, 0, -1));
			aisles.push(end(last, rows.length - 1, 1));
		}

		return {rows, aisles};
	}

	/** Contención de pasillo: techo translúcido y puertas corredizas en los dos extremos. */
	buildContainment(a, group) {
		const THREE = this.THREE;
		const color = a.type === 'cold' ? '#7fb8e0' : '#e0907f';
		const glass = new THREE.MeshBasicMaterial({color, transparent: true, opacity: 0.22, side: THREE.DoubleSide,
			depthWrite: false
		});
		const frame = new THREE.MeshBasicMaterial({color: '#7d8790'});
		const w = a.x1 - a.x0;
		const d = a.z1 - a.z0;
		const h = a.h;
		const roof = new THREE.Mesh(new THREE.PlaneGeometry(w, d), glass);

		roof.rotation.x = -Math.PI / 2;
		roof.position.set((a.x0 + a.x1) / 2, h, (a.z0 + a.z1) / 2);
		group.add(roof);

		for (const x of [a.x0, a.x1]) {
			const door = new THREE.Mesh(new THREE.PlaneGeometry(d, h), glass);

			door.rotation.y = Math.PI / 2;
			door.position.set(x, h / 2, (a.z0 + a.z1) / 2);
			group.add(door);

			for (const [bw, bh, bd, by, bz] of [[0.04, h, 0.04, h / 2, a.z0], [0.04, h, 0.04, h / 2, a.z1],
				[0.04, 0.04, d, h, (a.z0 + a.z1) / 2], [0.03, h, 0.03, h / 2, (a.z0 + a.z1) / 2]]) {
				const bar = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, bd), frame);

				bar.position.set(x, by, bz);
				group.add(bar);
			}
		}

		for (const z of [a.z0, a.z1]) {
			const bar = new THREE.Mesh(new THREE.BoxGeometry(w, 0.04, 0.04), frame);

			bar.position.set((a.x0 + a.x1) / 2, h, z);
			group.add(bar);
		}
	}

	/**
	 * Medidas (ancho, alto, fondo) de un elemento de la sala según su tipo y tamaño, o según el lugar de la
	 * fila que ocupa. Las comparten la vista 3D y el editor para que todo calce.
	 */
	static objectDims(o, slot) {
		const size = o.size || 1;

		switch (o.kind) {
			case 'crac':
				return slot ? {w: slot.width, h: 1.95, d: 1.0} : {w: [1.0, 1.8, 2.5][size - 1], h: 1.95, d: 0.9};

			case 'inrow':
				return slot ? {w: slot.width, h: slot.H, d: 1.0} : {w: 0.3, h: 2.0, d: 1.0};

			case 'ups': {
				if (slot) {
					return {w: slot.width, h: slot.H, d: 1.0, unit: slot.width, batt: 0};
				}

				const unit = [0.45, 0.8, 1.6][size - 1];
				const batt = o.batt || 0;

				return {w: unit + 0.8 * batt, h: [1.0, 1.9, 2.0][size - 1], d: [0.8, 0.9, 0.9][size - 1], unit, batt};
			}

			case 'battery':
				return slot ? {w: slot.width, h: slot.H, d: 1.0} : {w: 0.6 * size, h: 1.9, d: 0.9};

			case 'split':
				return {w: 0.9, h: 0.28, d: 0.22};

			case 'panel':
				return {w: 0.8, h: 1.4, d: 0.25};

			case 'ats':
				return {w: 0.7, h: 1.2, d: 0.3};

			case 'generator':
				return {w: 3.2, h: 1.9, d: 1.2};

			case 'transformer':
				return {w: 1.6, h: 1.8, d: 1.2};

			case 'sensor':
				return {w: 0.07, h: 0.07, d: 0.035};

			case 'door':
				return {w: LakaInfra3DScene.doorWidth(o), h: 2.2, d: 0};

			case 'access':
				return {w: 0.1, h: 0.17, d: 0.04};

			case 'camera':
				return {w: 0.14, h: 0.14, d: 0.25};

			case 'motion':
				return {w: 0.08, h: 0.11, d: 0.06};

			case 'smoke':
				return {w: 0.13, h: 0.05, d: 0.13};

			case 'vesda':
				return {w: 0.35, h: 0.27, d: 0.12};

			case 'firepanel':
				return {w: 0.45, h: 0.55, d: 0.12};

			case 'suppression':
				return {w: 0.38 * size, h: 1.6, d: 0.38};

			case 'extinguisher':
				return {w: 0.18, h: 0.6, d: 0.18};

			case 'epo':
				return {w: 0.16, h: 0.16, d: 0.08};

			case 'light':
				return {w: 0.36, h: 0.1, d: 0.07};

			case 'leak':
				return {w: [2, 5, 10][size - 1], h: 0.02, d: 0.05};

			case 'ground':
				return {w: 0.6, h: 0.1, d: 0.06};

			case 'cdu':
				return {w: 0.6, h: 2.0, d: 1.2};

			case 'rdhx':
				return {w: 0.6, h: 2.0, d: 0.15};

			case 'wap':
				return {w: 0.22, h: 0.04, d: 0.22};

			case 'water':
				return {w: 0.16, h: 0.16, d: 0.12};

			case 'solar':
				return {w: 0.5, h: 0.7, d: 0.2};

			default:
				return {w: 0.5, h: 1.0, d: 0.5};
		}
	}

	/** Color de un porcentaje de uso (CPU o RAM): normal, advertencia (≥ 80 %) o alta (≥ 90 %), colores de Zabbix. */
	static usageColor(value) {
		return value >= 90 ? '#e97659' : (value >= 80 ? '#ffc859' : '');
	}

	/** Ancho libre de una puerta: simple 1,0 m o doble 1,8 m. */
	static doorWidth(o) {
		return o.leaves === 2 ? 1.8 : 1.0;
	}

	/** Vanos de las puertas empotradas en una pared: tramos [desde, hasta] medidos desde su esquina. */
	wallOpenings(objects, wall, len) {
		return objects
			.filter((o) => o.kind === 'door' && o.mount === 'wall' && (o.wall || 'n') === wall)
			.map((o) => {
				const half = LakaInfra3DScene.doorWidth(o) / 2 + 0.07;
				const off = Math.min(Math.max(o.offset || 0, half), len - half);

				return [Math.max(0, off - half), Math.min(len, off + half)];
			})
			.sort((a, b) => a[0] - b[0])
			.reduce((acc, h) => {
				const last = acc[acc.length - 1];

				if (last && h[0] <= last[1]) {
					last[1] = Math.max(last[1], h[1]);
				}
				else {
					acc.push(h.slice());
				}

				return acc;
			}, []);
	}

	/** Abre o cierra las puertas de a poco (estado de Zabbix o el elegido a mano). */
	animateDoors() {
		if (!this.world) {
			return;
		}

		for (const entry of this.world.objects) {
			if (!entry.leaf) {
				continue;
			}

			const o = entry.o;
			const target = entry.manual !== null ? entry.manual : (Number(o.value) > 0 ? 1 : 0);

			if (Math.abs(target - entry.doorOpen) < 0.001) {
				continue;
			}

			entry.doorOpen += (target - entry.doorOpen) * 0.12;

			if (Math.abs(target - entry.doorOpen) < 0.002) {
				entry.doorOpen = target;
			}

			const sign = o.face === 'back' ? -1 : 1;

			for (const g of entry.leaf) {
				g.rotation.y = -g.userData.dir * sign * entry.doorOpen * 1.45;
			}
		}
	}

	/** Abre o cierra una puerta a mano (solo en la vista; no cambia nada en Zabbix). */
	toggleDoor(entry, open) {
		const now = entry.manual !== null ? entry.manual : (Number(entry.o.value) > 0 ? 1 : 0);

		entry.manual = open === undefined ? (now > 0.5 ? 0 : 1) : (open ? 1 : 0);
	}

	/**
	 * Entrar a la sala por una puerta: la cámara llega de afuera, la puerta se abre, se cruza el vano
	 * y la puerta vuelve a su estado. Se cancela si el usuario mueve la vista.
	 */
	enterRoom(entry) {
		const THREE = this.THREE;
		const o = entry.o;
		const g = entry.group;
		const front = new THREE.Vector3(0, 0, 1).applyQuaternion(g.quaternion);
		const eye = 1.65;
		const base = new THREE.Vector3(g.position.x, eye, g.position.z);
		const outside = base.clone().addScaledVector(front, -3.2);
		const inside = base.clone().addScaledVector(front, 2.6);
		const look = base.clone().addScaledVector(front, 8);
		const token = {};

		this.closePanel();
		this.stopTour();
		this.entering = token;
		this.flyTo(outside, base.clone().addScaledVector(front, 2), 1400);

		const later = (ms, fn) => setTimeout(() => {
			if (this.entering === token && this.world && this.world.objectsById.get(o.id) === entry) {
				fn();
			}
		}, ms);

		later(1500, () => this.toggleDoor(entry, true));
		later(2500, () => this.flyTo(inside, look, 2400));
		later(5200, () => {
			entry.manual = null;
			this.entering = null;
			this.toast(this.t('Dentro de la sala'));
		});
	}

	/** Texto del valor principal de un objeto, con su unidad. */
	objectValue(o) {
		if (o.value === null || o.value === undefined) {
			return '';
		}

		if (o.kind === 'door') {
			return o.value > 0 ? this.t('Abierta') : this.t('Cerrada');
		}

		// Disponibilidad por ICMP (plantilla ICMP Ping: icmpping 1 = responde).
		if (['camera', 'access', 'motion'].includes(o.kind) && (o.pattern || '') === 'icmpping') {
			return Number(o.value) === 1 ? this.t('En línea') : this.t('Sin respuesta');
		}

		const units = o.units ? (o.units === '%' || o.units === '°C' ? o.units : ' ' + o.units) : '';

		return `${o.value}${units}`;
	}

	objectColor(o) {
		// Simulación de falla eléctrica: sin energía o sin red.
		const sim = this.mode === 'power' && this.power ? this.power.objectColor(o) : null;

		if (sim) {
			return sim;
		}

		if (o.sev >= 0) {
			return this.data.severities[o.sev].color;
		}

		if (o.kind === 'door' && o.value > 0) {
			return this.data.severities[2].color;
		}

		if (this.mode === 'heat' && o.value !== null && o.value !== undefined && o.units === '°C') {
			return this.tempColor(o.value).getStyle();
		}

		if (!o.linked) {
			return LakaInfra3DScene.OFF_COLOR;
		}

		return o.maint ? LakaInfra3DScene.MAINT_COLOR : LakaInfra3DScene.OK_COLOR;
	}

	/** Colores, puerta abierta/cerrada y etiquetas de la infraestructura. */
	updateObjects() {
		if (!this.world) {
			return;
		}

		const pal = this.palette();

		for (const entry of this.world.objects) {
			const o = entry.o;

			entry.statusMat.color.set(this.objectColor(o));

			// Si el sensor de la puerta cambia de estado, manda Zabbix sobre lo que se abrió a mano.
			if (entry.leaf && entry.lastValue !== o.value) {
				entry.lastValue = o.value;
				entry.manual = null;
			}

			const value = this.objectValue(o);
			const text = (o.name || this.kindName(o.kind)) + (value !== '' ? ` · ${value}` : '');

			if (entry.labelText !== text || entry.labelTheme !== this.theme()) {
				const c = document.createElement('canvas');
				const g = c.getContext('2d');
				const fontPx = 34;

				g.font = `700 ${fontPx}px Arial, sans-serif`;
				c.width = Math.min(900, Math.ceil(g.measureText(text).width) + 48);
				c.height = 72;
				g.fillStyle = pal.label;
				g.beginPath();

				if (g.roundRect) {
					g.roundRect(4, 6, c.width - 8, c.height - 12, 14);
				}
				else {
					g.rect(4, 6, c.width - 8, c.height - 12);
				}

				g.fill();
				g.fillStyle = this.objectColor(o);
				g.fillRect(14, 22, 8, c.height - 44);
				g.fillStyle = pal.labelText;
				g.font = `700 ${fontPx}px Arial, sans-serif`;
				g.textBaseline = 'middle';
				g.fillText(text, 32, c.height / 2 + 1);

				const tex = new this.THREE.CanvasTexture(c);

				tex.colorSpace = this.THREE.SRGBColorSpace;

				if (entry.label.material.map) {
					entry.label.material.map.dispose();
				}

				entry.label.material.map = tex;
				entry.label.material.needsUpdate = true;
				entry.label.scale.set(c.width / c.height * 0.15, 0.15, 1);
				entry.label.visible = this.data.cfg.labels || !LakaInfra3DScene.SMALL_KINDS.includes(o.kind);
				entry.labelText = text;
				entry.labelTheme = this.theme();
			}
		}
	}

	// ---------------------------------------------------------------- mapa de calor del piso

	/**
	 * Interpola la temperatura de la sala (distancia inversa ponderada) a partir de los sensores,
	 * los aires y la temperatura máxima de cada rack, y la pinta sobre el piso.
	 */
	updateHeatFloor() {
		if (!this.world) {
			return;
		}

		const THREE = this.THREE;
		const L = LakaInfra3DScene;
		const w = this.world;

		if (this.mode !== 'heat') {
			if (this.heat) {
				this.heat.mesh.visible = false;
			}

			return;
		}

		const points = [];

		for (const entry of w.objects) {
			const o = entry.o;

			if (o.units === '°C' && o.value !== null && o.value !== undefined
					&& ['sensor', 'crac', 'inrow', 'split'].includes(o.kind)) {
				points.push([entry.center.x, entry.center.z, o.value]);
			}
		}

		for (const rack of w.racks.values()) {
			const temps = rack.devices.map((x) => x.d.temp).filter((v) => v !== null && v !== undefined);

			if (temps.length) {
				const front = new THREE.Vector3(0, 0, L.DEP / 2 + 0.3).applyMatrix4(rack.frame.matrix);

				points.push([front.x, front.z, Math.max(...temps)]);
			}
		}

		if (!points.length) {
			return;
		}

		const b = w.bounds;
		const N = 96;
		const canvas = document.createElement('canvas');

		canvas.width = N;
		canvas.height = N;

		const g = canvas.getContext('2d');
		const img = g.createImageData(N, N);

		for (let j = 0; j < N; j++) {
			for (let i = 0; i < N; i++) {
				const x = b.minX + (i + 0.5) / N * b.w;
				const z = b.minZ + (j + 0.5) / N * b.d;
				let num = 0;
				let den = 0;
				let exact = null;

				for (const [px, pz, t] of points) {
					const d2 = (x - px) ** 2 + (z - pz) ** 2;

					if (d2 < 0.01) {
						exact = t;
						break;
					}

					num += t / d2;
					den += 1 / d2;
				}

				const c = this.tempColor(exact !== null ? exact : num / den);
				const k = (j * N + i) * 4;

				img.data[k] = Math.round(c.r * 255);
				img.data[k + 1] = Math.round(c.g * 255);
				img.data[k + 2] = Math.round(c.b * 255);
				img.data[k + 3] = 165;
			}
		}

		g.putImageData(img, 0, 0);

		const tex = new THREE.CanvasTexture(canvas);

		tex.colorSpace = THREE.SRGBColorSpace;

		if (!this.heat || this.heat.world !== w) {
			const mesh = new THREE.Mesh(new THREE.PlaneGeometry(b.w, b.d),
				new THREE.MeshBasicMaterial({transparent: true, depthWrite: false})
			);

			mesh.rotation.x = -Math.PI / 2;
			mesh.position.set(b.cx, 0.008, b.cz);
			mesh.renderOrder = 1;
			w.group.add(mesh);
			this.heat = {mesh, world: w};
		}

		if (this.heat.mesh.material.map) {
			this.heat.mesh.material.map.dispose();
		}

		this.heat.mesh.material.map = tex;
		this.heat.mesh.material.needsUpdate = true;
		this.heat.mesh.visible = true;
		this.heat.min = Math.min(...points.map((p) => p[2]));
		this.heat.max = Math.max(...points.map((p) => p[2]));
	}

	// ---------------------------------------------------------------- flujo de aire

	toggleFlow() {
		this.flowOn = !this.flowOn;
		this.root.querySelector('[data-act="flow"]').setAttribute('aria-pressed', String(this.flowOn));

		if (this.flowOn) {
			this.buildFlow();
		}
		else if (this.flow) {
			this.flow.points.visible = false;
		}
	}

	/**
	 * Partículas de aire: salen frías de los aires, suben por las baldosas perforadas del pasillo,
	 * entran por el frente de los racks, salen calientes por atrás y vuelven por el techo.
	 */
	buildFlow() {
		const THREE = this.THREE;
		const L = LakaInfra3DScene;
		const w = this.world;

		if (!w || this.flow && this.flow.world === w) {
			if (this.flow) {
				this.flow.points.visible = true;
			}

			return;
		}

		// El aire frío entra por los pasillos que tienen frentes de racks (fríos o mixtos).
		const intake = w.aisles.filter((a) => a.sides.length);

		if (!intake.length) {
			this.toast(this.t('No hay pasillos para mostrar el flujo de aire.'));

			return;
		}

		const coolers = w.objects.filter((x) => ['crac', 'inrow', 'split'].includes(x.o.kind));
		const N = Math.min(900, 160 * intake.length + 200);
		const paths = [];

		for (let i = 0; i < N; i++) {
			const aisle = intake[i % intake.length];
			const side = aisle.sides[Math.floor(Math.random() * aisle.sides.length)];
			const x = aisle.x0 + Math.random() * (aisle.x1 - aisle.x0);
			const z0 = aisle.z0 + 0.15 + Math.random() * Math.max(0.1, aisle.z1 - aisle.z0 - 0.3);
			const yIn = 0.3 + Math.random() * 1.6;
			const back = side.z + side.dir * (L.DEP + 0.35);
			let start;
			let end;

			if (coolers.length) {
				const c = coolers[Math.floor(Math.random() * coolers.length)];
				const fwd = new THREE.Vector3(0, 0, 0.7).applyQuaternion(c.quat);

				start = c.center.clone().add(fwd).setY(c.o.kind === 'split' ? 2.25 : 0.3);
				end = c.center.clone().setY(c.o.kind === 'split' ? 2.4 : 2.1);
			}
			else {
				start = new THREE.Vector3(aisle.x0 - 0.8, 0.1, (aisle.z0 + aisle.z1) / 2);
				end = new THREE.Vector3(aisle.x0 - 0.8, 2.6, back);
			}

			const pts = [
				start,
				new THREE.Vector3(x, 0.06, z0),
				new THREE.Vector3(x, yIn, side.z - side.dir * 0.05),
				new THREE.Vector3(x, yIn + 0.1, back),
				new THREE.Vector3(x * 0.7 + end.x * 0.3, 2.75, back + side.dir * 0.3),
				end
			];

			paths.push({curve: new THREE.CatmullRomCurve3(pts), off: Math.random(), speed: 0.045 + Math.random() * 0.03});
		}

		const geo = new THREE.BufferGeometry();
		const pos = new Float32Array(N * 3);
		const col = new Float32Array(N * 3);

		geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
		geo.setAttribute('color', new THREE.BufferAttribute(col, 3));

		// En temas oscuros las partículas suman luz; en los claros se pintan normal para que se vean.
		const points = new THREE.Points(geo, new THREE.PointsMaterial({size: 0.07, vertexColors: true, transparent: true,
			opacity: 0.9, depthWrite: false, blending: this.isDark() ? THREE.AdditiveBlending : THREE.NormalBlending
		}));

		points.frustumCulled = false;
		w.group.add(points);
		this.flow = {world: w, points, paths, pos, col, cold: new THREE.Color('#4fb3ff'), hot: new THREE.Color('#ff6a4a'),
			v: new THREE.Vector3(), c: new THREE.Color()
		};
	}

	updateFlow(now) {
		const f = this.flow;

		if (!f || !f.points.visible) {
			return;
		}

		const time = now / 1000;

		for (let i = 0; i < f.paths.length; i++) {
			const p = f.paths[i];
			const u = (p.off + time * p.speed) % 1;

			p.curve.getPointAt(u, f.v);
			f.pos[i * 3] = f.v.x;
			f.pos[i * 3 + 1] = f.v.y;
			f.pos[i * 3 + 2] = f.v.z;
			f.c.copy(f.cold).lerp(f.hot, Math.min(1, Math.max(0, (u - 0.45) / 0.12)));
			f.col[i * 3] = f.c.r;
			f.col[i * 3 + 1] = f.c.g;
			f.col[i * 3 + 2] = f.c.b;
		}

		f.points.geometry.attributes.position.needsUpdate = true;
		f.points.geometry.attributes.color.needsUpdate = true;
	}

	// ---------------------------------------------------------------- recorrido animado

	/**
	 * Recorrido guiado: entra por la puerta (si hay), camina por cada pasillo frío, pasa por los aires
	 * y termina frente a los equipos con los problemas más graves.
	 */
	startTour() {
		if (!this.world) {
			return;
		}

		const THREE = this.THREE;
		const w = this.world;
		const steps = [];
		const door = w.objects.find((x) => x.o.kind === 'door');

		this.closePanel();

		if (door) {
			const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(door.quat);
			const base = door.group.position.clone();

			steps.push({pos: base.clone().addScaledVector(fwd, -2.6).setY(1.65), target: base.clone().addScaledVector(fwd, 2).setY(1.3),
				caption: `${this.t('Ingreso')} · ${door.o.name || this.kindName('door')}`, ms: 1400, hold: 1600
			});
			steps.push({pos: base.clone().addScaledVector(fwd, 1.2).setY(1.65), target: base.clone().addScaledVector(fwd, 5).setY(1.1),
				caption: `${this.t('Ingreso')} · ${door.o.name || this.kindName('door')}`, ms: 1600, hold: 600
			});
		}

		w.aisles.filter((a) => a.sides.length).slice(0, 6).forEach((a, i) => {
			const zc = (a.z0 + a.z1) / 2;

			steps.push({pos: new THREE.Vector3(a.x0 - 1.4, 1.6, zc), target: new THREE.Vector3(a.x0 + 2, 1.15, zc),
				caption: `${this.t('Pasillo frío')} ${i + 1}`, ms: 1600, hold: 800
			});
			steps.push({pos: new THREE.Vector3(a.x1 - 0.6, 1.6, zc), target: new THREE.Vector3(a.x1 + 2, 1.1, zc),
				caption: `${this.t('Pasillo frío')} ${i + 1}`, ms: Math.max(2200, (a.x1 - a.x0) * 700), hold: 600
			});
		});

		const coolers = w.objects.filter((x) => ['crac', 'inrow', 'split', 'ups'].includes(x.o.kind));

		if (coolers.length) {
			const c = new THREE.Vector3();

			coolers.forEach((x) => c.add(x.center));
			c.divideScalar(coolers.length);
			steps.push({pos: c.clone().add(new THREE.Vector3(-3.2, 3.0, 3.2)), target: c.clone().setY(1.0),
				caption: this.t('Aires, UPS y energía de la sala'), ms: 1800, hold: 1800
			});
		}

		const worst = w.devices.filter((x) => x.d.sev >= 2).sort((a, b) => b.d.sev - a.d.sev).slice(0, 3);

		for (const dev of worst) {
			const frame = w.racks.get(dev.rack).frame;
			const normal = new THREE.Vector3(0, 0, dev.d.face === 'back' ? -1 : 1).applyQuaternion(frame.quat);
			const side = new THREE.Vector3(0.3, 0.25, 0).applyQuaternion(frame.quat);
			const p = dev.d.problems[0];

			steps.push({pos: dev.center.clone().addScaledVector(normal, 1.3).add(side), target: dev.center.clone(),
				caption: `${dev.d.name} · ${this.data.severities[dev.d.sev].name}${p ? ': ' + p.name : ''}`, ms: 1600,
				hold: 2600, device: dev
			});
		}

		steps.push({pos: w.home.pos.clone(), target: w.home.target.clone(), caption: this.t('Fin del recorrido'), ms: 1800,
			hold: 1200
		});

		this.tour = {steps, i: -1, until: 0};
		this.root.querySelector('[data-act="tour"]').setAttribute('aria-pressed', 'true');
		this.setAutoRotate(false);
		this.nextTourStep(performance.now());
	}

	nextTourStep(now) {
		const tour = this.tour;

		tour.i++;

		if (tour.i >= tour.steps.length) {
			this.stopTour();

			return;
		}

		const step = tour.steps[tour.i];

		this.fly = {p0: this.camera.position.clone(), t0: this.controls.target.clone(), p1: step.pos, t1: step.target,
			start: now, ms: step.ms
		};
		tour.until = now + step.ms + step.hold;
		this.caption.textContent = step.caption;
		this.caption.hidden = false;

		if (step.device) {
			this.selected = step.device;
			this.placeOutline(step.device);
		}
		else {
			this.clearSelection();
		}
	}

	stopTour() {
		if (!this.tour) {
			return;
		}

		this.tour = null;
		this.caption.hidden = true;
		this.root.querySelector('[data-act="tour"]').setAttribute('aria-pressed', 'false');
	}

	// ---------------------------------------------------------------- ventana de infraestructura

	openObject(entry) {
		this.clearSelection();
		this.panelState = {kind: 'object', id: entry.o.id};
		this.renderObject(entry);

		// En fila: la misma vista que un rack, desde el pasillo frío.
		const slot = entry.o.mount === 'row' && this.world.racks.get(entry.o.rack);

		if (slot) {
			this.flyToFront(slot.frame, slot.center, 2.2, slot.H * 0.55);

			return;
		}

		// Cámara: se muestra lo que cubre en el piso, no la pared donde está.
		if (entry.coverView) {
			this.flyTo(entry.coverView.pos, entry.coverView.target);

			return;
		}

		const dist = {sensor: 1.2, split: 2.6, door: 3.2}[entry.o.kind] || 3.6;
		const fwd = new this.THREE.Vector3(0.35 * dist, 0, dist).applyQuaternion(entry.quat);
		const target = entry.center.clone();

		this.flyTo(target.clone().add(fwd).add(new this.THREE.Vector3(0, 0.35 * dist, 0)), target);
	}

	renderObject(entry) {
		const esc = LakaInfra3DScene.esc;
		const o = entry.o;
		const color = this.objectColor(o);
		const walls = {n: 'Pared de arriba', s: 'Pared de abajo', w: 'Pared izquierda', e: 'Pared derecha'};
		const slot = o.mount === 'row' && this.world.racks.get(o.rack);
		let where;

		if (o.mount === 'rack') {
			where = `${this.t('Rack')} ${o.rack} · ${this.t({top: 'arriba', mid: 'al medio', bottom: 'abajo'}[o.level])} · ${o.face === 'back' ? this.t('atrás') : this.t('Frente').toLowerCase()}`;
		}
		else if (slot) {
			where = `${this.t('Fila')} ${slot.def.row_label} · ${Math.round(slot.width * 1000)} mm`;
		}
		else if (o.mount === 'wall') {
			where = `${this.t(walls[o.wall] || walls.n)} · ${o.offset} m`;
		}
		else if (o.mount === 'ceiling') {
			where = `${this.t('En el techo')} · x ${o.x} m · z ${o.z} m · ${o.height || 3} m`;
		}
		else {
			where = `x ${o.x} m · z ${o.z} m`;
		}

		// Baldosa donde está el elemento (en filas y racks la da el rack).
		const tile = o.mount !== 'rack' && !slot ? this.gridRef(entry.group.position.x, entry.group.position.z) : '';

		if (tile) {
			where += ` · ${this.t('Baldosa')} ${tile}`;
		}

		const value = this.objectValue(o);
		let body = '';

		if (!o.linked) {
			body = `<p class="laka3d-muted">${esc(this.t('Sin host vinculado. Vincúlalo en el editor, pestaña Infraestructura.'))}</p>`;
		}
		else {
			const problems = o.problems.length
				? o.problems.map((p) => `<div class="laka3d-alert" style="border-color:${esc(this.data.severities[p.sev].color)}"><strong style="color:${esc(this.data.severities[p.sev].color)}">${esc(this.data.severities[p.sev].name)}</strong><span>${esc(p.name)}</span><span class="laka3d-muted">${esc(this.ago(p.clock))}${p.ack ? ' · ' + esc(this.t('reconocido')) : ''}</span></div>`).join('')
				: `<p class="laka3d-ok">${esc(o.maint ? this.t('En mantenimiento') : this.t('Sin problemas activos'))}</p>`;

			body = `
				<div class="laka3d-kpis">
					<div><span class="laka3d-muted">${esc(o.item_name || this.t('Valor'))}</span><strong style="color:${esc(color)}">${esc(value || '—')}</strong></div>
					${o.kind === 'sensor' ? `<div><span class="laka3d-muted">${esc(this.t('Humedad'))}</span><strong>${o.hum !== null && o.hum !== undefined ? esc(o.hum) + ' %' : '—'}</strong></div>` : ''}
					<div><span class="laka3d-muted">${esc(this.t('Problemas'))}</span><strong>${o.pcount || 0}</strong></div>
				</div>
				${problems}
				<div class="laka3d-inv"><span class="laka3d-muted">${esc(this.t('Host'))}</span><strong>${esc(o.host_name)}</strong><span class="laka3d-muted">${esc(this.t('Clave'))}</span><strong>${esc(o.pattern)}</strong></div>
				<h4>${esc(this.t('Abrir en Zabbix'))}</h4>
				<div class="laka3d-links">
					<a href="${esc(this.data.links.problems + encodeURIComponent(o.hostid))}" target="_blank" rel="noopener">${esc(this.t('Problemas'))}</a>
					<a href="${esc(this.data.links.latest + encodeURIComponent(o.hostid))}" target="_blank" rel="noopener">${esc(this.t('Últimos datos'))}</a>
					<a href="${esc(this.data.links.graphs + encodeURIComponent(o.hostid))}" target="_blank" rel="noopener">${esc(this.t('Gráficas'))}</a>
					<a href="${esc(this.data.links.host + encodeURIComponent(o.host))}" target="_blank" rel="noopener">${esc(this.t('Configuración'))}</a>
				</div>`;
		}

		this.panel.innerHTML = `
			${this.crumbs([{t: this.roomName(), go: 'room'}, {t: this.kindName(o.kind)}, {t: o.name || this.kindName(o.kind)}])}
			<div class="laka3d-head"><span class="laka3d-dot" style="background:${esc(color)}"></span>
				<div class="laka3d-titles"><strong>${esc(o.name || this.kindName(o.kind))}</strong><span class="laka3d-muted">${esc(this.kindName(o.kind))}${LakaInfra3DScene.VARIANTS[o.kind] ? ' · ' + esc(LakaInfra3DScene.variantName(o, this.t.bind(this))) : ''} · ${esc(where)}</span></div>
				<button type="button" class="laka3d-x" data-act="close" aria-label="${esc(this.t('Cerrar'))}">✕</button></div>
			${o.kind === 'door' ? this.doorHtml(entry) : ''}
			${body}
			${this.objectNetHtml(o)}`;

		this.panel.hidden = false;
	}

	/**
	 * Conexión de red del elemento: recorrido del cable desde el elemento, por el patch panel (atrás → frente),
	 * hasta el puerto del switch, con las etiquetas ANSI/TIA-606. Cada equipo abre su vista en la sala.
	 */
	objectNetHtml(o) {
		const esc = LakaInfra3DScene.esc;
		const store = this.data.cabling;

		if (!o.id || typeof LakaInfra3DCabling === 'undefined' || !LakaInfra3DCabling.NET_KINDS.includes(o.kind) || !this.devView) {
			return '';
		}

		const ep = LakaInfra3DCabling.objEp(o.id);
		const first = store ? LakaInfra3DCabling.cableAt(store, ep) : null;

		if (!first) {
			return `<h4>${esc(this.t('Conexión de red'))}</h4><p class="laka3d-muted">${esc(this.t('Sin conexión documentada. Se configura en el editor, pestaña Infraestructura.'))}</p>`;
		}

		const path = LakaInfra3DCabling.path(store, ep);
		const steps = [];

		for (let i = 1; i < path.length; i++) {
			const info = this.devView.endpointInfo(path[i]);
			const p = LakaInfra3DCabling.split(path[i]);
			const cable = LakaInfra3DCabling.cableAt(store, path[i]);
			const viaCable = cable && (cable.a === path[i - 1] || cable.b === path[i - 1]);

			// Las dos caras del mismo puerto del panel van en un solo paso.
			if (!viaCable) {
				continue;
			}

			const label = cable.l || `${this.devView.endpointInfo(cable.a).tia} / ${this.devView.endpointInfo(cable.b).tia}`;
			const side = p.kind === 'pp' ? ` (${p.face === 'R' ? this.t('atrás') : this.t('frente')})` : '';
			const name = info.dev
				? `<button type="button" class="laka3d-linkbtn" data-dev="${esc(info.dev.d.id)}">${esc(info.name)}</button>`
				: `<strong>${esc(info.name)}</strong>`;

			steps.push(`
				<li><span class="laka3d-net-cable" style="background:${esc(cable.c || '#2f80ed')}"></span>
					<div><code>${esc(label)}</code>${cable.len ? ` <span class="laka3d-muted">· ${esc(cable.len)} m</span>` : ''}</div></li>
				<li><span class="laka3d-net-dot"></span><div>${name} <span class="laka3d-muted">· ${esc(info.port)}${esc(side)} · ${esc(info.where)}</span><br><code>${esc(info.tia)}</code></div></li>`);
		}

		const last = this.devView.endpointInfo(path[path.length - 1]);
		const end = last.dev && LakaInfra3DCabling.split(path[path.length - 1]).kind !== 'pp'
			? `<p class="laka3d-ok">${esc(this.t('Llega a %1$s · %2$s', last.name, last.port))}</p>`
			: `<p class="laka3d-muted">${esc(this.t('El recorrido termina en el panel: falta el cordón del frente al switch.'))}</p>`;

		return `
			<h4>${esc(this.t('Conexión de red'))}</h4>
			${end}
			<ol class="laka3d-net-path">
				<li><span class="laka3d-net-dot is-start"></span><div><strong>${esc(o.name || this.kindName(o.kind))}</strong> <span class="laka3d-muted">· RJ45</span></div></li>
				${steps.join('')}
			</ol>`;
	}

	/** Botones de la puerta: abrir/cerrar en la vista y entrar a la sala. */
	doorHtml(entry) {
		const esc = LakaInfra3DScene.esc;
		const o = entry.o;
		const open = (entry.manual !== null ? entry.manual : (Number(o.value) > 0 ? 1 : 0)) > 0.5;
		const state = o.hostid
			? (Number(o.value) > 0 ? this.t('Abierta según Zabbix') : this.t('Cerrada según Zabbix'))
			: this.t('Sin sensor de puerta');

		return `
			<div class="laka3d-doorbar">
				<span class="laka3d-muted">${esc(state)} · ${esc(o.leaves === 2 ? this.t('Doble hoja') : this.t('Una hoja'))} · ${esc(o.face === 'back' ? this.t('abre hacia afuera') : this.t('abre hacia adentro'))}</span>
				<div class="laka3d-ed-btns">
					<button type="button" class="laka3d-btn" data-act="door-toggle">${esc(open ? this.t('Cerrar puerta') : this.t('Abrir puerta'))}</button>
					${o.mount === 'wall' ? `<button type="button" class="laka3d-btn laka3d-btn-primary" data-act="door-enter">${esc(this.t('Entrar a la sala'))}</button>` : ''}
				</div>
			</div>`;
	}

	// ---------------------------------------------------------------- colores

	setMode(mode) {
		const was = this.mode;

		this.mode = mode;

		// Energía: abre su ventana (redundancia y simulación); al salir se termina la simulación.
		if (was === 'power' && mode !== 'power' && this.power) {
			this.power.leave();

			if (this.panelState && this.panelState.kind === 'power') {
				this.closePanel();
			}
		}

		this.applyMode();
		this.renderLegend();

		// Calor: abre el resumen de ambiente según ASHRAE; al salir se cierra.
		if (was === 'heat' && mode !== 'heat' && this.panelState && this.panelState.kind === 'ambient') {
			this.closePanel();
		}

		if (mode === 'power' && this.power && was !== 'power') {
			this.power.open();
		}
		else if (mode === 'heat' && this.energy && was !== 'heat') {
			this.energy.openAmbient();
		}
		else {
			this.refreshPanel();
		}
	}

	/**
	 * Color de base del frente de un equipo según el modo (estado o calor).
	 */
	frontColor(d) {
		if (d.type === 'patch') {
			return new this.THREE.Color('#ffffff');
		}

		if (this.mode === 'heat') {
			return this.tempColor(d.temp);
		}

		if (this.mode === 'capacity') {
			return new this.THREE.Color(this.palette().okFront);
		}

		if (this.mode === 'power' && this.power) {
			return new this.THREE.Color(this.power.color(d) || this.palette().okFront);
		}

		return new this.THREE.Color(d.sev >= 0 ? this.sevColor(d) : this.palette().okFront);
	}

	applyMode() {
		if (!this.world) {
			return;
		}

		const THREE = this.THREE;
		const heat = this.mode === 'heat';
		const touched = new Set();

		this.root.querySelectorAll('[data-mode]').forEach((b) => {
			b.setAttribute('aria-pressed', String(b.dataset.mode === this.mode));
		});

		this.world.pulsing = [];

		if (this.mode === 'power' && this.power) {
			this.power.analyze();
		}

		for (const dev of this.world.devices) {
			const d = dev.d;

			dev.base = this.frontColor(d);
			dev.front.mesh.setColorAt(dev.front.i, dev.base);
			touched.add(dev.front.mesh);

			if (dev.led) {
				dev.led.mesh.setColorAt(dev.led.i, heat ? this.tempColor(d.temp)
					: new THREE.Color(this.mode === 'capacity' ? '#5f676e' : (this.mode === 'power' ? dev.base.getStyle() : this.sevColor(d))));
				touched.add(dev.led.mesh);
			}

			if (this.mode === 'status' && d.sev >= 3 && d.type !== 'patch') {
				this.world.pulsing.push(dev);
			}
		}

		for (const rack of this.world.racks.values()) {
			if (rack.cooler) {
				continue;
			}

			let color;

			if (heat) {
				const temps = rack.devices.map((x) => x.d.temp).filter((v) => v !== null && v !== undefined);
				color = temps.length ? this.tempColor(Math.max(...temps)) : new THREE.Color('#59636d');
			}
			else if (this.mode === 'power' && this.power) {
				color = new THREE.Color(this.power.rackColor(rack));
			}
			else {
				const active = rack.devices.filter((x) => !x.d.passive);
				const worst = active.reduce((acc, x) => (x.d.sev > acc.sev ? x.d : acc), {sev: -1, maint: false});

				color = new THREE.Color(active.length ? this.sevColor(worst) : '#59636d');
			}

			this.world.bars.setColorAt(rack.barIndex, color);
		}

		touched.add(this.world.bars);

		// PDU verticales: color de severidad de sus hosts en modo Estado; neutras en los demás modos.
		for (const v of this.world.vpdus || []) {
			const sev = v.rack.def.pdu_sev ?? -1;

			v.mesh.setColorAt(v.n, new THREE.Color(this.mode === 'power' && this.power ? this.power.vpduColor(v)
				: (this.mode === 'status' && sev >= 0 ? this.data.severities[sev].color : '#ffffff')));
			touched.add(v.mesh);
		}

		// En modo Capacidad la barra del rack toma el color de su uso (espacio, energía o peso).
		if (this.capacity) {
			this.capacity.apply(this.mode === 'capacity');
		}

		for (const mesh of touched) {
			mesh.instanceColor.needsUpdate = true;
		}

		this.updateObjects();
		this.updateHeatFloor();
	}

	renderLegend() {
		if (!this.data) {
			return;
		}

		const esc = LakaInfra3DScene.esc;

		if (this.mode === 'heat') {
			const range = this.heat && this.heat.mesh.visible
				? `<span>${esc(this.t('Sala'))}: <strong>${this.heat.min} – ${this.heat.max} °C</strong></span>` : '';

			this.legend.innerHTML = `<span class="laka3d-grad"></span><span>18 °C</span><span>30 °C</span><span>42 °C</span>${range}`
				+ (this.energy ? this.energy.legendHtml() : '');

			return;
		}

		if (this.mode === 'capacity' && this.capacity && this.world) {
			this.legend.innerHTML = this.capacity.legendHtml();

			return;
		}

		if (this.mode === 'power' && this.power && this.world) {
			this.legend.innerHTML = this.power.legendHtml();

			return;
		}

		const stats = this.data.stats;
		let html = `<span class="laka3d-total"><strong>${stats.total}</strong> ${esc(this.t('equipos'))}</span>`;

		for (let i = 5; i >= 0; i--) {
			const count = stats.by_sev[i] || 0;

			if (count > 0) {
				html += `<span class="laka3d-chip"><i style="background:${esc(this.data.severities[i].color)}"></i>${esc(this.data.severities[i].name)} <strong>${count}</strong></span>`;
			}
		}

		html += `<span class="laka3d-chip"><i style="background:${LakaInfra3DScene.OK_COLOR}"></i>${esc(this.t('OK'))} <strong>${stats.by_sev[-1] || 0}</strong></span>`;

		if (this.data.editor && stats.unplaced > 0) {
			html += `<button type="button" class="laka3d-chip laka3d-chip-btn" data-act="unplaced">${esc(this.t('Sin ubicar'))} <strong>${stats.unplaced}</strong></button>`;
		}

		// Órdenes de trabajo abiertas y garantías por vencer.
		if (this.ops && this.world) {
			html += this.ops.legendChips();
		}
		this.legend.innerHTML = html;
	}

	renderWarnings() {
		const n = (this.data.warnings || []).length;

		this.warnBtn.hidden = n === 0;
		this.warnBtn.textContent = `⚠ ${n}`;
		this.warnBtn.title = this.t('Avisos de ubicación');
		this.warnBtn.setAttribute('aria-label', this.t('Avisos de ubicación'));
	}

	// ---------------------------------------------------------------- selección y cámara

	placeOutline(dev) {
		const L = LakaInfra3DScene;
		const outline = this.world.outline;

		outline.position.copy(dev.center);
		outline.quaternion.copy(dev.quat);
		const host = this.world.racks.get(dev.d.rack);
		const k = host && host.wall ? host.depth / L.DEP : 1;

		outline.scale.set(dev.w + 0.02, dev.n * L.UH + 0.016, (L.DEP - 0.12) * k + 0.02);
		outline.visible = true;
	}

	selectDevice(dev, {broadcast = true, fly = true, detail = false} = {}) {
		this.selected = dev;
		this.placeOutline(dev);
		this.openDevice(dev);

		if (detail && this.devView) {
			this.devView.open(dev);
		}

		if (fly) {
			const frame = this.world.racks.get(dev.rack).frame;
			const sign = dev.d.face === 'back' ? -1 : 1;

			this.flyToFront(frame, dev.center, 1.35 * sign, 0.15);
		}

		if (broadcast && !dev.d.passive && this.cb.onSelectHost) {
			this.cb.onSelectHost(dev.d.id);
			this.toast(this.t('Host %1$s enviado a los widgets vinculados del tablero.',
				`<strong>${LakaInfra3DScene.esc(dev.d.name)}</strong>`), true
			);
		}
	}

	clearSelection() {
		this.selected = null;

		if (this.world) {
			this.world.outline.visible = false;
		}
	}

	/**
	 * Muestra u oculta las paredes de la sala, las puertas y lo que va montado en la pared (modo NOC: así
	 * los racks se ven de frente sin nada delante).
	 */
	setWalls(on) {
		const w = this.world;

		if (!w) {
			return;
		}

		(w.walls || []).forEach((m) => {
			m.visible = on;
		});

		for (const entry of w.objects || []) {
			if (entry.o.kind === 'door' || entry.o.mount === 'wall') {
				if (!on) {
					entry.nocHidden = entry.nocHidden || {group: entry.group.visible, label: entry.label ? entry.label.visible : false};
					entry.group.visible = false;

					if (entry.label) {
						entry.label.visible = false;
					}
				}
				else if (entry.nocHidden) {
					entry.group.visible = entry.nocHidden.group;

					if (entry.label) {
						entry.label.visible = entry.nocHidden.label;
					}

					entry.nocHidden = null;
				}
			}
		}

		this.wallsOn = on;
	}

	/**
	 * Lleva la cámara de frente (o por detrás) al rack completo, a la distancia justa para que entre entero.
	 */
	frameRack(rack, back = false, ms = 1400) {
		const THREE = this.THREE;
		const fov = this.camera.fov * Math.PI / 180;
		const aspect = Math.max(0.5, this.camera.aspect || 1.6);
		const h = rack.H * 1.2;
		const w = (rack.width || 0.6) * 1.6;
		const dist = Math.max(h / 2 / Math.tan(fov / 2), w / 2 / (Math.tan(fov / 2) * aspect)) + 0.6;
		const normal = new THREE.Vector3(0, 0, back ? -1 : 1).applyQuaternion(rack.frame.quat);
		const target = rack.center.clone();
		const pos = target.clone().addScaledVector(normal, dist).add(new THREE.Vector3(0, 0.25, 0));

		// Corte justo delante del frente del rack: lo que queda entre la cámara y el rack (la fila de enfrente,
		// el piso del pasillo) no se dibuja, así el rack se ve entero aunque el pasillo sea angosto.
		const front = target.clone().addScaledVector(normal, LakaInfra3DScene.DEP / 2 + 0.08);
		const plane = new THREE.Plane(normal.clone().negate(), normal.dot(front));

		this.renderer.clippingPlanes = [plane];
		this.flyTo(pos, target, ms);
	}

	/** Quita el corte de frameRack(). */
	clearClip() {
		if (this.renderer.clippingPlanes.length) {
			this.renderer.clippingPlanes = [];
		}
	}

	flyToFront(frame, target, dist, up) {
		const THREE = this.THREE;
		const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(frame.quat);
		const side = new THREE.Vector3(0.25 * Math.abs(dist), up + 0.2 * Math.abs(dist), 0)
			.applyQuaternion(frame.quat);
		const pos = target.clone().addScaledVector(normal, dist).add(side);

		this.flyTo(pos, target);
	}

	flyTo(pos, target, ms = 900) {
		this.fly = {
			p0: this.camera.position.clone(), t0: this.controls.target.clone(),
			p1: pos.clone(), t1: target.clone(), start: performance.now(), ms
		};
		this.setAutoRotate(false);
	}

	// ---------------------------------------------------------------- ventanas

	closePanel() {
		this.panel.hidden = true;
		this.panelState = null;
		this.clearSelection();
	}

	refreshPanel() {
		if (this.rackView) {
			this.rackView.refresh();
		}

		if (this.devView) {
			this.devView.refresh();
		}

		if (!this.panelState || !this.world) {
			return;
		}

		const {kind, id} = this.panelState;

		if (kind === 'rack' && this.world.racks.has(id)) {
			this.renderRack(id);
		}
		else if (kind === 'device' && this.world.devicesById.has(id)) {
			this.renderDevice(this.world.devicesById.get(id));
		}
		else if (kind === 'object' && this.world.objectsById.has(id)) {
			this.renderObject(this.world.objectsById.get(id));
		}
		else if (kind === 'warnings') {
			this.openWarnings();
		}
		else if (kind === 'power' && this.power) {
			this.power.render();
		}
		else if (kind === 'ambient' && this.energy) {
			this.energy.renderAmbient();
		}
		else if (kind === 'planner') {
			// El planificador no se redibuja con cada actualización, para no borrar lo que se está escribiendo.
		}
		else {
			this.closePanel();
		}
	}

	crumbs(parts) {
		const esc = LakaInfra3DScene.esc;

		return `<nav class="laka3d-crumbs" aria-label="${esc(this.t('Ruta'))}">${parts.map((p, i) => (i < parts.length - 1
			? `<button type="button" data-go="${esc(p.go)}">${esc(p.t)}</button><span aria-hidden="true">›</span>`
			: `<span class="laka3d-cur">${esc(p.t)}</span>`)).join('')}</nav>`;
	}

	roomName() {
		return this.data.cfg.room !== '' ? this.data.cfg.room : this.t('Sala principal');
	}

	openRack(name, fly = true, detail = false) {
		this.clearSelection();
		this.panelState = {kind: 'rack', id: name};
		this.renderRack(name);

		if (detail && this.rackView) {
			if (this.devView) {
				this.devView.close();
			}

			this.rackView.open(name);
		}

		if (fly) {
			const rack = this.world.racks.get(name);

			this.flyToFront(rack.frame, rack.center, 2.2, rack.H * 0.55);
		}
	}

	renderRack(name) {
		const esc = LakaInfra3DScene.esc;
		const rack = this.world.racks.get(name);
		const def = rack.def;
		const devs = rack.devices.slice().sort((a, b) => b.d.u - a.d.u);
		const usedFront = new Set();
		const usedBack = new Set();

		for (const x of devs) {
			for (let u = x.d.u; u < x.d.u + x.d.n; u++) {
				(x.d.face === 'back' ? usedBack : usedFront).add(u);
			}
		}

		const temps = devs.map((x) => x.d.temp).filter((v) => v !== null && v !== undefined);
		const probs = devs.filter((x) => x.d.sev >= 0).sort((a, b) => b.d.sev - a.d.sev);
		const worst = probs.length ? probs[0].d : {sev: -1, maint: false};

		const probHtml = probs.length
			? probs.map((x) => `<button type="button" class="laka3d-row" data-dev="${esc(x.d.id)}"><i style="background:${esc(this.sevColor(x.d))}"></i><span><strong>${esc(x.d.name)}</strong> ${esc(x.d.problems[0] ? x.d.problems[0].name : '')}</span></button>`).join('')
			: `<p class="laka3d-muted">${esc(this.t('Sin problemas activos en este rack.'))}</p>`;

		const devHtml = devs.length
			? devs.map((x) => `<button type="button" class="laka3d-row laka3d-devrow" data-dev="${esc(x.d.id)}"><i style="background:${x.d.passive ? '#7f8a94' : esc(this.sevColor(x.d))}"></i><span class="laka3d-dn">${esc(x.d.name)}</span><span class="laka3d-muted">U${x.d.u}${x.d.n > 1 ? '–' + (x.d.u + x.d.n - 1) : ''}${x.d.face === 'back' ? ' · ' + esc(this.t('atrás')) : ''}</span><span class="laka3d-muted">${esc(this.typeName(x.d.type))}</span></button>`).join('')
			: `<p class="laka3d-muted">${esc(this.t('Rack vacío.'))}</p>`;

		this.panel.innerHTML = `
			${this.crumbs([{t: this.roomName(), go: 'room'}, {t: def.mount === 'wall' ? this.t('Rack de pared') : `${this.t('Fila')} ${def.row_label}`, go: 'room'}, {t: `${this.t('Rack')} ${name}`}])}
			<div class="laka3d-head"><span class="laka3d-dot" style="background:${esc(this.sevColor(worst))}"></span>
				<div class="laka3d-titles"><strong>${esc(this.t('Rack'))} ${esc(name)}${this.data.cabling && this.data.cabling.fs && typeof LakaInfra3DCabling !== 'undefined' ? ` <code class="laka3d-tia">${esc(LakaInfra3DCabling.rackId(this.data.cabling, name))}</code>` : ''}</strong><span class="laka3d-muted">${def.units}U · ${esc(LakaInfra3DScene.rackWhere(def, this.t.bind(this)))}${this.gridRef(rack.frame.pos.x, rack.frame.pos.z) ? ` · ${esc(this.t('Baldosa'))} ${esc(this.gridRef(rack.frame.pos.x, rack.frame.pos.z))}` : ''}</span></div>
				<button type="button" class="laka3d-x" data-act="close" aria-label="${esc(this.t('Cerrar'))}">✕</button></div>
			<div class="laka3d-kpis">
				<div><span class="laka3d-muted">${esc(this.t('Ocupación'))}</span><strong>${usedFront.size}/${def.units} U</strong><div class="laka3d-meter"><b style="width:${Math.min(100, usedFront.size / def.units * 100)}%"></b></div></div>
				<div><span class="laka3d-muted">${esc(this.t('Temp. máx.'))}</span><strong>${temps.length ? Math.max(...temps) + ' °C' : '—'}</strong></div>
				<div><span class="laka3d-muted">${esc(this.t('Problemas'))}</span><strong>${probs.length}</strong></div>
			</div>
			${this.rackView ? `<button type="button" class="laka3d-btn laka3d-rv-open" data-act="rack-detail">${LakaInfra3DScene.icon('rack')}<span>${esc(this.t('Vista detallada del rack'))}</span></button>` : ''}
			${this.capacity ? this.capacity.rackHtml(rack) : ''}
			${this.ops ? this.ops.rackHtml(name) : ''}
			<div class="laka3d-rackbody">
				<div>
					<div class="laka3d-seg laka3d-seg-sm" role="group" aria-label="${esc(this.t('Cara del rack'))}">
						<button type="button" data-face="front" aria-pressed="${this.rackFace === 'front'}">${esc(this.t('Frente'))}</button>
						<button type="button" data-face="back" aria-pressed="${this.rackFace === 'back'}">${esc(this.t('Atrás'))}</button>
					</div>
					${this.elevation(rack, this.rackFace)}
				</div>
				<div class="laka3d-side">
					<h4>${esc(this.t('Problemas'))}</h4>${probHtml}
				</div>
			</div>
			<h4>${esc(this.t('Equipos'))} (${devs.length})</h4>
			<div class="laka3d-list">${devHtml}</div>`;

		this.panel.hidden = false;
	}

	elevation(rack, face) {
		const esc = LakaInfra3DScene.esc;
		const units = rack.def.units;
		const px = units > 45 ? 8 : 9;
		let rows = '';

		for (let u = units; u >= 1; u--) {
			rows += `<div style="height:${px}px"><span>${u % 2 === 0 ? u : ''}</span></div>`;
		}

		let blocks = '';

		for (const x of rack.devices) {
			const d = x.d;
			const own = (d.face === 'back') === (face === 'back');
			const top = (units - (d.u + d.n - 1)) * px;
			const h = d.n * px - 1;
			let bg;
			let fg = '#ffffff';

			if (!own) {
				bg = 'repeating-linear-gradient(45deg,#2a3036 0 4px,#232a30 4px 8px)';
				fg = '#9aa5af';
			}
			else if (d.type === 'patch') {
				bg = '#4a535c';
			}
			else if (this.mode === 'heat') {
				bg = this.tempColor(d.temp).getStyle();
				fg = '#0f1317';
			}
			else {
				bg = d.sev >= 0 ? this.sevColor(d) : '#2f3b35';
			}

			const led = own && d.type !== 'patch' && d.sev < 0 && this.mode !== 'heat'
				? `<i style="background:${esc(this.sevColor(d))}"></i>` : '';

			blocks += `<button type="button" class="laka3d-u" data-dev="${esc(d.id)}" style="top:${top}px;height:${h}px;background:${bg};color:${fg}" aria-label="${esc(d.name)}, U${d.u}">${led}<span>${esc(d.name)}</span></button>`;
		}

		return `<div class="laka3d-elev"><div class="laka3d-ucol">${rows}</div><div class="laka3d-udevs" style="height:${units * px}px">${blocks}</div></div>`;
	}

	typeName(type) {
		return this.t({server: 'Servidor', network: 'Red', storage: 'Storage', ups: 'UPS', pdu: 'PDU',
			patch: 'Patch panel', other: 'Otro'}[type] || 'Otro');
	}

	ago(clock) {
		const s = Math.max(0, (this.data.time || Math.floor(Date.now() / 1000)) - clock);
		let txt;

		if (s < 3600) {
			txt = `${Math.max(1, Math.round(s / 60))} min`;
		}
		else if (s < 86400) {
			txt = `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
		}
		else {
			txt = `${Math.floor(s / 86400)} d ${Math.floor((s % 86400) / 3600)} h`;
		}

		return this.t('hace %1$s', txt);
	}

	openDevice(dev) {
		this.panelState = {kind: 'device', id: dev.d.id};
		this.renderDevice(dev);
	}

	renderDevice(dev) {
		const esc = LakaInfra3DScene.esc;
		const d = dev.d;
		const range = d.n > 1 ? `U${d.u}–U${d.u + d.n - 1}` : `U${d.u}`;
		const rack = this.world.racks.get(d.rack).def;
		let body;

		if (d.passive) {
			body = `<p class="laka3d-muted">${esc(this.t('Equipo pasivo: no tiene host en Zabbix.'))}</p>`;
		}
		else {
			const problems = d.problems.length
				? d.problems.map((p) => `<div class="laka3d-alert" style="border-color:${esc(this.data.severities[p.sev].color)}"><strong style="color:${esc(this.data.severities[p.sev].color)}">${esc(this.data.severities[p.sev].name)}</strong><span>${esc(p.name)}</span><span class="laka3d-muted">${esc(this.ago(p.clock))}${p.ack ? ' · ' + esc(this.t('reconocido')) : ''}</span></div>`).join('')
					+ ((d.pcount || 0) > d.problems.length ? `<p class="laka3d-muted">${esc(this.t('y %1$s más', String(d.pcount - d.problems.length)))}</p>` : '')
				: `<p class="laka3d-ok">${esc(d.maint ? this.t('En mantenimiento') : this.t('Sin problemas activos'))}</p>`;

			const inv = d.inv || {};
			const invRows = [
				['Fabricante', inv.vendor], ['Modelo', inv.model], ['N.º de serie', inv.serial],
				['Sistema operativo', inv.os], ['Código de activo', inv.asset], ['Ubicación', inv.location]
			].filter(([, v]) => v);

			// Sin valor: Zabbix solo entrega el último valor dentro del "Período máximo de historial mostrado"
			// (Administración → General → GUI, 24 h por defecto). Un valor de hace más de 15 min se marca.
			const metric = (label, value, unit, color, clock) => {
				if (value === null || value === undefined) {
					return `<div title="${esc(this.t('Zabbix no tiene valores recientes de este ítem (agente sin datos, ítem no soportado o clave distinta).'))}"><span class="laka3d-muted">${esc(this.t(label))}</span><strong class="laka3d-nodata">${esc(this.t('Sin datos recientes'))}</strong></div>`;
				}

				const old = clock && Date.now() / 1000 - clock > 900;

				return `<div><span class="laka3d-muted">${esc(this.t(label))}</span><strong${color && !old ? ` style="color:${color}"` : ''}${old ? ' class="laka3d-stale"' : ''}>${esc(value)}${unit}</strong>${old ? `<em class="laka3d-muted">${esc(this.t('Último dato %1$s', this.ago(clock)))}</em>` : ''}</div>`;
			};
			const avail = d.avail || [];
			const down = avail.some((a) => a.state === 2);
			const chips = avail.length ? `
				<div class="laka3d-avail">${avail.map((a) => {
					// Mismas clases que la lista de hosts de Zabbix (status-green/red/grey), con los colores del tema.
					const state = {1: ['status-green', this.t('Disponible')], 2: ['status-red', this.t('No disponible')]}[a.state] || ['status-grey', this.t('Desconocido')];
					const label = a.active ? `${a.type} ${this.t('activo')}` : a.type;

					return `<span class="laka3d-avail-chip ${state[0]}" title="${esc(label + ': ' + state[1] + (a.error ? ' – ' + a.error : ''))}">${esc(label)}</span>`;
				}).join('')}${down ? `<span class="laka3d-muted">${esc(this.t('Interfaz no disponible: los valores pueden no ser actuales.'))}</span>` : ''}</div>` : '';

			body = `
				${chips}
				${problems}
				<div class="laka3d-kpis">
					${metric('Temperatura', d.temp, ' °C', d.temp !== null && d.temp !== undefined ? this.tempColor(d.temp).getStyle() : '')}
					${metric('CPU', d.cpu, ' %', d.cpu !== null && d.cpu !== undefined ? LakaInfra3DScene.usageColor(d.cpu) : '', d.cpu_clock)}
					${metric('Memoria RAM', d.mem, ' %', d.mem !== null && d.mem !== undefined ? LakaInfra3DScene.usageColor(d.mem) : '', d.mem_clock)}
					${metric('Problemas', d.pcount || 0, '', '')}
				</div>
				${invRows.length ? `<h4>${esc(this.t('Inventario'))}</h4><div class="laka3d-inv">${invRows.map(([k, v]) => `<span class="laka3d-muted">${esc(this.t(k))}</span><strong>${esc(v)}</strong>`).join('')}</div>` : ''}
				<h4>${esc(this.t('Abrir en Zabbix'))}</h4>
				<div class="laka3d-links">
					<a href="${esc(this.data.links.problems + encodeURIComponent(d.id))}" target="_blank" rel="noopener">${esc(this.t('Problemas'))}</a>
					<a href="${esc(this.data.links.latest + encodeURIComponent(d.id))}" target="_blank" rel="noopener">${esc(this.t('Últimos datos'))}</a>
					<a href="${esc(this.data.links.graphs + encodeURIComponent(d.id))}" target="_blank" rel="noopener">${esc(this.t('Gráficas'))}</a>
					<a href="${esc(this.data.links.host + encodeURIComponent(d.host))}" target="_blank" rel="noopener">${esc(this.t('Configuración'))}</a>
				</div>`;
		}

		this.panel.innerHTML = `
			${this.crumbs([{t: this.roomName(), go: 'room'}, {t: rack.mount === 'wall' ? this.t('Rack de pared') : `${this.t('Fila')} ${rack.row_label}`, go: 'room'}, {t: `${this.t('Rack')} ${d.rack}`, go: 'rack:' + d.rack}, {t: d.name}])}
			<div class="laka3d-head"><span class="laka3d-dot" style="background:${d.passive ? '#7f8a94' : esc(this.sevColor(d))}"></span>
				<div class="laka3d-titles"><strong>${esc(d.name)}</strong><span class="laka3d-muted">${esc(d.rack)} · ${range} · ${d.n}U · ${esc(this.typeName(d.type))}${d.face === 'back' ? ' · ' + esc(this.t('atrás')) : ''}</span></div>
				<button type="button" class="laka3d-x" data-act="close" aria-label="${esc(this.t('Cerrar'))}">✕</button></div>
			${this.devView ? `<button type="button" class="laka3d-btn laka3d-rv-open" data-act="dev-detail" data-dev-open="${esc(d.id)}">${LakaInfra3DScene.icon('rack')}<span>${esc(this.t('Vista detallada del equipo'))}</span></button>` : ''}
			${body}`;

		this.panel.hidden = false;
	}

	openWarnings() {
		const esc = LakaInfra3DScene.esc;

		this.panelState = {kind: 'warnings', id: null};
		this.panel.innerHTML = `
			<div class="laka3d-head"><span class="laka3d-dot" style="background:#f2b84b"></span>
				<div class="laka3d-titles"><strong>${esc(this.t('Avisos de ubicación'))}</strong><span class="laka3d-muted">${esc(this.t('Revisa los tags de estos hosts.'))}</span></div>
				<button type="button" class="laka3d-x" data-act="close" aria-label="${esc(this.t('Cerrar'))}">✕</button></div>
			<ul class="laka3d-warnlist">${(this.data.warnings || []).map((w) => `<li>${esc(w)}</li>`).join('')}</ul>`;
		this.panel.hidden = false;
	}

	panelClick(e) {
		// Operación: órdenes de trabajo y etiquetas QR desde el panel del rack.
		const ops = this.ops && e.target.closest('[data-act^="ops-"]');

		if (ops) {
			const act = ops.dataset.act;

			if (act === 'ops-new-wo') {
				this.ops.open('wo', {newOrder: true, rack: ops.dataset.rack});
			}
			else if (act === 'ops-qr-rack') {
				this.ops.open('qr', {qrRack: ops.dataset.rack});
			}
			else if (act === 'ops-open-wo') {
				this.ops.open('wo', {order: ops.dataset.wo});
			}

			return;
		}

		if (this.power && this.panelState && this.panelState.kind === 'power'
				&& ((this.energy && this.energy.panelClick(e)) || this.power.panelClick(e))) {
			return;
		}

		if (this.panelState && this.panelState.kind === 'object') {
			const entry = this.world.objectsById.get(this.panelState.id);

			if (entry && e.target.closest('[data-act="door-toggle"]')) {
				this.toggleDoor(entry);
				this.renderObject(entry);

				return;
			}

			if (entry && e.target.closest('[data-act="door-enter"]')) {
				this.enterRoom(entry);

				return;
			}
		}

		if (this.capacity && this.panelState && this.panelState.kind === 'planner' && this.capacity.panelClick(e)) {
			return;
		}

		const devBtn = e.target.closest('[data-dev]');
		const go = e.target.closest('[data-go]');
		const face = e.target.closest('[data-face]');
		const close = e.target.closest('[data-act="close"]');
		const detail = e.target.closest('[data-act="rack-detail"]');
		const devDetail = e.target.closest('[data-act="dev-detail"]');

		if (close) {
			this.closePanel();
		}
		else if (devDetail && this.devView) {
			const dev = this.world.devicesById.get(devDetail.dataset.devOpen);

			if (dev) {
				this.devView.open(dev);
			}
		}
		else if (detail && this.panelState && this.panelState.kind === 'rack' && this.rackView) {
			this.rackView.open(this.panelState.id);
		}
		else if (devBtn) {
			const dev = this.world.devicesById.get(devBtn.dataset.dev);

			if (dev) {
				this.selectDevice(dev);
			}
		}
		else if (go) {
			if (go.dataset.go === 'room') {
				this.action('home');
			}
			else if (go.dataset.go.startsWith('rack:')) {
				this.openRack(go.dataset.go.slice(5));
			}
		}
		else if (face) {
			this.rackFace = face.dataset.face;
			this.renderRack(this.panelState.id);
		}
	}

	toast(html, isHtml = false) {
		if (isHtml) {
			this.toastEl.innerHTML = html;
		}
		else {
			this.toastEl.textContent = html;
		}

		this.toastEl.hidden = false;
		clearTimeout(this.toastTimer);
		this.toastTimer = setTimeout(() => {
			this.toastEl.hidden = true;
		}, 3500);
	}

	// ---------------------------------------------------------------- ciclo de render

	resize() {
		const w = this.stage.clientWidth;
		const h = this.stage.clientHeight;

		if (w === 0 || h === 0) {
			return;
		}

		this.renderer.setSize(w, h, false);
		this.camera.aspect = w / h;
		this.camera.fov = w < 640 ? 58 : 45;
		this.camera.updateProjectionMatrix();
		this.root.classList.toggle('laka3d-narrow', w < 720);
	}

	start() {
		if (!this.running) {
			this.running = true;
			requestAnimationFrame(this.loop);
		}
	}

	stop() {
		this.running = false;
	}

	loop(now) {
		if (!this.running || document.hidden) {
			return;
		}

		requestAnimationFrame(this.loop);

		if (!this.world) {
			return;
		}

		if (this.fly) {
			const k = Math.min(1, (now - this.fly.start) / this.fly.ms);
			const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;

			this.camera.position.lerpVectors(this.fly.p0, this.fly.p1, e);
			this.controls.target.lerpVectors(this.fly.t0, this.fly.t1, e);

			if (k >= 1) {
				this.fly = null;
			}
		}

		// Los problemas graves (Promedio o más) laten cambiando el brillo de su color.
		if (this.mode === 'status' && this.world.pulsing.length) {
			const k = 0.8 + 0.35 * Math.sin(now / 260);
			const touched = new Set();

			for (const dev of this.world.pulsing) {
				this.pulseColor.copy(dev.base).multiplyScalar(k);
				dev.front.mesh.setColorAt(dev.front.i, this.pulseColor);
				touched.add(dev.front.mesh);
			}

			for (const mesh of touched) {
				mesh.instanceColor.needsUpdate = true;
			}
		}

		this.updateFlow(now);

		if (this.tour && now >= this.tour.until) {
			this.nextTourStep(now);
		}

		if (this.noc) {
			this.noc.tick(now);
		}

		this.animateDoors();
		this.updateCoverage();

		if (this.world.outline.visible) {
			this.world.outline.material.opacity = 0.6 + 0.4 * Math.sin(now / 200);
		}

		this.controls.update();
		this.renderer.render(this.scene, this.camera);
	}

	dispose() {
		this.stop();

		if (this.noc) {
			this.noc.dispose();
		}

		this.resizeObserver.disconnect();

		for (const off of this.disposables) {
			off();
		}

		this.disposeWorld();

		for (const tex of this.texCache.values()) {
			tex.dispose();
		}

		this.controls.dispose();
		this.renderer.dispose();
		this.root.innerHTML = '';
		this.root.classList.remove('laka3d');
	}
}
