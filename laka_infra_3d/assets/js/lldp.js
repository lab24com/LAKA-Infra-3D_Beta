/*
 * LAKA Infra 3D – gemelo digital de data center para Zabbix 7.0 – 8.0
 * © LAKA Soluciones Tecnológicas
 * Autor: Willian Tola
 * Licencia GPLv3
 *
 * Validación del cableado con LLDP (IEEE 802.1AB) y CDP: compara las conexiones documentadas entre equipos
 * activos (pasando por los patch panels) con los vecinos que ven los propios equipos, leídos por la plantilla
 * "LAKA LLDP CDP by SNMP". Resultado:
 * - Confirmada: documentada y vista (con aviso si el número de puerto no coincide).
 * - No vista: documentada entre equipos que reportan vecinos, pero ninguno de los dos ve al otro.
 * - Sin documentar: los equipos se ven entre sí y no hay cable documentado entre ellos.
 * - Fuera de la sala: vecinos que no son hosts de la sala.
 */

class LakaInfra3DLldp {

	/** Número de puerto al final del nombre: "Gi1/0/5" → 5, "ethernet1/12" → 12, "port1" → 1. */
	static portNum(name) {
		const m = /(\d+)\s*$/.exec(String(name || ''));

		return m ? parseInt(m[1], 10) : null;
	}

	/**
	 * Conexiones documentadas entre equipos activos: cada extremo de datos de un host se sigue por el cableado
	 * (cruzando patch panels) hasta su otro extremo. Devuelve [{a, ap, akind, b, bp, bkind}] sin repetir.
	 */
	static documented(store, isHost) {
		const out = new Map();

		for (const line of (store && store.list) || []) {
			const c = LakaInfra3DCabling.parseCable(line);

			if (!c || c.k === 'power') {
				continue;
			}

			for (const ep of [c.a, c.b]) {
				const p = LakaInfra3DCabling.split(ep);

				if (!isHost(p.key) || p.kind === 'pp' || p.kind === 'psu' || p.kind === 'outlet') {
					continue;
				}

				const path = LakaInfra3DCabling.path(store, ep);
				const end = LakaInfra3DCabling.split(path[path.length - 1]);

				if (path.length < 2 || !isHost(end.key) || end.key === p.key || end.kind === 'pp') {
					continue;
				}

				const [x, y] = p.key < end.key ? [p, end] : [end, p];
				const id = `${x.key}#${x.kind}${x.n}|${y.key}#${y.kind}${y.n}`;

				if (!out.has(id)) {
					out.set(id, {a: x.key, ap: x.n, akind: x.kind, b: y.key, bp: y.n, bkind: y.kind, via: path.length > 2});
				}
			}
		}

		return [...out.values()];
	}

	/**
	 * Compara lo documentado con lo visto.
	 * @param {Object} store    Cableado de la sala.
	 * @param {Object} hosts    Respuesta de lldp.get: {hostid: {lldp, cdp, neighbors[]}}.
	 * @param {Set}    roomIds  Hosts de la sala.
	 */
	static compare(store, hosts, roomIds) {
		const isHost = (k) => roomIds.has(String(k));
		const docs = LakaInfra3DLldp.documented(store, isHost);
		const reports = (h) => {
			const x = hosts[h];

			return !!x && ((x.lldp && x.lldp.clock && !x.lldp.error) || (x.cdp && x.cdp.clock && !x.cdp.error));
		};
		// Vecinos vistos entre hosts de la sala, por par de hosts.
		const seen = new Map();
		const outside = [];

		for (const [hostid, x] of Object.entries(hosts)) {
			for (const n of x.neighbors || []) {
				if (n.hostid && n.hostid !== hostid && roomIds.has(n.hostid)) {
					const pair = hostid < n.hostid ? `${hostid}|${n.hostid}` : `${n.hostid}|${hostid}`;

					if (!seen.has(pair)) {
						seen.set(pair, []);
					}

					seen.get(pair).push(Object.assign({from: hostid}, n));
				}
				else if (!n.hostid) {
					outside.push(Object.assign({from: hostid}, n));
				}
			}
		}

		const confirmed = [];
		const missing = [];
		const unchecked = [];
		const usedPairs = new Set();

		for (const d of docs) {
			const pair = `${d.a}|${d.b}`;
			const views = seen.get(pair) || [];

			if (views.length) {
				usedPairs.add(pair);

				// Número de puerto: lo que ve cada lado de sí mismo (local) y del otro (remoto).
				const checks = [];

				for (const v of views) {
					const mine = v.from === d.a ? d.ap : d.bp;
					const other = v.from === d.a ? d.bp : d.ap;
					const ln = LakaInfra3DLldp.portNum(v.local);
					const rn = LakaInfra3DLldp.portNum(v.remote_port);

					checks.push((ln === null || ln === mine) && (rn === null || rn === other));
				}

				confirmed.push(Object.assign({views, portOk: checks.some(Boolean)}, d));
			}
			else if (reports(d.a) || reports(d.b)) {
				missing.push(d);
			}
			else {
				unchecked.push(d);
			}
		}

		const undocumented = [];

		for (const [pair, views] of seen) {
			if (!usedPairs.has(pair)) {
				const [a, b] = pair.split('|');

				undocumented.push({a, b, views});
			}
		}

		return {confirmed, missing, undocumented, outside, unchecked,
			reporting: Object.keys(hosts).filter(reports).length, documented: docs.length};
	}
}
