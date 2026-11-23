<?php declare(strict_types = 0);
/*
 * LAKA Infra 3D – gemelo digital de data center para Zabbix 7.0 – 8.0
 * © LAKA Soluciones Tecnológicas
 * Autor: Willian Tola
 * Licencia GPLv3
 *
 * Detalle de un equipo para la vista del equipo: se pide al abrirla, no en cada actualización del widget.
 * Lee los ítems de las plantillas oficiales de Zabbix:
 * - Interfaces: net.if.status/speed/in/out (Interfaces by SNMP, Windows by Zabbix agent) y
 *   vfs.file.contents["/sys/class/net/<if>/operstate"] (Linux by Zabbix agent).
 * - Fuentes de poder y ventiladores: ítems de estado de las plantillas de red y de servidores (SNMP, iDRAC, iLO…).
 * - Salud: system.cpu.util, vm.memory.util, vfs.fs.dependent.size[*,pused], service.info[*,state], uptime.
 * El estado se toma del mapeo de valores del ítem, como lo muestra Zabbix. Respeta los permisos del usuario.
 */

namespace Modules\LakaInfra3D\Actions;

use API,
	CController,
	CControllerResponseData;

class DeviceDetail extends CController {

	private const MAX_ITEMS = 5000;

	protected function init(): void {
		// Solo lectura.
		$this->disableCsrfValidation();
	}

	protected function checkInput(): bool {
		$ret = $this->validateInput([
			'hostid' => 'required|id'
		]);

		if (!$ret) {
			$this->respond(['error' => true]);
		}

		return $ret;
	}

	protected function checkPermissions(): bool {
		return $this->getUserType() >= USER_TYPE_ZABBIX_USER;
	}

	protected function doAction(): void {
		$hostid = $this->getInput('hostid');

		$hosts = API::Host()->get([
			'output' => ['hostid', 'name'],
			'selectInventory' => ['vendor', 'model', 'serialno_a', 'serialno_b', 'os', 'os_full', 'hardware',
				'hardware_full', 'asset_tag', 'location', 'chassis', 'macaddress_a', 'software', 'tag'
			],
			'hostids' => [$hostid]
		]);

		if (!$hosts) {
			$this->respond(['error' => true]);

			return;
		}

		$items = API::Item()->get([
			'output' => ['itemid', 'key_', 'name', 'lastvalue', 'lastclock', 'units', 'value_type'],
			'selectValueMap' => ['mappings'],
			'hostids' => [$hostid],
			'monitored' => true,
			'webitems' => false,
			'search' => [
				'key_' => ['net.if.', '/sys/class/net/', 'psu', 'fan', 'vfs.fs.dependent.size', 'vfs.fs.size',
					'service.info', 'uptime', 'system.cpu.util', 'system.cpu.num', 'vm.memory.util',
					'vm.memory.size[total]'
				],
				'name' => ['Power supply', 'Fan', 'Number of cores', 'Number of CPUs', 'disk', 'Disk']
			],
			'searchByAny' => true,
			'limit' => self::MAX_ITEMS
		]);

		$ifaces = [];
		$psus = [];
		$fans = [];
		$fs = [];
		$disks = [];
		$services = ['total' => 0, 'down' => []];
		$out = ['uptime' => null, 'cpu' => null, 'mem' => null, 'cores' => null, 'memtotal' => null];

		foreach ($items as $item) {
			$key = $item['key_'];
			$name = $item['name'];
			$has = (int) $item['lastclock'] > 0;
			$value = $item['lastvalue'];
			$label = $has ? self::label($item) : '';

			// ---- interfaces de red
			$iface = self::ifacePart($key);

			if ($iface !== null) {
				[$part, $id] = $iface;

				if (!array_key_exists($id, $ifaces)) {
					$ifaces[$id] = ['id' => $id, 'name' => '', 'alias' => '', 'status' => 'nodata', 'label' => '',
						'speed' => null, 'in' => null, 'out' => null, 'clock' => 0
					];
				}

				// "Interface Gi1/0/1(uplink): Operational status" → nombre y alias (el alias es el último paréntesis:
				// "Intel(R) Ethernet I350(LAN)" → "Intel(R) Ethernet I350" y "LAN").
				if ($ifaces[$id]['name'] === '' && preg_match('/^Interface (.+?): /u', $name, $mn)) {
					$full = $mn[1];

					if (preg_match('/^(.*)\(([^()]*)\)$/u', $full, $ma)) {
						$ifaces[$id]['name'] = $ma[1];
						$ifaces[$id]['alias'] = $ma[2];
					}
					else {
						$ifaces[$id]['name'] = $full;
					}
				}

				if (!$has) {
					continue;
				}

				switch ($part) {
					case 'status':
						$ifaces[$id]['status'] = self::state($label, (string) $value, $key);
						$ifaces[$id]['label'] = $label;
						$ifaces[$id]['clock'] = (int) $item['lastclock'];
						break;

					case 'speed':
						// ifHighSpeed viene en Mbps según la plantilla, pero el ítem ya guarda bps (preprocesamiento).
						$ifaces[$id]['speed'] = is_numeric($value) ? (float) $value : null;
						break;

					case 'in':
					case 'out':
						$ifaces[$id][$part] = is_numeric($value) ? (float) $value : null;
						break;
				}

				continue;
			}

			$lname = mb_strtolower($name);
			$lkey = strtolower($key);
			$is_state = (bool) preg_match('/status|state|estado/', $lname);

			// ---- fuentes de poder
			if ($is_state && (preg_match('/psu|powersupply|power\.supply/', $lkey) || preg_match('/power supply|psu/', $lname))) {
				$psus[] = ['name' => $name, 'status' => $has ? self::state($label, (string) $value, $key) : 'nodata',
					'label' => $label
				];

				continue;
			}

			// ---- ventiladores
			if ($is_state && (preg_match('/fan/', $lkey) || preg_match('/\bfan/', $lname))) {
				$fans[] = ['name' => $name, 'status' => $has ? self::state($label, (string) $value, $key) : 'nodata',
					'label' => $label
				];

				continue;
			}

			// ---- sistemas de archivos (% usado)
			if (preg_match('/^vfs\.fs\.(dependent\.)?size\[(.*),pused\]$/', $key, $m)) {
				if ($has && is_numeric($value)) {
					$fs[] = ['name' => trim($m[2], '"'), 'pused' => round((float) $value, 1)];
				}

				continue;
			}

			// ---- discos físicos (controladoras RAID por SNMP, iDRAC, iLO…)
			if ($is_state && preg_match('/(physical )?disk|drive/', $lname) && !str_starts_with($key, 'vfs.')) {
				$disks[] = ['name' => $name, 'status' => $has ? self::state($label, (string) $value, $key) : 'nodata',
					'label' => $label
				];

				continue;
			}

			// ---- servicios de Windows (descubiertos: los de inicio automático)
			if (preg_match('/^service\.info\[(.*),state\]$/', $key)) {
				$services['total']++;

				if ($has && (string) $value !== '0') {
					$display = preg_match('/"(.+?)"(?: \((.*)\))?/u', $name, $ms) ? ($ms[2] ?? $ms[1]) : $name;
					$services['down'][] = ['name' => $display !== '' ? $display : $name, 'label' => $label];
				}

				continue;
			}

			if (!$has || !is_numeric($value)) {
				continue;
			}

			if ($key === 'system.uptime' || str_starts_with($key, 'system.net.uptime[')
					|| str_starts_with($key, 'system.hw.uptime[')) {
				$out['uptime'] = max((int) $value, (int) ($out['uptime'] ?? 0));
			}
			elseif (str_starts_with($key, 'system.cpu.util')) {
				$out['cpu'] = max(round((float) $value, 1), (float) ($out['cpu'] ?? 0));
			}
			elseif (str_starts_with($key, 'vm.memory.util')) {
				$out['mem'] = round((float) $value, 1);
			}
			elseif (str_starts_with($key, 'system.cpu.num') || $name === 'Number of cores' || $name === 'Number of CPUs') {
				$out['cores'] = (int) $value;
			}
			elseif ($key === 'vm.memory.size[total]') {
				$out['memtotal'] = (float) $value;
			}
		}

		// Interfaces sin nombre (por ejemplo, plantillas propias): se usa el id.
		foreach ($ifaces as &$iface) {
			if ($iface['name'] === '') {
				$iface['name'] = preg_replace('/^snmp:/', '#', $iface['id']);
			}
		}
		unset($iface);

		usort($fs, static fn(array $a, array $b): int => strnatcasecmp($a['name'], $b['name']));

		$inv = is_array($hosts[0]['inventory']) ? $hosts[0]['inventory'] : [];

		$this->respond($out + [
			'hostid' => $hostid,
			'ifaces' => array_values($ifaces),
			'psus' => $psus,
			'fans' => $fans,
			'fs' => $fs,
			'disks' => $disks,
			'services' => ['total' => $services['total'], 'down' => array_slice($services['down'], 0, 50)],
			'inv' => array_map('strval', $inv)
		]);
	}

	/**
	 * Parte de una interfaz que mide el ítem (status, speed, in, out) y un id común a todos sus ítems:
	 * el índice SNMP (ifOperStatus.12 → snmp:12), el GUID de Windows o el nombre de la interfaz en Linux.
	 */
	private static function ifacePart(string $key): ?array {
		if (preg_match('#^vfs\.file\.contents\["?/sys/class/net/([^/]+)/(operstate|speed)"?\]$#', $key, $m)) {
			return [$m[2] === 'operstate' ? 'status' : 'speed', $m[1]];
		}

		if (preg_match('/^net\.if\.(status|speed|in|out)\[(.*)\]$/', $key, $m)) {
			$param = trim(explode(',', $m[2])[0], '"');

			return [$m[1], preg_match('/^if\w+\.(\d+)$/', $param, $mm) ? 'snmp:'.$mm[1] : $param];
		}

		return null;
	}

	/**
	 * Texto del valor según el mapeo de valores del ítem (coincidencia exacta), como en "Últimos datos".
	 */
	private static function label(array $item): string {
		$value = (string) $item['lastvalue'];
		$mappings = is_array($item['valuemap']['mappings'] ?? null) ? $item['valuemap']['mappings'] : [];

		foreach ($mappings as $mapping) {
			if ((int) ($mapping['type'] ?? 0) === 0 && (string) $mapping['value'] === $value) {
				return (string) $mapping['newvalue'];
			}
		}

		return $value;
	}

	/**
	 * Estado normalizado: ok, bad o unk. Primero por el texto del mapeo de valores; si el ítem no tiene
	 * mapeo, por los códigos conocidos de IF-MIB::ifOperStatus (1 up, 2 down) y de Windows (2 conectado).
	 */
	private static function state(string $label, string $raw, string $key): string {
		$l = mb_strtolower($label);

		if ($l !== $raw || !is_numeric($raw)) {
			if (preg_match('/down|disconnect|not ?present|notfunction|not functioning|fail|critical|shutdown|stopped|absent|fault|degraded|offline|malfunction|lowerlayer|nonrecoverable|error|warning/', $l)) {
				return 'bad';
			}

			if (preg_match('/\b(up|connected|running|ok|normal|online|good|present|enabled|operational|on)\b/', $l)) {
				return 'ok';
			}

			return 'unk';
		}

		if (str_starts_with($key, 'net.if.status[ifOperStatus') || str_contains($key, 'operstate')) {
			return $raw === '1' ? 'ok' : ($raw === '2' || $raw === '7' ? 'bad' : 'unk');
		}

		if (str_starts_with($key, 'net.if.status[')) {
			return $raw === '2' ? 'ok' : (in_array($raw, ['0', '4', '5', '6', '7'], true) ? 'bad' : 'unk');
		}

		return 'unk';
	}

	private function respond(array $output): void {
		$this->setResponse(new CControllerResponseData(['main_block' => json_encode($output, JSON_UNESCAPED_UNICODE)]));
	}
}
