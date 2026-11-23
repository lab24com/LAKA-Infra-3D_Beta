/*
 * LAKA Infra 3D – gemelo digital de data center para Zabbix 7.0 – 8.0
 * © LAKA Soluciones Tecnológicas
 * Autor: Willian Tola
 * Licencia GPLv3
 *
 * Cableado estructurado e instalación de equipos: datos y reglas comunes del editor y de la vista del equipo.
 *
 * Datos de la sala (module.config → cables → sala):
 * - fs: identificador del espacio (piso y sala) para las etiquetas ANSI/TIA-606, por ejemplo "1A".
 * - list: cables "extremoA|extremoB|tipo|etiqueta|color|largo_m".
 * - panels: configuración de cada patch panel "medio|categoría|conector|terminación|puertos|forma|función".
 * - devs: configuración de cada equipo "papel|flujo de aire".
 * - ports: estado de un puerto "estado|nota" (r reservado, d dañado).
 * - pw: cadena eléctrica "rama|fuente1,fuente2" de PDU, UPS, tableros y demás (rama A–D; fuentes aguas arriba).
 *   Con dos fuentes, el elemento sigue con energía mientras una de las dos tenga (ej. ATS: red y generador).
 * - rev: número de versión para no pisar cambios de otro usuario.
 *
 * Un extremo es "equipo#cara-tipo-número": equipo = id del host, "p:rack:U:cara" (pasivo), "v:rack:A" (PDU
 * vertical), "o:ID" (toma de área de trabajo o salida de zona, por ejemplo o:1A-W01-05) o "x:ID" (elemento de la
 * sala con red: cámara, control de acceso, sensor…; un solo puerto "F-rj45-1").
 */

class LakaInfra3DCabling {

	// Medios de transmisión reconocidos por ANSI/TIA-568 y sus categorías, conectores y terminaciones.
	static MEDIA = {
		cu: {name: 'Cobre UTP', cats: ['5e', '6', '6A', '8'], conns: ['RJ45'], rears: ['IDC', 'KEY'], fiber: false},
		stp: {name: 'Cobre blindado (F/UTP, S/FTP)', cats: ['6', '6A', '8'], conns: ['RJ45'], rears: ['IDC', 'KEY'], fiber: false},
		mm: {name: 'Fibra multimodo', cats: ['OM3', 'OM4', 'OM5'], conns: ['LC', 'SC', 'MPO12', 'MPO24'], rears: ['FUS', 'MPO', 'PRE'], fiber: true},
		sm: {name: 'Fibra monomodo', cats: ['OS2'], conns: ['LC', 'SC', 'MPO12'], rears: ['FUS', 'MPO', 'PRE'], fiber: true}
	};

	static CONN_NAMES = {RJ45: 'RJ45', LC: 'LC dúplex', SC: 'SC dúplex', MPO12: 'MPO-12', MPO24: 'MPO-24'};
	static REAR_NAMES = {IDC: 'Inserción (110 / Krone)', KEY: 'Keystone', FUS: 'Fusión con pigtail', MPO: 'Casete MPO',
		PRE: 'Preconectorizado'};

	// Función del panel en la topología de ANSI/TIA-942.
	static FUNCS = {
		bb: 'Troncal (backbone MDA ↔ HDA)',
		hz: 'Horizontal (HDA → EDA / tomas)',
		eq: 'Conexión cruzada de equipos',
		er: 'Acometida (cuarto de entrada)',
		zd: 'Zona (ZDA / punto de consolidación)'
	};

	static PORTS = [6, 8, 12, 16, 24, 32, 48, 72, 96];

	static STATUS = {'': 'Normal', r: 'Reservado', d: 'Dañado'};

	static ROLES = ['', 'core', 'access', 'switch', 'firewall', 'router', 'wifi', 'server', 'storage', 'ups', 'pdu', 'patch',
		'cable', 'blank', 'other'];

	static AIRFLOW = {fb: 'Frente → atrás', bf: 'Atrás → frente', side: 'Lateral'};

	// Elementos de la sala que llevan cable de red (IP / PoE) hasta un patch panel o un switch.
	static NET_KINDS = ['wap', 'cdu', 'solar', 'water', 'camera', 'access', 'motion', 'sensor', 'smoke', 'vesda', 'firepanel', 'suppression', 'leak', 'ups',
		'crac', 'inrow', 'panel', 'door'];

	/** Extremo de red de un elemento de la sala. */
	static objEp(id) {
		return `x:${id}#F-rj45-1`;
	}

	/**
	 * Recorrido de un extremo por el cableado (sin vista): sigue el cable y, al llegar a un patch panel, cruza al
	 * mismo puerto de la otra cara y sigue. Devuelve la lista de extremos en orden, empezando por el pedido.
	 */
	static path(store, ep) {
		const out = [ep];
		let cur = ep;

		for (let guard = 0; guard < 24; guard++) {
			const c = LakaInfra3DCabling.cableAt(store, cur);

			if (!c) {
				break;
			}

			const other = c.a === cur ? c.b : c.a;

			out.push(other);

			if (LakaInfra3DCabling.split(other).kind !== 'pp') {
				break;
			}

			cur = LakaInfra3DCabling.flip(other);
			out.push(cur);
		}

		return out;
	}

	// Largos máximos de ANSI/TIA-568 para cobre: enlace permanente 90 m, cordones 10 m, canal 100 m.
	static MAX_LINK = 90;
	static MAX_CORDS = 10;
	static MAX_CHANNEL = 100;

	// ------------------------------------------------------------ datos

	static empty() {
		return {fs: '', rev: 0, list: [], panels: {}, devs: {}, ports: {}, pw: {}};
	}

	/** Copia normalizada de los datos de cableado de la sala. */
	static clone(src) {
		const c = src || {};

		return {
			fs: c.fs || '',
			rev: c.rev || 0,
			list: Array.isArray(c.list) ? c.list.slice() : [],
			panels: Object.assign({}, c.panels && !Array.isArray(c.panels) ? c.panels : {}),
			devs: Object.assign({}, c.devs && !Array.isArray(c.devs) ? c.devs : {}),
			ports: Object.assign({}, c.ports && !Array.isArray(c.ports) ? c.ports : {}),
			pw: Object.assign({}, c.pw && !Array.isArray(c.pw) ? c.pw : {})
		};
	}

	static parseCable(s) {
		const [a, b, k, l, c, len] = String(s).split('|');

		return {a, b, k: k || 'net', l: l || '', c: c || '', len: len !== undefined && len !== '' ? parseFloat(len) : null};
	}

	static cableString(c) {
		const clean = (v) => String(v ?? '').replace(/[|\n\r]/g, ' ');

		return [c.a, c.b, c.k || 'net', clean(c.l).slice(0, 80), c.c || '', c.len !== null && c.len !== undefined && c.len !== '' ? Math.round(c.len * 10) / 10 : ''].join('|');
	}

	static cables(store) {
		return (store.list || []).map((s) => LakaInfra3DCabling.parseCable(s));
	}

	static cableAt(store, ep) {
		const s = (store.list || []).find((x) => {
			const [a, b] = x.split('|');

			return a === ep || b === ep;
		});

		return s ? LakaInfra3DCabling.parseCable(s) : null;
	}

	/** Conecta dos extremos (cada puerto lleva un solo cable: se quita el anterior de cada extremo). */
	static setCable(store, cable) {
		LakaInfra3DCabling.removeCable(store, cable.a);
		LakaInfra3DCabling.removeCable(store, cable.b);
		store.list.push(LakaInfra3DCabling.cableString(cable));
	}

	static removeCable(store, ep) {
		store.list = store.list.filter((x) => {
			const [a, b] = x.split('|');

			return a !== ep && b !== ep;
		});
	}

	static split(ep) {
		const [key, port] = String(ep).split('#');
		const [face, kind, n] = (port || '').split('-');

		return {key, port, face, kind, n: parseInt(n, 10)};
	}

	static flip(ep) {
		const p = LakaInfra3DCabling.split(ep);

		return `${p.key}#${p.face === 'F' ? 'R' : 'F'}-${p.kind}-${p.n}`;
	}

	/** Configuración de un patch panel (por defecto: cobre UTP Cat 6, RJ45, 24 puertos por U, horizontal). */
	static panel(store, key, n = 1) {
		const s = (store && store.panels && store.panels[key]) || '';
		const [media, cat, conn, rear, ports, style, func] = s.split('|');
		const m = LakaInfra3DCabling.MEDIA[media] ? media : 'cu';
		const def = LakaInfra3DCabling.MEDIA[m];

		return {
			saved: s !== '',
			media: m,
			cat: def.cats.includes(cat) ? cat : (m === 'cu' ? '6' : def.cats[0]),
			conn: def.conns.includes(conn) ? conn : def.conns[0],
			rear: def.rears.includes(rear) ? rear : def.rears[0],
			ports: LakaInfra3DCabling.PORTS.includes(parseInt(ports, 10)) ? parseInt(ports, 10) : Math.min(96, 24 * (n || 1)),
			style: style === 'angled' ? 'angled' : 'flat',
			func: LakaInfra3DCabling.FUNCS[func] ? func : 'hz'
		};
	}

	static panelString(p) {
		return [p.media, p.cat, p.conn, p.rear, p.ports, p.style, p.func].join('|');
	}

	static dev(store, key) {
		const [role, air] = (((store && store.devs) || {})[key] || '').split('|');

		return {role: role || '', air: LakaInfra3DCabling.AIRFLOW[air] ? air : 'fb'};
	}

	static portState(store, ep) {
		const s = ((store && store.ports) || {})[ep] || '';
		const i = s.indexOf('|');

		return i < 0 ? {st: s, note: ''} : {st: s.slice(0, i), note: s.slice(i + 1)};
	}

	/** Cambia la clave de un equipo en todo el cableado (un pasivo que se movió de U, de cara o de rack). */
	static rekey(store, from, to) {
		if (from === to) {
			return;
		}

		const swap = (ep) => (ep.split('#')[0] === from ? `${to}#${ep.split('#')[1]}` : ep);

		store.list = store.list.map((s) => {
			const c = LakaInfra3DCabling.parseCable(s);

			c.a = swap(c.a);
			c.b = swap(c.b);

			return LakaInfra3DCabling.cableString(c);
		});

		store.pw = store.pw || {};

		// Las fuentes de la cadena eléctrica también se nombran por clave.
		for (const k of Object.keys(store.pw)) {
			const [feed, ups = ''] = store.pw[k].split('|');

			store.pw[k] = `${feed}|${ups.split(',').filter(Boolean).map((u) => (u === from ? to : u)).join(',')}`;
		}

		for (const field of ['panels', 'devs', 'pw']) {
			if (store[field][from] !== undefined) {
				store[field][to] = store[field][from];
				delete store[field][from];
			}
		}

		for (const ep of Object.keys(store.ports)) {
			const next = swap(ep);

			if (next !== ep) {
				store.ports[next] = store.ports[ep];
				delete store.ports[ep];
			}
		}
	}

	/** Quita todo lo de un equipo (al eliminar un pasivo o quitar un equipo del rack). */
	static drop(store, key) {
		store.list = store.list.filter((s) => {
			const [a, b] = s.split('|');

			return a.split('#')[0] !== key && b.split('#')[0] !== key;
		});
		delete store.panels[key];
		delete store.devs[key];

		if (store.pw) {
			delete store.pw[key];

			for (const k of Object.keys(store.pw)) {
				const [feed, ups = ''] = store.pw[k].split('|');

				store.pw[k] = `${feed}|${ups.split(',').filter((u) => u && u !== key).join(',')}`;
			}
		}

		for (const ep of Object.keys(store.ports)) {
			if (ep.split('#')[0] === key) {
				delete store.ports[ep];
			}
		}
	}

	/** Clave de un pasivo: rack, U y cara (dos pasivos no comparten U en la misma cara). */
	static passiveKey(p) {
		return `p:${String(p.rack).slice(0, 32).toLowerCase()}:${parseInt(p.u, 10)}:${p.face === 'back' ? 'back' : 'front'}`;
	}

	/** Identificador TIA-606 de un rack: FS.XY (piso y sala . rack). */
	static rackId(store, rack) {
		const fs = ((store && store.fs) || '1A').toUpperCase();

		return `${fs}.${String(rack).toUpperCase().replace(/[^0-9A-Z]/g, '')}`;
	}

	static pad(n) {
		return String(n).padStart(2, '0');
	}

	/** Aplica a la vista los papeles elegidos en el editor (sobre lo que se deduce del nombre y del modelo). */
	static applyRoles(store) {
		const map = new Map();

		for (const [key, v] of Object.entries((store && store.devs) || {})) {
			const role = String(v).split('|')[0];

			if (role) {
				map.set(key, role);
			}
		}

		if (typeof LakaInfra3DRackView === 'function') {
			LakaInfra3DRackView.overrides = map;
		}
	}
}
