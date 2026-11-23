<?php declare(strict_types = 0);
/*
 * LAKA Infra 3D – gemelo digital de data center para Zabbix 7.0 – 8.0
 * © LAKA Soluciones Tecnológicas
 * Autor: Willian Tola
 * Licencia GPLv3
 *
 * Distribución de la sala guardada por el editor: racks, filas, ubicación de hosts y equipos pasivos.
 * Se guarda en la configuración del módulo (tabla module.config de Zabbix), una por sala.
 */

namespace Modules\LakaInfra3D\Includes;

class Layout {

	public const MODULE_ID = 'laka_infra_3d';
	public const DEFAULT_ROOM = '_default';

	// Tipos de equipo que entiende la vista 3D.
	public const TYPES = ['server', 'network', 'storage', 'ups', 'pdu', 'patch', 'other'];

	// Infraestructura de la sala: aire de precisión, aire en fila, split de pared, UPS de sala,
	// tablero eléctrico, sensor ambiental y puerta.
	public const KINDS = ['crac', 'inrow', 'split', 'ups', 'battery', 'panel', 'sensor', 'door',
		// Seguridad física, protección contra incendio, ambiente y puesta a tierra (ANSI/TIA-942, NFPA 75/76,
		// ANSI/TIA-607): control de acceso, cámara, sensor de movimiento, detector de humo o temperatura,
		// detección por aspiración (VESDA), central de alarma, supresión, extintor, pulsador de apagado de
		// emergencia (EPO), luz de emergencia, sensor de fugas de agua y barra de tierra (TGB).
		'access', 'camera', 'motion', 'smoke', 'vesda', 'firepanel', 'suppression', 'extinguisher', 'epo', 'light',
		'leak', 'ground',
		// Cadena eléctrica (TIA-942, sistemas eléctricos): grupo electrógeno, transferencia automática (ATS)
		// y transformador o acometida de la red.
		'generator', 'ats', 'transformer',
		// Enfriamiento líquido (ASHRAE TC 9.9): unidad de distribución de refrigerante (CDU) e intercambiador de
		// puerta trasera; punto de acceso inalámbrico (TIA-942-C); medidor de agua (WUE) y generación renovable (REF).
		'cdu', 'rdhx', 'wap', 'water', 'solar'
	];

	// Elementos con variante (tipo de cámara, de lector, de detector, de agente o de extintor), guardada en "batt".
	public const VARIANTS = ['camera' => 3, 'access' => 5, 'smoke' => 3, 'suppression' => 5, 'extinguisher' => 2];

	// Lugares de una fila: gabinete (rack), aire (en fila o perimetral de fin de pasillo), UPS modular y
	// Rack de pared: hasta 27U y fondos comerciales de 350, 450 y 600 mm.
	public const WALL_RACK_MAX_U = 27;
	public const WALL_RACK_DEPTHS = [0.35, 0.45, 0.6];

	// gabinete de baterías. Solo los racks llevan equipos.
	public const SLOT_KINDS = ['rack', 'cooler', 'ups', 'battery'];
	public const COOLER_MODELS = ['inrow', 'crac'];

	// Tomas habituales de las PDU verticales (0U).
	public const OUTLETS = [8, 12, 16, 20, 24, 30, 36, 42, 48];
	public const LEVELS = ['top', 'mid', 'bottom'];
	public const MAX_OBJECTS = 1000;

	// Códigos cortos para guardar la distribución en poco espacio.
	private const TYPE_CODES = ['server' => 's', 'network' => 'n', 'storage' => 't', 'ups' => 'u', 'pdu' => 'p',
		'patch' => 'c', 'other' => 'o'];

	// Límites de lo que se guarda (el tamaño final lo controla Config según la base: MySQL / MariaDB o PostgreSQL).
	public const MAX_RACKS = 2000;
	public const MAX_ROWS = 100;
	public const MAX_PLACEMENTS = 50000;
	public const MAX_PASSIVES = 2000;

	/**
	 * Clave con la que se guarda la sala (el valor del campo "Sala" del widget).
	 */
	public static function roomKey(string $room): string {
		$room = trim($room);

		return $room === '' ? self::DEFAULT_ROOM : mb_substr($room, 0, 64);
	}

	/**
	 * Limpia y valida una distribución recibida del editor o leída de la configuración.
	 * Descarta lo que no tenga el formato esperado en lugar de fallar.
	 */
	public static function normalize($input): array {
		$input = is_array($input) ? $input : [];

		$layout = [
			'v' => 1,
			'rev' => max(0, (int) ($input['rev'] ?? 0)),
			'updated' => max(0, (int) ($input['updated'] ?? 0)),
			'user' => mb_substr((string) ($input['user'] ?? ''), 0, 100),
			'layout' => null,
			'rows' => [],
			'racks' => [],
			'placements' => [],
			'passives' => [],
			'objects' => [],
			'room' => ['w' => 0, 'd' => 0],
			// Sitio o región del data center (La Paz, Cochabamba, Santa Cruz…).
			'site' => self::text($input['site'] ?? '', 64),
			// Pasillo central entre filas enfrentadas: "cold" (frentes enfrentados) o "hot" (espaldas
			// enfrentadas); null = el del widget. Contención: none, cold o hot. Filas invertidas a mano.
			'aisle' => in_array($input['aisle'] ?? null, ['cold', 'hot'], true) ? $input['aisle'] : null,
			'contain' => in_array($input['contain'] ?? '', ['cold', 'hot'], true) ? $input['contain'] : 'none',
			'flips' => array_slice(array_values(array_unique(array_filter(array_map(
				static fn($v) => self::text($v, 16), is_array($input['flips'] ?? null) ? $input['flips'] : []
			), 'strlen'))), 0, self::MAX_ROWS),
			'energy' => self::energy(is_array($input['energy'] ?? null) ? $input['energy'] : [])
		];

		$room = is_array($input['room'] ?? null) ? $input['room'] : [];

		foreach (['w', 'd'] as $dim) {
			$value = is_numeric($room[$dim] ?? null) ? round((float) $room[$dim], 1) : 0;
			$layout['room'][$dim] = $value >= 2 ? min(300, $value) : 0;
		}

		$ids = [];

		foreach (array_slice(is_array($input['objects'] ?? null) ? $input['objects'] : [], 0, self::MAX_OBJECTS)
				as $object) {
			if (is_string($object)) {
				$p = explode('|', $object);
				$object = ['id' => $p[0], 'kind' => $p[1] ?? '', 'name' => $p[2] ?? '', 'x' => $p[3] ?? 0, 'z' => $p[4] ?? 0,
					'rot' => $p[5] ?? 0, 'rack' => $p[6] ?? '', 'level' => $p[7] ?? 'top',
					'face' => ($p[8] ?? 'f') === 'b' ? 'back' : 'front', 'hostid' => $p[9] ?? '', 'key' => $p[10] ?? '',
					'mount' => $p[11] ?? '', 'wall' => $p[12] ?? '', 'offset' => $p[13] ?? 0, 'height' => $p[14] ?? 0,
					'hinge' => $p[15] ?? 'l', 'leaves' => $p[16] ?? 1, 'size' => $p[17] ?? 1, 'batt' => $p[18] ?? 0
				];
			}

			$object = is_array($object) ? self::object($object) : null;

			if ($object === null) {
				continue;
			}

			// Identificador único dentro de la sala.
			while ($object['id'] === '' || array_key_exists($object['id'], $ids)) {
				// Determinístico: el mismo objeto conserva su identificador entre refrescos.
				$object['id'] = 'o'.(count($ids) + 1).substr(md5(json_encode($object)), 0, 4);
			}

			$ids[$object['id']] = true;
			$layout['objects'][] = $object;
		}

		if (isset($input['layout']) && in_array((int) $input['layout'], [0, 1, 2], true)
				&& $input['layout'] !== '' && $input['layout'] !== null) {
			$layout['layout'] = (int) $input['layout'];
		}

		foreach (array_slice(is_array($input['rows'] ?? null) ? $input['rows'] : [], 0, self::MAX_ROWS) as $row) {
			$row = self::text($row, 16);

			if ($row !== '' && !in_array($row, $layout['rows'], true)) {
				$layout['rows'][] = $row;
			}
		}

		$names = [];

		foreach (array_slice(is_array($input['racks'] ?? null) ? $input['racks'] : [], 0, self::MAX_RACKS) as $rack) {
			if (is_string($rack)) {
				$parts = explode('|', $rack);
				$rack = ['name' => $parts[0], 'units' => $parts[1] ?? 42, 'row' => $parts[2] ?? '',
					'pos' => ($parts[3] ?? '') !== '' ? $parts[3] : null, 'kind' => $parts[4] ?? 'rack',
					'width' => $parts[5] ?? 0.6, 'hostid' => $parts[6] ?? '', 'key' => $parts[7] ?? '',
					'power_kw' => $parts[8] ?? 0, 'max_kg' => $parts[9] ?? 0,
					'pdus' => ($parts[10] ?? '') !== '' ? explode(',', $parts[10]) : [],
					'model' => $parts[11] ?? '', 'vpdu' => $parts[12] ?? 0, 'outlets' => $parts[13] ?? 0,
					'mount' => $parts[14] ?? '', 'wall' => $parts[15] ?? 'n', 'offset' => $parts[16] ?? 0,
					'height' => $parts[17] ?? 0, 'depth' => $parts[18] ?? 0
				];
			}

			if (!is_array($rack)) {
				continue;
			}

			$name = self::text($rack['name'] ?? '', 32);

			if ($name === '' || array_key_exists(mb_strtolower($name), $names)) {
				continue;
			}

			$names[mb_strtolower($name)] = true;
			$pos = isset($rack['pos']) && is_numeric($rack['pos']) && (int) $rack['pos'] > 0 ? (int) $rack['pos'] : null;

			// Un lugar de la fila: rack, aire (en fila o perimetral), UPS modular o gabinete de baterías.
			$kind = in_array($rack['kind'] ?? '', self::SLOT_KINDS, true) ? $rack['kind'] : 'rack';
			$model = $kind === 'cooler'
				? (in_array($rack['model'] ?? '', self::COOLER_MODELS, true) ? $rack['model'] : 'inrow')
				: '';
			$default_width = ['rack' => 0.6, 'cooler' => $model === 'crac' ? 1.8 : 0.3, 'ups' => 0.6, 'battery' => 0.6][$kind];
			$width = is_numeric($rack['width'] ?? null) ? round((float) $rack['width'], 2) : $default_width;
			$hostid = (string) ($rack['hostid'] ?? '');
			$vpdu = $kind === 'rack' ? max(0, min(4, (int) ($rack['vpdu'] ?? 0))) : 0;
			$outlets = (int) ($rack['outlets'] ?? 0);
			// Rack de pared (gabinete colgado, ej. llegada de un proveedor de internet): no ocupa fila.
			$on_wall = $kind === 'rack' && ($rack['mount'] ?? '') === 'wall';
			$units = max(4, min(60, (int) ($rack['units'] ?? 42)));

			$layout['racks'][] = [
				'name' => $name,
				'units' => $on_wall ? min(self::WALL_RACK_MAX_U, $units) : $units,
				'row' => $on_wall ? '' : self::text($rack['row'] ?? '', 16),
				'pos' => $pos,
				'kind' => $kind,
				'width' => max(0.3, min($kind === 'cooler' ? 3.0 : 1.2, $width)),
				'model' => $model,
				'hostid' => $kind !== 'rack' && ctype_digit($hostid) ? $hostid : '',
				'key' => $kind !== 'rack' ? self::text($rack['key'] ?? '', 255) : '',
				// PDU verticales (0U) dibujadas en el rack y sus tomas por PDU.
				'vpdu' => $vpdu,
				'outlets' => $vpdu > 0 ? (in_array($outlets, self::OUTLETS, true) ? $outlets : 24) : 0,
				// Capacidad del rack: potencia disponible (kW), carga máxima (kg) y PDU de 0U que lo alimentan.
				'power_kw' => is_numeric($rack['power_kw'] ?? null) ? max(0, min(100, round((float) $rack['power_kw'], 1))) : 0.0,
				'max_kg' => is_numeric($rack['max_kg'] ?? null) ? max(0, min(3000, (int) $rack['max_kg'])) : 0,
				'pdus' => $kind === 'rack' ? array_slice(array_values(array_unique(array_filter(
					array_map('strval', is_array($rack['pdus'] ?? null) ? $rack['pdus'] : []), 'ctype_digit'
				))), 0, 8) : [],
				// Rack de pared: pared (n, s, e, w), distancia desde la esquina, altura de la base y fondo (m).
				'mount' => $on_wall ? 'wall' : '',
				'wall' => $on_wall && in_array($rack['wall'] ?? '', ['n', 's', 'e', 'w'], true) ? $rack['wall'] : 'n',
				'offset' => $on_wall && is_numeric($rack['offset'] ?? null) ? max(0, min(300, round((float) $rack['offset'], 2))) : 0.0,
				'height' => $on_wall && is_numeric($rack['height'] ?? null) ? max(0, min(2.5, round((float) $rack['height'], 2))) : 0.0,
				'depth' => $on_wall
					? (in_array((float) ($rack['depth'] ?? 0), self::WALL_RACK_DEPTHS, false) ? (float) $rack['depth'] : 0.45)
					: 0.0
			];
		}

		$count = 0;

		foreach (is_array($input['placements'] ?? null) ? $input['placements'] : [] as $hostid => $place) {
			if ($count >= self::MAX_PLACEMENTS) {
				break;
			}

			$hostid = (string) $hostid;

			if (is_string($place)) {
				$place = self::expandDevice($place);
			}

			if (!ctype_digit($hostid) || !is_array($place)) {
				continue;
			}

			$place = self::device($place);

			if ($place !== null) {
				unset($place['name']);
				$layout['placements'][$hostid] = $place;
				$count++;
			}
		}

		foreach (array_slice(is_array($input['passives'] ?? null) ? $input['passives'] : [], 0, self::MAX_PASSIVES)
				as $passive) {
			if (is_string($passive)) {
				$passive = self::expandDevice($passive);
			}

			if (!is_array($passive)) {
				continue;
			}

			$passive = self::device($passive + ['type' => 'patch']);

			if ($passive !== null && $passive['u'] !== null) {
				if ($passive['name'] === '') {
					$passive['name'] = 'patch-'.(count($layout['passives']) + 1);
				}

				$layout['passives'][] = $passive;
			}
		}

		return $layout;
	}

	/**
	 * Objeto de infraestructura: {id, kind, name, x, z, rot, rack, level, face, hostid, key, mount, wall, offset, height}.
	 * Montaje: "floor" (suelto, en x/z), "wall" (pegado a una pared: n, s, e, o; a "offset" metros de su
	 * esquina y a "height" metros del piso) o "rack" (solo sensores: pegado al frente o atrás de un rack).
	 */
	private static function object(array $o): ?array {
		$kind = in_array($o['kind'] ?? '', self::KINDS, true) ? $o['kind'] : null;

		if ($kind === null) {
			return null;
		}

		$coord = static fn($v): float => is_numeric($v) ? max(-1000, min(1000, round((float) $v, 2))) : 0.0;
		$rot = (int) ($o['rot'] ?? 0);
		$rack = $kind === 'sensor' ? self::text($o['rack'] ?? '', 32) : '';
		$mount = in_array($o['mount'] ?? '', ['floor', 'wall', 'rack', 'ceiling'], true) ? $o['mount'] : ($rack !== '' ? 'rack' : 'floor');

		// En el techo solo van detectores, cámaras, sensores de movimiento y luces.
		if ($mount === 'ceiling' && !in_array($kind, ['smoke', 'camera', 'motion', 'light', 'sensor', 'wap'], true)) {
			$mount = 'floor';
		}

		if ($mount === 'rack' && $rack === '') {
			$mount = 'floor';
		}

		if ($mount !== 'rack') {
			$rack = '';
		}
		$hostid = (string) ($o['hostid'] ?? '');

		return [
			'id' => preg_replace('/[^A-Za-z0-9_-]/', '', self::text($o['id'] ?? '', 16)),
			'kind' => $kind,
			'name' => self::text($o['name'] ?? '', 64),
			'x' => $coord($o['x'] ?? 0),
			'z' => $coord($o['z'] ?? 0),
			'rot' => in_array($rot, [0, 90, 180, 270], true) ? $rot : 0,
			'rack' => $rack,
			'level' => in_array($o['level'] ?? '', self::LEVELS, true) ? $o['level'] : 'top',
			'face' => ($o['face'] ?? '') === 'back' ? 'back' : 'front',
			'hostid' => ctype_digit($hostid) ? $hostid : '',
			'key' => self::text($o['key'] ?? '', 255),
			'mount' => $mount,
			'wall' => in_array($o['wall'] ?? '', ['n', 's', 'e', 'w'], true) ? $o['wall'] : 'n',
			'offset' => is_numeric($o['offset'] ?? null) ? max(0, min(300, round((float) $o['offset'], 2))) : 0.0,
			'height' => is_numeric($o['height'] ?? null) ? max(0, min(5, round((float) $o['height'], 2))) : 0.0,
			// Puerta: lado de la bisagra (l/r) y hojas (1 = simple de 1 m, 2 = doble de 1,8 m).
			// La cara indica hacia dónde abre: front = hacia adentro de la sala, back = hacia afuera.
			'hinge' => ($o['hinge'] ?? 'l') === 'r' ? 'r' : 'l',
			'leaves' => (int) ($o['leaves'] ?? 1) === 2 ? 2 : 1,
			// Tamaño (1 chico, 2 mediano, 3 grande) de aires de precisión, UPS y bancos de baterías,
			// y gabinetes de baterías al lado de una UPS de sala.
			'size' => max(1, min(3, (int) ($o['size'] ?? 1))),
			'batt' => $kind === 'ups'
				? max(0, min(8, (int) ($o['batt'] ?? 0)))
				: (array_key_exists($kind, self::VARIANTS) ? max(1, min(self::VARIANTS[$kind], (int) ($o['batt'] ?? 1))) : 0)
		];
	}

	/**
	 * Versión compacta para guardar: cada rack y cada equipo como texto separado por "|".
	 * Ejemplo de equipo: "R03|18|2|f|s" (rack, U, alto, cara f/b, tipo).
	 */
	/**
	 * Eficiencia y ambiente de la sala:
	 * - total: elementos que miden la energía total de la instalación (acometida, tablero general…).
	 * - it: dónde se mide la energía de TI — "pdu" (salida de las PDU, categoría 2 de ISO/IEC 30134-2)
	 *   o "ups" (salida de las UPS elegidas en it_objs, categoría 1).
	 * - ashrae: clase de equipos (A1–A4, H1) y rh: humedad máxima recomendada (60 %, o 70 % con
	 *   contaminantes bajos).
	 */
	public static function energy(array $in): array {
		$ids = static fn($list) => array_slice(array_values(array_unique(array_filter(
			is_array($list) ? array_map('strval', $list) : [],
			static fn($v) => (bool) preg_match('/^[A-Za-z0-9_\-]{1,16}$/', $v)
		))), 0, 8);

		$num = static fn($v, float $min, float $max, int $dec) => is_numeric($v) ? round(max($min, min($max, (float) $v)), $dec) : 0;

		return [
			'total' => $ids($in['total'] ?? []),
			'it' => ($in['it'] ?? '') === 'ups' ? 'ups' : 'pdu',
			'it_objs' => $ids($in['it_objs'] ?? []),
			'ashrae' => in_array($in['ashrae'] ?? '', ['A1', 'A2', 'A3', 'A4', 'H1'], true) ? $in['ashrae'] : 'A1',
			'rh' => (int) ($in['rh'] ?? 60) === 70 ? 70 : 60,
			// ISO/IEC 30134: generación renovable (REF, parte 3), energía reutilizada (ERF, parte 6) y agua (WUE, parte 9).
			'renew' => $ids($in['renew'] ?? []),
			'reuse' => $ids($in['reuse'] ?? []),
			'water' => $ids($in['water'] ?? []),
			// Factor de emisión de la red (kg CO₂ por kWh) para el CUE (parte 8) y % de energía renovable comprada.
			'cef' => $num($in['cef'] ?? 0, 0, 2, 3),
			'green' => (int) $num($in['green'] ?? 0, 0, 100, 0),
			// Clase ASHRAE de agua de la instalación para enfriamiento líquido (W17 … W+); vacío si no hay.
			'wclass' => in_array($in['wclass'] ?? '', ['W17', 'W27', 'W32', 'W40', 'W45', 'W+'], true) ? $in['wclass'] : '',
			// Autoevaluación de redundancia: unidades de aire necesarias para la carga (N) y proveedores de
			// telecomunicaciones que entran a la sala.
			'cool_n' => (int) $num($in['cool_n'] ?? 0, 0, 50, 0),
			'isp_n' => (int) $num($in['isp_n'] ?? 0, 0, 10, 0),
			// Tipo de espacio: sala de cómputo / data center o micro data center de borde (edge, TIA-942-C).
			'space' => ($in['space'] ?? '') === 'edge' ? 'edge' : 'dc'
		];
	}

	public static function compact(array $layout): array {
		$out = $layout;
		$clean = static fn($v) => str_replace('|', '/', (string) $v);

		$out['racks'] = array_map(static fn(array $r): string => implode('|', [$clean($r['name']), $r['units'],
			$clean($r['row']), $r['pos'] ?? '', $r['kind'], $r['width'], $r['hostid'], $clean($r['key']),
			$r['power_kw'], $r['max_kg'], implode(',', $r['pdus']), $r['model'], $r['vpdu'], $r['outlets'],
			...(($r['mount'] ?? '') === 'wall' ? ['wall', $r['wall'], $r['offset'], $r['height'], $r['depth']] : [])
		]), $layout['racks']);

		$device = static fn(array $d): string => implode('|', [$clean($d['rack']), $d['u'] ?? '', $d['n'],
			$d['face'] === 'back' ? 'b' : 'f', self::TYPE_CODES[$d['type']] ?? 's'
		]);

		// Consumo y peso solo se agregan cuando tienen valor, para no agrandar la configuración.
		$extra = static fn(array $d): string => ($d['w'] ?? 0) > 0 || ($d['kg'] ?? 0) > 0 ? '|'.$d['w'].'|'.$d['kg'] : '';

		$out['placements'] = array_map(static fn(array $d): string => $device($d).($extra($d) !== '' ? '|'.$extra($d) : ''),
			$layout['placements']
		);
		$out['passives'] = array_map(static fn(array $p): string => $device($p).'|'.$clean($p['name']).$extra($p),
			$layout['passives']
		);

		$out['objects'] = array_map(static fn(array $o): string => implode('|', [$o['id'], $o['kind'], $clean($o['name']),
			$o['x'], $o['z'], $o['rot'], $clean($o['rack']), $o['level'], $o['face'] === 'back' ? 'b' : 'f', $o['hostid'],
			$clean($o['key']), $o['mount'], $o['wall'], $o['offset'], $o['height'], $o['hinge'], $o['leaves'],
			$o['size'], $o['batt']
		]), $layout['objects']);

		return $out;
	}

	private static function expandDevice(string $text): array {
		$parts = explode('|', $text);
		$types = array_flip(self::TYPE_CODES);

		return [
			'rack' => $parts[0],
			'u' => ($parts[1] ?? '') !== '' ? $parts[1] : null,
			'n' => $parts[2] ?? 1,
			'face' => ($parts[3] ?? 'f') === 'b' ? 'back' : 'front',
			'type' => $types[$parts[4] ?? 's'] ?? 'server',
			'name' => $parts[5] ?? '',
			'w' => $parts[6] ?? 0,
			'kg' => $parts[7] ?? 0
		];
	}

	/**
	 * Equipo dentro de un rack: {rack, u, n, face, type, name}. Null si no tiene rack.
	 */
	private static function device(array $place): ?array {
		$rack = self::text($place['rack'] ?? '', 32);

		if ($rack === '') {
			return null;
		}

		$type = in_array($place['type'] ?? '', self::TYPES, true) ? $place['type'] : 'server';
		$u = isset($place['u']) && is_numeric($place['u']) && (int) $place['u'] > 0 ? min(60, (int) $place['u']) : null;

		return [
			'rack' => $rack,
			'u' => $u,
			'n' => max(1, min(20, (int) ($place['n'] ?? 1))),
			'face' => ($place['face'] ?? '') === 'back' ? 'back' : 'front',
			'type' => $type,
			'name' => self::text($place['name'] ?? '', 64),
			// Consumo nominal (W) y peso (kg) para planificar capacidad.
			'w' => is_numeric($place['w'] ?? null) ? max(0, min(50000, (int) $place['w'])) : 0,
			'kg' => is_numeric($place['kg'] ?? null) ? max(0, min(2000, round((float) $place['kg'], 1))) : 0.0
		];
	}

	private static function text($value, int $max): string {
		if (!is_string($value) && !is_numeric($value)) {
			return '';
		}

		$value = preg_replace('/[\x00-\x1F\x7F]/u', '', trim((string) $value));

		return mb_substr((string) $value, 0, $max);
	}

	/**
	 * Convierte el valor de un tag de tipo (en español, portugués o inglés) a un tipo de la vista.
	 * Sin valor, intenta deducirlo del nombre del host y del tipo de inventario.
	 */
	public static function normalizeType(string $value, string $host_text = ''): string {
		$map = [
			'server' => ['server', 'servidor', 'srv', 'host', 'vm', 'hypervisor', 'hipervisor', 'blade'],
			'network' => ['network', 'red', 'rede', 'switch', 'router', 'firewall', 'fw', 'ap', 'wlc'],
			'storage' => ['storage', 'almacenamiento', 'nas', 'san', 'backup', 'respaldo', 'cabina'],
			'ups' => ['ups', 'nobreak', 'sai'],
			'pdu' => ['pdu', 'regleta'],
			'patch' => ['patch', 'patchpanel', 'patch panel', 'odf', 'pasivo', 'passive', 'bandeja'],
			'other' => ['other', 'otro', 'outro']
		];

		$value = mb_strtolower(trim($value));

		if ($value !== '') {
			foreach ($map as $type => $aliases) {
				if (in_array($value, $aliases, true)) {
					return $type;
				}
			}
		}

		$haystack = mb_strtolower($host_text);

		$guess = [
			'network' => '/(^|[^a-z])(sw|switch|rtr|router|fw|firewall|fortigate|mikrotik|core)([^a-z]|$)/',
			'storage' => '/(storage|nas|san|stg|bkp|backup|synology|qnap)/',
			'ups' => '/(^|[^a-z])(ups|nobreak)([^a-z]|$)/',
			'pdu' => '/(^|[^a-z])pdu([^a-z]|$)/'
		];

		foreach ($guess as $type => $regex) {
			if (preg_match($regex, $haystack)) {
				return $type;
			}
		}

		return 'server';
	}

	/**
	 * Racks escritos en el campo de texto del formulario (versión 0.1): "nombre;U;fila;posición".
	 */
	public static function parseRacksText(string $text): array {
		$racks = [];

		foreach (preg_split('/\R/', $text) as $line) {
			$line = trim($line);

			if ($line === '' || $line[0] === '#') {
				continue;
			}

			$parts = array_map('trim', explode(';', $line));

			$racks[] = [
				'name' => $parts[0],
				'units' => isset($parts[1]) && ctype_digit($parts[1]) ? (int) $parts[1] : 0,
				'row' => $parts[2] ?? '',
				'pos' => isset($parts[3]) && ctype_digit($parts[3]) ? (int) $parts[3] : null
			];
		}

		return $racks;
	}

	/**
	 * Pasivos escritos en el campo de texto del formulario (versión 0.1): "rack;U;alto;tipo;nombre".
	 */
	public static function parsePassivesText(string $text): array {
		$result = [];

		foreach (preg_split('/\R/', $text) as $line) {
			$line = trim($line);

			if ($line === '' || $line[0] === '#') {
				continue;
			}

			$parts = array_map('trim', explode(';', $line));

			if (count($parts) < 2 || $parts[0] === '' || !ctype_digit($parts[1])) {
				continue;
			}

			$result[] = [
				'rack' => $parts[0],
				'u' => (int) $parts[1],
				'n' => isset($parts[2]) && ctype_digit($parts[2]) ? (int) $parts[2] : 1,
				'type' => self::normalizeType($parts[3] ?? 'patch'),
				'name' => $parts[4] ?? ''
			];
		}

		return $result;
	}
}
