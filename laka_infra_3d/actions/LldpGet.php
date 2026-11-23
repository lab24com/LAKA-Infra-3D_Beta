<?php declare(strict_types = 0);
/*
 * LAKA Infra 3D – gemelo digital de data center para Zabbix 7.0 – 8.0
 * © LAKA Soluciones Tecnológicas
 * Autor: Willian Tola
 * Licencia GPLv3
 *
 * Vecinos LLDP y CDP de los equipos de la sala, para validar el cableado documentado.
 * Lee el último valor de los ítems laka.lldp.walk y laka.cdp.walk de la plantilla "LAKA LLDP CDP by SNMP"
 * (SNMP walk[] de LLDP-MIB y CISCO-CDP-MIB, salida de snmpwalk -On) e identifica cada vecino con un host
 * de la sala por su nombre. Solo lectura y con los permisos del usuario.
 */

namespace Modules\LakaInfra3D\Actions;

use API,
	CController,
	CControllerResponseData;

class LldpGet extends CController {

	public const KEY_LLDP = 'laka.lldp.walk';
	public const KEY_CDP = 'laka.cdp.walk';

	// LLDP-MIB (IEEE 802.1AB): puertos locales y tabla de vecinos remotos.
	private const LLDP_LOC_PORT = '1.0.8802.1.1.2.1.3.7.1.';
	private const LLDP_REM = '1.0.8802.1.1.2.1.4.1.1.';
	// CISCO-CDP-MIB: cdpCacheDeviceId (6) y cdpCacheDevicePort (7); IF-MIB ifName.
	private const CDP_CACHE = '1.3.6.1.4.1.9.9.23.1.2.1.1.';
	private const IF_NAME = '1.3.6.1.2.1.31.1.1.1.1.';

	private const MAX_HOSTS = 500;

	protected function init(): void {
		$this->disableCsrfValidation();
	}

	protected function checkInput(): bool {
		$ret = $this->validateInput(['hostids' => 'required|array_id']);

		if (!$ret) {
			$this->respond(['success' => false]);
		}

		return $ret;
	}

	protected function checkPermissions(): bool {
		return $this->getUserType() >= USER_TYPE_ZABBIX_USER;
	}

	protected function doAction(): void {
		$hostids = array_slice(array_values(array_unique($this->getInput('hostids'))), 0, self::MAX_HOSTS);

		$hosts = API::Host()->get([
			'output' => ['hostid', 'host', 'name'],
			'hostids' => $hostids,
			'preservekeys' => true
		]);

		$items = $hosts ? API::Item()->get([
			'output' => ['itemid', 'hostid', 'key_', 'lastvalue', 'lastclock', 'state', 'error'],
			'hostids' => array_keys($hosts),
			'filter' => ['key_' => [self::KEY_LLDP, self::KEY_CDP]],
			'webitems' => false
		]) : [];

		// Nombres de los hosts de la sala, sin dominio y en minúsculas, para reconocer a los vecinos.
		$by_name = [];

		foreach ($hosts as $hostid => $host) {
			foreach ([$host['host'], $host['name']] as $n) {
				$by_name[self::norm($n)] = (string) $hostid;
			}
		}

		$out = [];

		foreach ($items as $item) {
			$hostid = (string) $item['hostid'];
			$out += [$hostid => ['lldp' => null, 'cdp' => null, 'neighbors' => []]];
			$lldp = $item['key_'] === self::KEY_LLDP;
			$out[$hostid][$lldp ? 'lldp' : 'cdp'] = [
				'clock' => (int) $item['lastclock'],
				'error' => (int) $item['state'] === ITEM_STATE_NOTSUPPORTED ? (string) $item['error'] : ''
			];

			if ($item['lastvalue'] === '' || (int) $item['state'] === ITEM_STATE_NOTSUPPORTED) {
				continue;
			}

			$walk = self::parseWalk($item['lastvalue']);
			$list = $lldp ? self::lldpNeighbors($walk) : self::cdpNeighbors($walk);

			foreach ($list as $n) {
				$n['proto'] = $lldp ? 'lldp' : 'cdp';
				$n['hostid'] = $by_name[self::norm($n['remote'])] ?? null;
				$out[$hostid]['neighbors'][] = $n;
			}
		}

		$this->respond(['success' => true, 'hosts' => $out, 'checked' => count($hosts), 'clock' => time()]);
	}

	/** "SW-ACC01.empresa.local" → "sw-acc01". */
	public static function norm(string $name): string {
		// CDP suele agregar el número de serie entre paréntesis: "SW-ACC01(FOC1234X)".
		$name = mb_strtolower(trim(preg_replace('/\([^()]*\)$/', '', trim($name))));

		// Un nombre con puntos que no es una IP se toma hasta el primer punto (sin dominio).
		if (!filter_var($name, FILTER_VALIDATE_IP) && strpos($name, '.') !== false) {
			$name = substr($name, 0, strpos($name, '.'));
		}

		return $name;
	}

	/**
	 * Salida de snmpwalk -On -Ot -Oe ("OID = TIPO: valor", una línea por variable) → [OID => valor].
	 * Hex-STRING se convierte en texto si es imprimible, si no queda como bytes "aa:bb:cc".
	 */
	public static function parseWalk(string $text): array {
		$out = [];
		$last = null;

		foreach (preg_split('/\r?\n/', $text) as $line) {
			if (preg_match('/^\.?((?:\d+\.)+\d+)\s*=\s*(?:([A-Za-z0-9\-]+):\s?)?(.*)$/', $line, $m)) {
				$type = strtoupper($m[2]);
				$value = trim($m[3]);

				if ($type === 'HEX-STRING') {
					$bytes = array_map('hexdec', preg_split('/\s+/', $value, -1, PREG_SPLIT_NO_EMPTY));
					$printable = $bytes && !array_filter($bytes, fn($b) => $b < 32 || $b > 126);
					$value = $printable
						? implode('', array_map('chr', $bytes))
						: implode(':', array_map(fn($b) => sprintf('%02x', $b), $bytes));
				}
				elseif (strlen($value) >= 2 && $value[0] === '"' && substr($value, -1) === '"') {
					$value = stripcslashes(substr($value, 1, -1));
				}

				$out[$m[1]] = $value;
				$last = $m[1];
			}
			elseif ($last !== null && trim($line) !== '') {
				// Textos de varias líneas (descripciones largas).
				$out[$last] .= ' '.trim($line, " \"");
			}
		}

		return $out;
	}

	/** Vecinos LLDP: índice timeMark.puertoLocal.índiceRemoto. */
	public static function lldpNeighbors(array $walk): array {
		$loc = [];
		$rem = [];

		foreach ($walk as $oid => $value) {
			if (strpos($oid, self::LLDP_LOC_PORT) === 0) {
				[$col, $port] = explode('.', substr($oid, strlen(self::LLDP_LOC_PORT)), 2) + [1 => ''];
				$loc[$port][$col === '3' ? 'id' : 'desc'] = $value;
			}
			elseif (strpos($oid, self::LLDP_REM) === 0) {
				$parts = explode('.', substr($oid, strlen(self::LLDP_REM)));

				if (count($parts) >= 4) {
					$rem[$parts[2].'.'.$parts[3]][$parts[0]] = $value;
					$rem[$parts[2].'.'.$parts[3]]['port'] = $parts[2];
				}
			}
		}

		$out = [];

		foreach ($rem as $r) {
			$port = $r['port'];
			$id = $loc[$port]['id'] ?? '';
			$desc = $loc[$port]['desc'] ?? '';
			// El id del puerto local suele ser el nombre (Gi1/0/5); si es una MAC se usa la descripción.
			$local = $id !== '' && !preg_match('/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i', $id) ? $id : ($desc !== '' ? $desc : 'port '.$port);
			$rport = $r['7'] ?? '';

			$out[] = [
				'local' => $local,
				'local_desc' => $desc,
				'local_num' => (int) $port,
				'remote' => ($r['9'] ?? '') !== '' ? $r['9'] : ($r['5'] ?? ''),
				'remote_port' => $rport !== '' && !preg_match('/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i', $rport) ? $rport : ($r['8'] ?? $rport),
				'remote_desc' => $r['8'] ?? '',
				'chassis' => $r['5'] ?? ''
			];
		}

		return $out;
	}

	/** Vecinos CDP: índice ifIndex.índiceDispositivo; el puerto local se nombra con ifName. */
	public static function cdpNeighbors(array $walk): array {
		$ifname = [];
		$rem = [];

		foreach ($walk as $oid => $value) {
			if (strpos($oid, self::IF_NAME) === 0) {
				$ifname[substr($oid, strlen(self::IF_NAME))] = $value;
			}
			elseif (strpos($oid, self::CDP_CACHE) === 0) {
				$parts = explode('.', substr($oid, strlen(self::CDP_CACHE)));

				if (count($parts) >= 3) {
					$rem[$parts[1].'.'.$parts[2]][$parts[0]] = $value;
					$rem[$parts[1].'.'.$parts[2]]['if'] = $parts[1];
				}
			}
		}

		$out = [];

		foreach ($rem as $r) {
			$out[] = [
				'local' => $ifname[$r['if']] ?? 'ifIndex '.$r['if'],
				'local_desc' => '',
				'local_num' => (int) $r['if'],
				'remote' => $r['6'] ?? '',
				'remote_port' => $r['7'] ?? '',
				'remote_desc' => '',
				'chassis' => ''
			];
		}

		return $out;
	}

	private function respond(array $data): void {
		$this->setResponse(new CControllerResponseData(['main_block' => json_encode($data)]));
	}
}
