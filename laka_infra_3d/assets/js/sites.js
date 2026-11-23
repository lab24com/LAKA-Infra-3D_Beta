/*
 * LAKA Infra 3D – gemelo digital de data center para Zabbix 7.0 – 8.0
 * © LAKA Soluciones Tecnológicas
 * Autor: Willian Tola
 * Licencia GPLv3
 *
 * Sitios y salas: vista general de las regiones (por ejemplo Data center La Paz, Cochabamba, Santa Cruz).
 * - Mapa: un marcador por sitio con el color de su severidad más alta; al tocarlo se ven sus salas y se
 *   entra al data center. Usa Leaflet y el mapa base configurado en Zabbix (Administración → General →
 *   Mapas geográficos), los mismos que el widget Geomap.
 * - Lista: tarjetas por sitio con el estado de cada sala.
 * - Administradores: crear salas y ubicar o mover los sitios en el mapa, o escribir sus coordenadas exactas.
 * - Enfoque del mapa: país resaltado (el resto del mundo se oculta) y alcance país o ciudad.
 *   Contornos: Natural Earth 1:50m (dominio público), servidos de a un país por la acción geo.country.
 */

class LakaInfra3DSites {

	/**
	 * Ubicaciones sugeridas por el nombre del sitio (capitales de Bolivia y ciudades de la región).
	 * Se usan solo hasta que un administrador guarda la ubicación real.
	 */
	static PLACES = [
		['el alto', -16.5047, -68.1633], ['la paz', -16.4955, -68.1336], ['cochabamba', -17.3895, -66.1568],
		['santa cruz', -17.7833, -63.1821], ['sucre', -19.0196, -65.2619], ['oruro', -17.9647, -67.1060],
		['potosi', -19.5836, -65.7531], ['tarija', -21.5355, -64.7296], ['trinidad', -14.8333, -64.9000],
		['beni', -14.8333, -64.9000], ['cobija', -11.0267, -68.7692], ['pando', -11.0267, -68.7692],
		['montero', -17.3422, -63.2558], ['riberalta', -10.9833, -66.1000], ['yacuiba', -22.0153, -63.6775],
		['quillacollo', -17.3923, -66.2784], ['sacaba', -17.3980, -66.0370], ['uyuni', -20.4597, -66.8250],
		['lima', -12.0464, -77.0428], ['santiago', -33.4489, -70.6693], ['buenos aires', -34.6037, -58.3816],
		['sao paulo', -23.5505, -46.6333], ['rio de janeiro', -22.9068, -43.1729], ['brasilia', -15.7939, -47.8828],
		['bogota', 4.7110, -74.0721], ['quito', -0.1807, -78.4678], ['asuncion', -25.2637, -57.5759],
		['montevideo', -34.9011, -56.1645], ['caracas', 10.4806, -66.9036], ['mexico', 19.4326, -99.1332],
		['panama', 8.9824, -79.5199], ['madrid', 40.4168, -3.7038], ['miami', 25.7617, -80.1918]
	];

	// Países con contorno disponible (ISO 3166-1 alfa-2). El nombre se muestra en el idioma del usuario.
	static COUNTRIES = ["AD", "AE", "AF", "AG", "AI", "AL", "AM", "AO", "AQ", "AR", "AS", "AT", "AU", "AW", "AX", "AZ", "BA", "BB", "BD", "BE", "BF", "BG", "BH", "BI", "BJ", "BL", "BM", "BN", "BO", "BR", "BS", "BT", "BW", "BY", "BZ", "CA", "CD", "CF", "CG", "CH", "CI", "CK", "CL", "CM", "CN", "CO", "CR", "CU", "CV", "CW", "CY", "CZ", "DE", "DJ", "DK", "DM", "DO", "DZ", "EC", "EE", "EG", "EH", "ER", "ES", "ET", "FI", "FJ", "FK", "FM", "FO", "FR", "GA", "GB", "GD", "GE", "GG", "GH", "GL", "GM", "GN", "GQ", "GR", "GS", "GT", "GU", "GW", "GY", "HK", "HM", "HN", "HR", "HT", "HU", "ID", "IE", "IL", "IM", "IN", "IO", "IQ", "IR", "IS", "IT", "JE", "JM", "JO", "JP", "KE", "KG", "KH", "KI", "KM", "KN", "KP", "KR", "KW", "KY", "KZ", "LA", "LB", "LC", "LI", "LK", "LR", "LS", "LT", "LU", "LV", "LY", "MA", "MC", "MD", "ME", "MF", "MG", "MH", "MK", "ML", "MM", "MN", "MO", "MP", "MR", "MS", "MT", "MU", "MV", "MW", "MX", "MY", "MZ", "NA", "NC", "NE", "NF", "NG", "NI", "NL", "NO", "NP", "NR", "NU", "NZ", "OM", "PA", "PE", "PF", "PG", "PH", "PK", "PL", "PM", "PN", "PR", "PS", "PT", "PW", "PY", "QA", "RO", "RS", "RU", "RW", "SA", "SB", "SC", "SD", "SE", "SG", "SH", "SI", "SK", "SL", "SM", "SN", "SO", "SR", "SS", "ST", "SV", "SX", "SY", "SZ", "TC", "TD", "TF", "TG", "TH", "TJ", "TL", "TM", "TN", "TO", "TR", "TT", "TW", "TZ", "UA", "UG", "US", "UY", "UZ", "VA", "VC", "VE", "VG", "VI", "VN", "VU", "WF", "WS", "XK", "YE", "ZA", "ZM", "ZW"];

	// Contornos ya descargados (uno por país).
	static geoCache = new Map();

	/**
	 * Lee coordenadas escritas o pegadas: "-16.5047, -68.1633", "16°30'17\"S 68°09'48\"W" o un enlace de
	 * Google Maps / OpenStreetMap (…@-16.50,-68.13,15z, ?q=-16.50,-68.13, #map=15/-16.50/-68.13).
	 * Devuelve {lat, lon} o null si no es válido.
	 */
	static parseCoords(text) {
		const src = String(text || '').trim();

		if (src === '') {
			return null;
		}

		const ok = (lat, lon) => (isFinite(lat) && isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180
			? {lat: Math.round(lat * 1e5) / 1e5, lon: Math.round(lon * 1e5) / 1e5} : null);
		let m;

		// Enlaces de mapas.
		if ((m = /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/.exec(src))
				|| (m = /@(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/.exec(src))
				|| (m = /[?&](?:q|ll|query|mlat)=(-?\d+(?:\.\d+)?)(?:,|%2C|&mlon=)(-?\d+(?:\.\d+)?)/i.exec(src))) {
			return ok(parseFloat(m[1]), parseFloat(m[2]));
		}

		if ((m = /#map=\d+\/(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)/.exec(src))) {
			return ok(parseFloat(m[1]), parseFloat(m[2]));
		}

		// Grados, minutos y segundos con hemisferio (N/S/E/W, también O de oeste).
		const dms = /(\d+(?:[.,]\d+)?)\s*[°º]\s*(?:(\d+(?:[.,]\d+)?)\s*['′’]\s*)?(?:(\d+(?:[.,]\d+)?)\s*(?:"|″|”|''))?\s*([NSEWO])/gi;
		const parts = [...src.matchAll(dms)];

		if (parts.length === 2) {
			const val = (p) => {
				const n = (v) => parseFloat(String(v || '0').replace(',', '.'));
				const v = n(p[1]) + n(p[2]) / 60 + n(p[3]) / 3600;

				return /[SWO]/i.test(p[4]) ? -v : v;
			};
			const latPart = parts.find((p) => /[NS]/i.test(p[4]));
			const lonPart = parts.find((p) => /[EWO]/i.test(p[4]));

			return latPart && lonPart ? ok(val(latPart), val(lonPart)) : null;
		}

		// Decimales: "lat, lon", "lat lon" o "lat; lon".
		if ((m = /^(-?\d+(?:\.\d+)?)\s*[,; ]\s*(-?\d+(?:\.\d+)?)$/.exec(src.replace(/\s+/g, ' ')))) {
			return ok(parseFloat(m[1]), parseFloat(m[2]));
		}

		return null;
	}

	/** Nombre del país en el idioma del usuario (Intl), o el código si el navegador no lo sabe. */
	countryName(code) {
		try {
			if (!this.regionNames) {
				this.regionNames = new Intl.DisplayNames([{es: 'es', pt: 'pt-BR', en: 'en'}[this.data.lang] || 'es'], {type: 'region'});
			}

			return this.regionNames.of(code) || code;
		}
		catch (error) {
			return code;
		}
	}

	/**
	 * @param {HTMLElement} root  Contenedor del widget.
	 * @param {Object} data       Respuesta del controlador (sites, severities, i18n, editor, geomap).
	 * @param {Object} cb         {onRoom(name), onCreate(site, name), onClose()}
	 */
	constructor(root, data, cb) {
		this.root = root;
		this.data = data;
		this.cb = cb;
		this.creating = false;
		this.selected = null;
		this.picking = null;
		this.editing = false;
		this.mapSetup = false;
		this.map = null;
		this.markers = new Map();
		this.hasMap = typeof window.L !== 'undefined';
		this.view = this.hasMap ? (LakaInfra3DSites.load('laka3d.sites.view') || 'map') : 'list';

		this.el = document.createElement('div');
		this.el.className = 'laka3d-sites';
		this.root.appendChild(this.el);
		this.onClick = (e) => this.click(e);
		this.onKeyDown = (e) => {
			if (e.key === 'Escape') {
				if (this.picking) {
					this.picking = null;
					this.render();
				}
				else {
					this.close();
				}
			}
			else if (e.key === 'Enter' && e.target.matches && e.target.matches('[data-coords]')) {
				e.preventDefault();
				const btn = this.el.querySelector(`[data-act="coords-save"][data-site="${e.target.dataset.coords}"]`);

				if (btn) {
					btn.click();
				}
			}
			else if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('[role="button"]')) {
				e.preventDefault();
				e.target.click();
			}
		};
		this.el.addEventListener('click', this.onClick);
		document.addEventListener('keydown', this.onKeyDown);
		this.render();
	}

	static esc(value) {
		return String(value ?? '').replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
			"'": '&#39;'
		}[c]));
	}

	static load(key) {
		try {
			return window.localStorage.getItem(key);
		}
		catch (error) {
			return null;
		}
	}

	static store(key, value) {
		try {
			window.localStorage.setItem(key, value);
		}
		catch (error) {
			// Sin almacenamiento local: se usa la vista por defecto.
		}
	}

	static normalize(text) {
		return String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
	}

	t(text, ...args) {
		const i18n = this.data.i18n || {};
		let out = i18n[text] || text;

		args.forEach((arg, i) => {
			out = out.replace(`%${i + 1}$s`, arg);
		});

		return out;
	}

	sevColor(sev) {
		if (sev < 0) {
			return '#59db8f';
		}

		const s = (this.data.severities || {})[sev];

		return s ? s.color : '#768d99';
	}

	sevName(sev) {
		if (sev < 0) {
			return this.t('Sin problemas');
		}

		const s = (this.data.severities || {})[sev];

		return s ? s.name : '';
	}

	roomLabel(room) {
		return room.name || this.t('Sala principal');
	}

	siteLabel(site) {
		return site.name || this.t('Sin región');
	}

	/** Ubicación del sitio: la guardada o la sugerida por su nombre. */
	coords(site) {
		if (typeof site.lat === 'number' && typeof site.lon === 'number') {
			return {lat: site.lat, lon: site.lon, suggested: false};
		}

		const name = LakaInfra3DSites.normalize(site.name);

		if (name === '') {
			return null;
		}

		const place = LakaInfra3DSites.PLACES.find(([key]) => name.includes(key));

		return place ? {lat: place[1], lon: place[2], suggested: true} : null;
	}

	summary(site) {
		return site.rooms.reduce((acc, r) => {
			acc.racks += r.racks;
			acc.devices += r.devices;
			acc.problems += r.pcount;
			acc.sev = Math.max(acc.sev, r.sev);

			return acc;
		}, {racks: 0, devices: 0, problems: 0, sev: -1});
	}

	// ---------------------------------------------------------------- dibujo

	render() {
		const esc = LakaInfra3DSites.esc;
		const sites = this.data.sites || [];
		const canEdit = !!(this.data.editor && this.data.editor.site_url);
		const totals = sites.reduce((acc, s) => {
			const sum = this.summary(s);

			acc.sites += s.name ? 1 : 0;
			acc.rooms += s.rooms.length;
			acc.racks += sum.racks;
			acc.devices += sum.devices;
			acc.problems += sum.problems;

			return acc;
		}, {sites: 0, rooms: 0, racks: 0, devices: 0, problems: 0});

		this.destroyMap();

		const toggle = this.hasMap ? `
			<div class="laka3d-seg laka3d-sites-toggle" role="group">
				<button type="button" data-view="map" aria-pressed="${this.view === 'map'}">${esc(this.t('Mapa'))}</button>
				<button type="button" data-view="list" aria-pressed="${this.view === 'list'}">${esc(this.t('Lista'))}</button>
			</div>` : '';

		const body = this.view === 'map'
			? `<div class="laka3d-sites-mapview">
					<div class="laka3d-sites-map" aria-label="${esc(this.t('Mapa de sitios'))}"></div>
					<div class="laka3d-sites-side">${sites.map((site, i) => this.siteCard(site, i, canEdit)).join('')}</div>
				</div>
				${this.picking !== null ? `<div class="laka3d-sites-hint">${esc(this.t('Toca el mapa donde está %1$s.', this.siteLabel(sites[this.picking])))} <span class="laka3d-link" role="button" tabindex="0" data-act="pick-cancel">${esc(this.t('Cancelar'))}</span></div>` : ''}`
			: `<div class="laka3d-sites-grid">${sites.map((site, i) => this.siteCard(site, i, canEdit)).join('')}</div>`;

		const names = sites.map((s) => s.name).filter(Boolean);
		const form = this.data.editor ? (this.creating ? `
			<div class="laka3d-site-new">
				<label>${esc(this.t('Sitio o región'))}<input type="text" maxlength="64" list="laka3d-site-names" data-f="site" placeholder="${esc(this.t('Ej.: Data center La Paz'))}" value="${esc(this.data.site || '')}"></label>
				<datalist id="laka3d-site-names">${names.map((n) => `<option value="${esc(n)}"></option>`).join('')}</datalist>
				<label>${esc(this.t('Nombre de la sala'))}<input type="text" maxlength="64" data-f="name" placeholder="${esc(this.t('Ej.: Sala de servidores 1'))}"></label>
				<div class="laka3d-ed-btns">
					<button type="button" class="laka3d-btn laka3d-btn-primary" data-act="create">${esc(this.t('Crear y armar la sala'))}</button>
					<button type="button" class="laka3d-btn" data-act="cancel">${esc(this.t('Cancelar'))}</button>
				</div>
				<p class="laka3d-muted laka3d-site-err" hidden></p>
			</div>` : '') : '';

		this.el.innerHTML = `
			<div class="laka3d-sites-box${this.view === 'map' ? ' is-map' : ''}" role="dialog" aria-label="${esc(this.t('Sitios y salas'))}">
				<div class="laka3d-sites-head">
					<div class="laka3d-titles"><strong>${esc(this.t('Sitios y salas'))}</strong>
						<span class="laka3d-muted">${esc(this.t('%1$s sitios · %2$s salas · %3$s racks · %4$s equipos', String(totals.sites), String(totals.rooms), String(totals.racks), String(totals.devices)))}${totals.problems ? ' · ' + esc(this.t('%1$s problemas', String(totals.problems))) : ''}</span>
					</div>
					<span class="laka3d-ed-grow"></span>
					${this.view === 'map' && canEdit ? `<button type="button" class="laka3d-btn${this.mapSetup ? ' is-on' : ''}" data-act="map-setup" aria-pressed="${this.mapSetup}">${esc(this.t('Configurar mapa'))}</button>` : ''}
					${this.view === 'map' && canEdit ? `<button type="button" class="laka3d-btn${this.editing ? ' is-on' : ''}" data-act="edit-pos" aria-pressed="${this.editing}">${esc(this.editing ? this.t('Listo') : this.t('Mover sitios'))}</button>` : ''}
					${this.data.editor && !this.creating ? `<button type="button" class="laka3d-btn laka3d-btn-primary" data-act="new">+ ${esc(this.t('Nueva sala'))}</button>` : ''}
					${toggle}
					<button type="button" class="laka3d-x" data-act="close" aria-label="${esc(this.t('Cerrar'))}">✕</button>
				</div>
				${form}
				${this.view === 'map' && canEdit ? this.mapSetupHtml() : ''}
				${body}
				<div class="laka3d-sites-foot">
					<span class="laka3d-muted">${esc(this.t('Cada sala se guarda por separado. El sitio agrupa las salas de una misma región; se define en la pestaña Sala del editor.'))}</span>
					<span class="laka3d-brand-inline">© LAKA Soluciones Tecnológicas</span>
				</div>
				<div class="laka3d-sites-toast" hidden></div>
			</div>`;

		if (this.view === 'map') {
			this.buildMap(canEdit);
		}

		if (this.creating) {
			const input = this.el.querySelector('[data-f="name"]');

			if (input) {
				input.focus();
			}
		}
	}

	/** Tarjeta de un sitio con sus salas (en la lista y al costado del mapa). */
	siteCard(site, i, canEdit) {
		const esc = LakaInfra3DSites.esc;
		const sum = this.summary(site);
		const pos = this.coords(site);
		const open = this.view === 'list' || this.selected === i || (this.data.sites || []).length <= 3;
		let where = '';

		if (this.view === 'map' && site.name) {
			where = pos
				? (pos.suggested ? `<em class="laka3d-muted">${esc(this.t('Ubicación sugerida por el nombre'))}</em>` : '')
				: `<em class="laka3d-muted">${esc(this.t('Sin ubicación en el mapa'))}</em>`;

			if (canEdit) {
				where += ` <span class="laka3d-link" role="button" tabindex="0" data-act="pick" data-site="${i}">${esc(pos && !pos.suggested ? this.t('Cambiar ubicación') : this.t('Ubicar en el mapa'))}</span>`;
			}
		}

		// Coordenadas exactas: se escriben o se pegan (decimales, grados o enlace de Google Maps).
		if (site.name && canEdit) {
			const value = pos && !pos.suggested ? `${pos.lat}, ${pos.lon}` : '';

			where += `
				<div class="laka3d-site-coords">
					<input type="text" maxlength="200" data-coords="${i}" value="${esc(value)}" placeholder="-16.4955, -68.1336" aria-label="${esc(this.t('Coordenadas'))}" title="${esc(this.t('Latitud, longitud en grados decimales, en grados y minutos, o un enlace de Google Maps'))}">
					<button type="button" class="laka3d-btn" data-act="coords-save" data-site="${i}">${esc(this.t('Guardar'))}</button>
				</div>`;
		}
		else if (site.name && pos && !pos.suggested) {
			where += ` <span class="laka3d-muted laka3d-site-latlon">${pos.lat.toFixed(5)}, ${pos.lon.toFixed(5)}</span>`;
		}

		return `
			<div class="laka3d-site${this.selected === i ? ' is-selected' : ''}" data-site-card="${i}">
				<div class="laka3d-site-head" role="button" tabindex="0" data-act="focus" data-site="${i}">
					<i style="background:${this.sevColor(sum.sev)}"></i>
					<strong>${esc(this.siteLabel(site))}</strong>
					<span class="laka3d-muted">${esc(this.t('%1$s salas', String(site.rooms.length)))}</span>
				</div>
				<div class="laka3d-site-meta laka3d-muted">${esc(this.t('%1$s racks · %2$s equipos', String(sum.racks), String(sum.devices)))}${sum.problems ? ' · ' + esc(this.t('%1$s problemas', String(sum.problems))) : ''}</div>
				${where ? `<div class="laka3d-site-where">${where}</div>` : ''}
				${open ? site.rooms.map((room) => this.roomRow(room)).join('') : ''}
			</div>`;
	}

	/** Panel "Configurar mapa": país a resaltar y alcance (país completo, ciudad de los sitios o mundo). */
	mapSetupHtml() {
		const esc = LakaInfra3DSites.esc;
		const geo = this.data.geomap || {};
		const current = geo.country || '';

		if (!this.mapSetup && current) {
			return '';
		}

		if (!this.mapSetup) {
			// Sin país elegido: se pide antes de nada.
			return `<div class="laka3d-sites-ask"><span>${esc(this.t('Elige el país del mapa: se resalta y el resto del mundo se oculta.'))}</span> <button type="button" class="laka3d-btn" data-act="map-setup">${esc(this.t('Elegir país'))}</button></div>`;
		}

		const list = LakaInfra3DSites.COUNTRIES.map((c) => [c, this.countryName(c)])
			.sort((a, b) => a[1].localeCompare(b[1], undefined, {sensitivity: 'base'}));
		const scope = geo.scope || 'country';

		return `
			<div class="laka3d-sites-setup">
				<label>${esc(this.t('País'))}
					<select data-f="map-country">
						<option value=""${current === '' ? ' selected' : ''}>${esc(this.t('Mundo (sin resaltar)'))}</option>
						${list.map(([c, n]) => `<option value="${c}"${c === current ? ' selected' : ''}>${esc(n)}</option>`).join('')}
					</select>
				</label>
				<label>${esc(this.t('Enfoque'))}
					<select data-f="map-scope">
						<option value="country"${scope === 'country' ? ' selected' : ''}>${esc(this.t('País completo'))}</option>
						<option value="city"${scope === 'city' ? ' selected' : ''}>${esc(this.t('Ciudad (acercado a los sitios)'))}</option>
					</select>
				</label>
				<div class="laka3d-ed-btns">
					<button type="button" class="laka3d-btn laka3d-btn-primary" data-act="map-save">${esc(this.t('Guardar'))}</button>
					<button type="button" class="laka3d-btn" data-act="map-setup-cancel">${esc(this.t('Cancelar'))}</button>
				</div>
				<span class="laka3d-muted">${esc(this.t('El país queda resaltado con su contorno y el resto del mundo se oculta. Con "Ciudad" el mapa se acerca a los sitios ubicados.'))}</span>
			</div>`;
	}

	roomRow(room) {
		const esc = LakaInfra3DSites.esc;

		return `
			<div class="laka3d-site-room${room.current ? ' is-current' : ''}" role="button" tabindex="0" data-room="${esc(room.name)}">
				<i style="background:${this.sevColor(room.sev)}"></i>
				<span class="laka3d-site-room-text"><strong>${esc(this.roomLabel(room))}</strong>
				<em>${esc(this.t('%1$s racks · %2$s equipos', String(room.racks), String(room.devices)))}${room.pcount ? ' · ' + esc(this.t('%1$s problemas', String(room.pcount))) : ''}</em></span>
				${room.current ? `<b>${esc(this.t('Actual'))}</b>` : '<span class="laka3d-site-go">›</span>'}
			</div>`;
	}

	// ---------------------------------------------------------------- mapa

	buildMap(canEdit) {
		const L = window.L;
		const el = this.el.querySelector('.laka3d-sites-map');
		const geo = this.data.geomap || {};
		const sites = this.data.sites || [];

		this.map = L.map(el, {zoomControl: true, attributionControl: true, worldCopyJump: true});

		if (geo.tile_url) {
			L.tileLayer(geo.tile_url, {maxZoom: geo.max_zoom || 18, attribution: geo.attribution || ''}).addTo(this.map);
		}
		else {
			el.classList.add('is-blank');
		}

		this.markers = new Map();

		const points = [];

		sites.forEach((site, i) => {
			const pos = this.coords(site);

			if (!pos) {
				return;
			}

			const marker = this.addMarker(site, i, pos, canEdit);

			this.markers.set(i, marker);
			points.push([pos.lat, pos.lon]);
		});

		if (points.length > 1) {
			this.map.fitBounds(points, {padding: [60, 60], maxZoom: 9});
		}
		else if (points.length === 1) {
			this.map.setView(points[0], 10);
		}
		else {
			this.map.setView([-16.5, -64.7], 5);
		}

		this.points = points;

		if (geo.country && geo.geo_url) {
			this.applyCountry(geo.country, geo.scope || 'country');
		}

		this.map.on('click', (e) => {
			if (this.picking !== null) {
				const i = this.picking;

				this.picking = null;
				this.savePosition(i, e.latlng.lat, e.latlng.lng);
			}
		});

		if (this.picking !== null) {
			el.classList.add('is-picking');
		}

		// El mapa se crea dentro de una ventana que acaba de aparecer: recalcula su tamaño.
		setTimeout(() => this.map && this.map.invalidateSize(), 60);

		if (this.selected !== null && this.markers.has(this.selected)) {
			setTimeout(() => this.markers.get(this.selected) && this.markers.get(this.selected).openPopup(), 120);
		}
	}

	/** Descarga (una vez) el contorno del país. */
	async loadCountry(code) {
		if (LakaInfra3DSites.geoCache.has(code)) {
			return LakaInfra3DSites.geoCache.get(code);
		}

		const url = `${this.data.geomap.geo_url}&country=${encodeURIComponent(code)}`;
		const response = await fetch(url, {credentials: 'same-origin'});
		const json = await response.json();

		if (!json || !Array.isArray(json.g)) {
			throw new Error('geo');
		}

		LakaInfra3DSites.geoCache.set(code, json);

		return json;
	}

	/**
	 * Resalta el país: contorno azul de Zabbix y el resto del mundo tapado con el fondo del widget
	 * (un polígono del tamaño del mundo con el país como agujero). Encuadra el país o, con alcance
	 * "ciudad", los sitios ubicados.
	 */
	async applyCountry(code, scope) {
		const L = window.L;
		let geo;

		try {
			geo = await this.loadCountry(code);
		}
		catch (error) {
			this.toast(this.t('No se pudo cargar el contorno del país.'));

			return;
		}

		if (!this.map) {
			return;
		}

		const rings = [];

		for (const poly of geo.g) {
			for (const ring of poly) {
				rings.push(ring.map(([lon, lat]) => [lat, lon]));
			}
		}

		const style = getComputedStyle(this.el.querySelector('.laka3d-sites-map'));
		const bg = style.backgroundColor && style.backgroundColor !== 'rgba(0, 0, 0, 0)' ? style.backgroundColor : '#2b2b2b';
		const world = [[-89.99, -540], [-89.99, 540], [89.99, 540], [89.99, -540]];

		// Máscara: el mundo con el país recortado (regla par-impar: los enclaves vuelven a taparse).
		this.mask = L.polygon([world, ...rings], {stroke: false, fillColor: bg, fillOpacity: 0.96, fillRule: 'evenodd',
			interactive: false, className: 'laka3d-geo-mask'
		}).addTo(this.map);
		this.outline = L.polygon(rings, {color: '#4796c4', weight: 2, fill: false, interactive: false,
			className: 'laka3d-geo-outline'
		}).addTo(this.map);

		const [w, s, e, n] = geo.b;
		const bounds = L.latLngBounds([s, w], [n, e]);

		if (scope === 'city' && this.points && this.points.length) {
			this.map.fitBounds(this.points.length > 1 ? this.points : [this.points[0], this.points[0]],
				{padding: [60, 60], maxZoom: 13});

			if (this.points.length === 1) {
				this.map.setView(this.points[0], 12);
			}
		}
		else {
			this.map.fitBounds(bounds, {padding: [20, 20]});
		}

		// No se puede alejar ni salir mucho del país: el foco queda en lo que importa.
		this.map.setMaxBounds(bounds.pad(0.6));
		this.map.setMinZoom(Math.max(0, this.map.getBoundsZoom(bounds.pad(0.6)) - 1));
	}

	/** Guarda país y alcance del mapa en la configuración del módulo. */
	async saveMapSetup() {
		const editor = this.data.editor;
		const country = this.el.querySelector('[data-f="map-country"]').value;
		const scope = this.el.querySelector('[data-f="map-scope"]').value;
		const body = new URLSearchParams({map_country: country, map_scope: country ? scope : 'world',
			lang: this.data.lang || 'es', _csrf_token: editor.site_csrf || ''
		});

		try {
			const response = await fetch(editor.site_url, {
				method: 'POST',
				headers: {'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'},
				body: body.toString()
			});
			const json = await response.json();

			if (json.success) {
				this.data.geomap.country = json.map.country;
				this.data.geomap.scope = json.map.scope;
				this.mapSetup = false;
				this.render();
				this.toast(json.message);
			}
			else {
				this.toast((json.error && json.error.messages || []).join(' ') || this.t('No se pudo guardar el mapa.'));
			}
		}
		catch (error) {
			this.toast(this.t('No se pudo guardar el mapa.'));
		}
	}

	addMarker(site, i, pos, canEdit) {
		const L = window.L;
		const esc = LakaInfra3DSites.esc;
		const sum = this.summary(site);
		const color = this.sevColor(sum.sev);
		const icon = L.divIcon({
			className: 'laka3d-pin-wrap',
			html: `<div class="laka3d-pin${sum.sev >= 3 ? ' is-alarm' : ''}${pos.suggested ? ' is-suggested' : ''}" style="--c:${color}"><b>${site.rooms.length}</b></div>`
				+ `<span class="laka3d-pin-label">${esc(this.siteLabel(site))}${sum.problems ? ` · <em style="color:${color}">${sum.problems}</em>` : ''}</span>`,
			iconSize: [34, 34],
			iconAnchor: [17, 17]
		});
		const marker = L.marker([pos.lat, pos.lon], {icon, draggable: canEdit && this.editing, keyboard: true,
			title: this.siteLabel(site)
		}).addTo(this.map);

		marker.bindPopup(() => this.popupHtml(site, i), {minWidth: 240, maxWidth: 320, className: 'laka3d-popup'});
		marker.on('click', () => {
			this.selected = i;
			this.highlightCard(i);
		});
		marker.on('dragend', () => {
			const p = marker.getLatLng();

			this.savePosition(i, p.lat, p.lng);
		});

		return marker;
	}

	popupHtml(site, i) {
		const esc = LakaInfra3DSites.esc;
		const sum = this.summary(site);
		const div = document.createElement('div');

		div.className = 'laka3d-popup-body';
		div.innerHTML = `
			<div class="laka3d-popup-head"><i style="background:${this.sevColor(sum.sev)}"></i><strong>${esc(this.siteLabel(site))}</strong></div>
			<div class="laka3d-muted">${esc(this.sevName(sum.sev))} · ${esc(this.t('%1$s racks · %2$s equipos', String(sum.racks), String(sum.devices)))}</div>
			${(() => {
				const pos = this.coords(site);

				return pos && !pos.suggested ? `<div class="laka3d-muted laka3d-site-latlon">${pos.lat.toFixed(5)}, ${pos.lon.toFixed(5)}</div>` : '';
			})()}
			${site.rooms.map((room) => this.roomRow(room)).join('')}
			${site.rooms.length === 1 && !site.rooms[0].current ? `<button type="button" class="laka3d-btn laka3d-btn-primary" data-room="${esc(site.rooms[0].name)}">${esc(this.t('Entrar al data center'))}</button>` : ''}`;

		// Los clics del globo se atienden aquí: Leaflet lo dibuja fuera del flujo normal.
		div.addEventListener('click', (e) => this.click(e));

		return div;
	}

	highlightCard(i) {
		this.el.querySelectorAll('[data-site-card]').forEach((card) => {
			card.classList.toggle('is-selected', parseInt(card.dataset.siteCard, 10) === i);
		});

		const card = this.el.querySelector(`[data-site-card="${i}"]`);

		if (card) {
			card.scrollIntoView({block: 'nearest'});
		}
	}

	focusSite(i) {
		const site = (this.data.sites || [])[i];

		this.selected = i;

		if (this.view === 'map' && this.map && this.markers.has(i)) {
			const pos = this.coords(site);

			this.map.flyTo([pos.lat, pos.lon], Math.max(this.map.getZoom(), 10), {duration: 0.8});
			this.markers.get(i).openPopup();

			// Abre la tarjeta para ver sus salas.
			const side = this.el.querySelector('.laka3d-sites-side');

			if (side) {
				side.innerHTML = (this.data.sites || []).map((s, k) => this.siteCard(s, k, !!(this.data.editor && this.data.editor.site_url))).join('');
				this.highlightCard(i);
			}
		}
		else if (this.view === 'map') {
			this.render();
		}
	}

	/** Guarda la ubicación de un sitio en la configuración del módulo. */
	async savePosition(i, lat, lon) {
		const site = (this.data.sites || [])[i];
		const editor = this.data.editor;

		if (!site || !editor || !editor.site_url) {
			return;
		}

		const body = new URLSearchParams({site: site.name, lat: lat === null ? '' : lat.toFixed(5), lon: lon === null ? '' : lon.toFixed(5),
			lang: this.data.lang || 'es', _csrf_token: editor.site_csrf || ''
		});

		try {
			const response = await fetch(editor.site_url, {
				method: 'POST',
				headers: {'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'},
				body: body.toString()
			});
			const json = await response.json();

			if (json.success) {
				site.lat = json.coords ? json.coords.lat : null;
				site.lon = json.coords ? json.coords.lon : null;
				this.selected = i;
				this.render();
				this.toast(json.message);
			}
			else {
				this.render();
				this.toast((json.error && json.error.messages || []).join(' ') || this.t('No se pudo guardar la ubicación.'));
			}
		}
		catch (error) {
			this.render();
			this.toast(this.t('No se pudo guardar la ubicación.'));
		}
	}

	toast(text) {
		const el = this.el.querySelector('.laka3d-sites-toast');

		if (!el) {
			return;
		}

		el.textContent = text;
		el.hidden = false;
		clearTimeout(this.toastTimer);
		this.toastTimer = setTimeout(() => {
			el.hidden = true;
		}, 3000);
	}

	destroyMap() {
		if (this.map) {
			this.map.remove();
			this.map = null;
		}

		this.mask = null;
		this.outline = null;

		this.markers = new Map();
	}

	// ---------------------------------------------------------------- eventos

	click(e) {
		if (e.target === this.el || e.target.closest('[data-act="close"]')) {
			this.close();

			return;
		}

		const room = e.target.closest('[data-room]');

		if (room) {
			const name = room.dataset.room;

			this.close();

			if (this.cb.onRoom) {
				this.cb.onRoom(name);
			}

			return;
		}

		const view = e.target.closest('[data-view]');

		if (view) {
			this.view = view.dataset.view;
			LakaInfra3DSites.store('laka3d.sites.view', this.view);
			this.picking = null;
			this.render();

			return;
		}

		const act = e.target.closest('[data-act]');

		if (!act) {
			return;
		}

		switch (act.dataset.act) {
			case 'focus':
				this.focusSite(parseInt(act.dataset.site, 10));
				break;

			case 'pick':
				this.picking = parseInt(act.dataset.site, 10);
				this.selected = this.picking;
				this.render();
				break;

			case 'pick-cancel':
				this.picking = null;
				this.render();
				break;

			case 'edit-pos':
				this.editing = !this.editing;
				this.render();
				break;

			case 'map-setup':
				this.mapSetup = !this.mapSetup;
				this.render();
				break;

			case 'map-setup-cancel':
				this.mapSetup = false;
				this.render();
				break;

			case 'map-save':
				this.saveMapSetup();
				break;

			case 'coords-save': {
				const i = parseInt(act.dataset.site, 10);
				const input = this.el.querySelector(`[data-coords="${i}"]`);
				const raw = input ? input.value.trim() : '';

				if (raw === '') {
					// Vacío: se quita la ubicación guardada y vuelve la sugerida por el nombre.
					this.savePosition(i, null, null);
					break;
				}

				const c = LakaInfra3DSites.parseCoords(raw);

				if (!c) {
					this.toast(this.t('Coordenadas no válidas. Ej.: -16.4955, -68.1336 o 16°29\'44"S 68°08\'01"W.'));
					break;
				}

				this.savePosition(i, c.lat, c.lon);
				break;
			}

			case 'new':
				this.creating = true;
				this.render();
				break;

			case 'cancel':
				this.creating = false;
				this.render();
				break;

			case 'create':
				this.create();
				break;
		}
	}

	create() {
		const site = this.el.querySelector('[data-f="site"]').value.trim().slice(0, 64);
		const name = this.el.querySelector('[data-f="name"]').value.trim().slice(0, 64);
		const err = this.el.querySelector('.laka3d-site-err');
		const exists = (this.data.sites || []).some((s) => s.rooms.some((r) => r.name.toLowerCase() === name.toLowerCase()));

		if (name === '' || name === '_default') {
			err.textContent = this.t('Escribe el nombre de la sala.');
			err.hidden = false;

			return;
		}

		if (exists) {
			err.textContent = this.t('Ya existe una sala con ese nombre.');
			err.hidden = false;

			return;
		}

		this.close();

		if (this.cb.onCreate) {
			this.cb.onCreate(site, name);
		}
	}

	close() {
		this.destroyMap();
		clearTimeout(this.toastTimer);
		document.removeEventListener('keydown', this.onKeyDown);
		this.el.removeEventListener('click', this.onClick);
		this.el.remove();

		if (this.cb.onClose) {
			this.cb.onClose();
		}
	}
}
