<?php declare(strict_types = 0);
/*
 * LAKA Infra 3D – gemelo digital de data center para Zabbix 7.0 – 8.0
 * © LAKA Soluciones Tecnológicas
 * Autor: Willian Tola
 * Licencia GPLv3
 *
 * Historial de cambios por sala, con deshacer.
 *
 * Cada guardado compara la configuración anterior con la nueva y deja, por sala afectada, una entrada con
 * quién, cuándo, un resumen (racks, equipos, objetos, cables) y el "cambio inverso": lo mínimo para volver
 * atrás. El cambio inverso de las listas largas (cables, racks, objetos) guarda solo los elementos agregados
 * y quitados, no la lista entera, para no gastar el espacio de module.config (64 KB en MySQL / MariaDB).
 *
 * Además, cada guardado queda en el registro de auditoría oficial de Zabbix (Informes > Registro de auditoría),
 * con el usuario, la IP y el resumen.
 */

namespace Modules\LakaInfra3D\Includes;

use CAudit,
	CWebUser;

class History {

	// Entradas guardadas por sala y espacio máximo (JSON sin comprimir) para los cambios inversos de una sala.
	public const MAX_ENTRIES = 20;
	public const MAX_UNDO_BYTES = 12000;

	// Clave del historial para los cambios que no son de una sala (sitios, mapa, modelos, permisos).
	public const GLOBAL_KEY = '*';

	// Campos que cambian en cada guardado y no forman parte del contenido.
	private const VOLATILE = ['rev', 'updated', 'user'];

	// Listas de texto que se comparan como conjunto (se guardan solo agregados y quitados).
	private const SET_MIN = 6;

	/**
	 * Registra los cambios entre $before y $after dentro de $after['history'] y devuelve las entradas nuevas
	 * (para el registro de auditoría). $kind marca entradas especiales: 'restore' (restauración de respaldo).
	 */
	public static function record(array $before, array &$after, string $kind = ''): array {
		$history = is_array($after['history'] ?? null) ? $after['history'] : [];
		unset($before['history'], $after['history']);

		$scopes = self::scopes($before, $after);
		$entries = [];
		$user = (string) (CWebUser::$data['username'] ?? CWebUser::$data['alias'] ?? '');

		foreach ($scopes as $scope => $paths) {
			$ops = [];
			$summary = [];

			foreach ($paths as $path) {
				$old = self::get($before, $path);
				$new = self::get($after, $path);
				$ops = array_merge($ops, self::diff($old, $new, $path));
				self::summarize($path, $old, $new, $summary);
			}

			if (!$ops) {
				continue;
			}

			$entry = [
				'id' => substr(base_convert((string) mt_rand(), 10, 36).base_convert((string) time(), 10, 36), 0, 12),
				't' => time(),
				'u' => $user,
				's' => $summary
			];

			if ($kind !== '') {
				$entry['k'] = $kind;
			}

			// Una restauración no se deshace desde aquí: para eso está el respaldo descargado antes.
			if ($kind === '') {
				$entry['r'] = $ops;
				$entry['h'] = self::hash($after, $paths);
				$entry['p'] = $paths;
			}

			$list = is_array($history[$scope] ?? null) ? $history[$scope] : [];
			$list[] = $entry;
			$history[$scope] = self::trim($list);
			$entries[$scope] = $entry;
		}

		$after['history'] = $history;

		return $entries;
	}

	/**
	 * Deshace el último cambio todavía deshacible de $scope. Devuelve el mensaje de error o null.
	 */
	public static function undo(array &$config, string $scope, string $id): ?string {
		$list = $config['history'][$scope] ?? [];

		// El último cambio vigente: el más reciente que no fue deshecho.
		$index = null;

		for ($i = count($list) - 1; $i >= 0; $i--) {
			if (empty($list[$i]['x'])) {
				$index = $i;
				break;
			}
		}

		if ($index === null || $list[$index]['id'] !== $id) {
			return I18n::t('Solo se puede deshacer el último cambio de la sala.');
		}

		$entry = $list[$index];

		if (!isset($entry['r'])) {
			return I18n::t('Este cambio no se puede deshacer (era muy grande o es una restauración).');
		}

		$paths = $entry['p'] ?? [];

		if (self::hash($config, $paths) !== ($entry['h'] ?? '')) {
			return I18n::t('La sala cambió desde entonces; ya no se puede deshacer este cambio.');
		}

		foreach (array_reverse($entry['r']) as $op) {
			self::apply($config, $op);
		}

		// Las revisiones suben para que un editor abierto con la versión vieja reciba el aviso de conflicto.
		foreach ($paths as $path) {
			$target = self::get($config, $path);

			if (is_array($target) && array_key_exists('rev', $target)) {
				self::set($config, array_merge($path, ['rev']), (int) $target['rev'] + 1);
			}
		}

		$list[$index]['x'] = time();
		$list[$index]['xu'] = (string) (CWebUser::$data['username'] ?? CWebUser::$data['alias'] ?? '');
		unset($list[$index]['r']);
		$config['history'][$scope] = $list;

		return null;
	}

	/**
	 * Lista para el editor: sin los cambios inversos, con la marca de cuál se puede deshacer.
	 */
	public static function forClient(array $config, string $scope): array {
		$list = $config['history'][$scope] ?? [];
		$out = [];
		$undoable = null;

		for ($i = count($list) - 1; $i >= 0; $i--) {
			if (empty($list[$i]['x'])) {
				$undoable = isset($list[$i]['r']) ? $list[$i]['id'] : null;
				break;
			}
		}

		foreach (array_reverse($list) as $e) {
			$out[] = [
				'id' => $e['id'],
				't' => $e['t'],
				'u' => $e['u'],
				's' => $e['s'] ?? [],
				'k' => $e['k'] ?? '',
				'undone' => !empty($e['x']),
				'undone_by' => $e['xu'] ?? '',
				'can_undo' => $e['id'] === $undoable
			];
		}

		return $out;
	}

	/**
	 * Resumen corto en el idioma actual, para el registro de auditoría de Zabbix.
	 */
	public static function text(string $scope, array $entry): string {
		$s = $entry['s'] ?? [];
		$parts = [];
		$names = [
			'racks' => I18n::t('racks'),
			'devices' => I18n::t('equipos'),
			'objects' => I18n::t('objetos'),
			'cables' => I18n::t('cables'),
			'sites' => I18n::t('sitios'),
			'models' => I18n::t('modelos')
		];

		foreach ($names as $key => $name) {
			if (isset($s[$key])) {
				[$a, $d, $c] = $s[$key] + [0, 0, 0];
				$parts[] = $name.': '.implode(' ', array_filter(['+'.$a, '-'.$d, '~'.$c], static fn($v) => $v[1] !== '0'));
			}
		}

		if (!empty($s['other'])) {
			$parts[] = I18n::t('otros ajustes').': '.$s['other'];
		}

		$where = $scope === self::GLOBAL_KEY ? I18n::t('General') : sprintf(I18n::t('Sala %1$s'), $scope === Layout::DEFAULT_ROOM ? I18n::t('Sala principal') : $scope);
		$prefix = ($entry['k'] ?? '') === 'restore' ? I18n::t('Restauración de respaldo').' · ' : '';

		return 'LAKA Infra 3D · '.$prefix.$where.($parts ? ' · '.implode(' · ', $parts) : '');
	}

	/**
	 * Escribe las entradas en el registro de auditoría oficial de Zabbix (si la auditoría está activa).
	 * Se guarda solo el resumen, nunca la configuración: el detalle de auditoría tiene tope de 64 KB en MySQL.
	 */
	public static function audit(string $moduleid, array $entries, string $action_text = ''): void {
		if (!class_exists('CAudit') || (!$entries && $action_text === '')) {
			return;
		}

		$lines = [];

		foreach ($entries as $scope => $entry) {
			$lines[] = self::text((string) $scope, $entry);
		}

		if ($action_text !== '') {
			$lines[] = 'LAKA Infra 3D · '.$action_text;
		}

		try {
			CAudit::log(
				(string) (CWebUser::$data['userid'] ?? ''),
				CWebUser::getIp(),
				(string) (CWebUser::$data['username'] ?? CWebUser::$data['alias'] ?? ''),
				CAudit::ACTION_UPDATE,
				CAudit::RESOURCE_MODULE,
				[['moduleid' => $moduleid, 'id' => Layout::MODULE_ID, 'config' => ['laka3d' => mb_substr(implode("\n", $lines), 0, 2000)]]],
				[$moduleid => ['moduleid' => $moduleid, 'id' => Layout::MODULE_ID, 'config' => ['laka3d' => '']]]
			);
		}
		catch (\Throwable $e) {
			// La auditoría nunca debe impedir el guardado.
		}
	}

	/**
	 * Partes de la configuración que cambiaron, agrupadas por sala (o "*" para lo general).
	 */
	private static function scopes(array $before, array $after): array {
		$scopes = [];

		foreach (['rooms', 'cables'] as $area) {
			$keys = array_unique(array_merge(array_keys((array) ($before[$area] ?? [])), array_keys((array) ($after[$area] ?? []))));

			foreach ($keys as $room) {
				if (self::clean($before[$area][$room] ?? null) != self::clean($after[$area][$room] ?? null)) {
					$scopes[(string) $room][] = [$area, (string) $room];
				}
			}
		}

		foreach (array_unique(array_merge(array_keys($before), array_keys($after))) as $key) {
			// Las órdenes de trabajo tienen su propio registro (auditoría de Zabbix), no van al historial.
			if (in_array($key, ['rooms', 'cables', 'wo', 'wo_seq'], true)) {
				continue;
			}

			if (self::clean($before[$key] ?? null) != self::clean($after[$key] ?? null)) {
				$scopes[self::GLOBAL_KEY][] = [$key];
			}
		}

		return $scopes;
	}

	/**
	 * Cambio inverso de $old → $new: lista de operaciones que, aplicadas, devuelven $old.
	 *  v = poner este valor, d = borrar la clave, sa/sd = en una lista de textos, agregar sa y quitar sd.
	 */
	private static function diff($old, $new, array $path): array {
		$old = self::clean($old);
		$new = self::clean($new);

		if ($old === $new) {
			return [];
		}

		if ($new === null) {
			return [['p' => $path, 'v' => $old]];
		}

		if ($old === null) {
			return [['p' => $path, 'd' => 1]];
		}

		if (self::isTextList($old) && self::isTextList($new) && max(count($old), count($new)) >= self::SET_MIN) {
			return [['p' => $path, 'sa' => array_values(self::minus($old, $new)), 'sd' => array_values(self::minus($new, $old))]];
		}

		if (is_array($old) && is_array($new) && !self::isList($old) && !self::isList($new)) {
			$ops = [];

			foreach (array_unique(array_merge(array_keys($old), array_keys($new))) as $key) {
				if (in_array($key, self::VOLATILE, true) && count($path) <= 2) {
					continue;
				}

				$ops = array_merge($ops, self::diff($old[$key] ?? null, $new[$key] ?? null, array_merge($path, [(string) $key])));
			}

			return $ops;
		}

		return [['p' => $path, 'v' => $old]];
	}

	private static function apply(array &$config, array $op): void {
		$path = $op['p'];

		if (isset($op['d'])) {
			self::remove($config, $path);
		}
		elseif (array_key_exists('v', $op)) {
			self::set($config, $path, $op['v']);
		}
		else {
			$list = self::get($config, $path);
			$list = is_array($list) ? $list : [];

			foreach ($op['sd'] as $item) {
				$at = array_search($item, $list, true);

				if ($at !== false) {
					unset($list[$at]);
				}
			}

			self::set($config, $path, array_values(array_merge($list, $op['sa'])));
		}
	}

	/**
	 * Resumen de una parte: [agregados, quitados, cambiados] de racks, equipos, objetos, cables, sitios y modelos.
	 */
	private static function summarize(array $path, $old, $new, array &$summary): void {
		$old = is_array($old) ? $old : [];
		$new = is_array($new) ? $new : [];
		$count = static function (string $name, array $a, array $b) use (&$summary): void {
			$add = count(array_diff_key($b, $a));
			$del = count(array_diff_key($a, $b));
			$chg = 0;

			foreach (array_intersect_key($a, $b) as $k => $v) {
				$chg += $v != $b[$k] ? 1 : 0;
			}

			if ($add || $del || $chg) {
				$prev = $summary[$name] ?? [0, 0, 0];
				$summary[$name] = [$prev[0] + $add, $prev[1] + $del, $prev[2] + $chg];
			}
		};
		// Listas compactas "a|b|c": se identifican por el primer campo (nombre del rack, id del objeto).
		$byFirst = static function (array $list, int $fields = 1): array {
			$out = [];

			foreach ($list as $text) {
				$out[implode('|', array_slice(explode('|', (string) $text), 0, $fields))] = $text;
			}

			return $out;
		};

		switch ($path[0]) {
			case 'rooms':
				$count('racks', $byFirst((array) ($old['racks'] ?? [])), $byFirst((array) ($new['racks'] ?? [])));
				$count('devices', (array) ($old['placements'] ?? []) + $byFirst((array) ($old['passives'] ?? []), 2),
					(array) ($new['placements'] ?? []) + $byFirst((array) ($new['passives'] ?? []), 2)
				);
				$count('objects', $byFirst((array) ($old['objects'] ?? [])), $byFirst((array) ($new['objects'] ?? [])));

				$rest = array_diff(array_unique(array_merge(array_keys($old), array_keys($new))),
					array_merge(['racks', 'placements', 'passives', 'objects'], self::VOLATILE)
				);
				$other = 0;

				foreach ($rest as $k) {
					$other += ($old[$k] ?? null) != ($new[$k] ?? null) ? 1 : 0;
				}

				if ($other) {
					$summary['other'] = ($summary['other'] ?? 0) + $other;
				}
				break;

			case 'cables':
				// Un cable es su texto completo: solo hay agregados y quitados.
				$a = array_fill_keys(array_map('strval', (array) ($old['list'] ?? [])), 1);
				$b = array_fill_keys(array_map('strval', (array) ($new['list'] ?? [])), 1);
				$count('cables', $a, $b);

				$rest = self::clean(array_diff_key($old, ['list' => 1])) != self::clean(array_diff_key($new, ['list' => 1]));

				if ($rest) {
					$summary['other'] = ($summary['other'] ?? 0) + 1;
				}
				break;

			case 'sites':
				$count('sites', $old, $new);
				break;

			case 'models':
				$count('models', $old, $new);
				break;

			default:
				$summary['other'] = ($summary['other'] ?? 0) + 1;
		}
	}

	/**
	 * Recorta la lista: como máximo MAX_ENTRIES y MAX_UNDO_BYTES en cambios inversos (se pierden los más viejos).
	 */
	private static function trim(array $list): array {
		$list = array_slice($list, -self::MAX_ENTRIES);
		$bytes = 0;

		for ($i = count($list) - 1; $i >= 0; $i--) {
			if (!isset($list[$i]['r'])) {
				continue;
			}

			$size = strlen((string) json_encode($list[$i]['r'], JSON_UNESCAPED_UNICODE));

			// Un cambio inverso que no entra deja de poder deshacerse, y también todos los anteriores.
			if ($bytes + $size > self::MAX_UNDO_BYTES) {
				for ($j = $i; $j >= 0; $j--) {
					unset($list[$j]['r'], $list[$j]['h'], $list[$j]['p']);
				}
				break;
			}

			$bytes += $size;
		}

		return array_values($list);
	}

	/**
	 * Huella del contenido (sin revisiones y sin importar el orden de las listas de texto).
	 */
	private static function hash(array $config, array $paths): string {
		$parts = [];

		foreach ($paths as $path) {
			$parts[] = self::canonical(self::clean(self::get($config, $path)));
		}

		return substr(md5((string) json_encode($parts, JSON_UNESCAPED_UNICODE)), 0, 16);
	}

	private static function canonical($value) {
		if (!is_array($value)) {
			return $value;
		}

		if (self::isTextList($value)) {
			$value = array_map('strval', $value);
			sort($value, SORT_STRING);

			return $value;
		}

		if (!self::isList($value)) {
			ksort($value);
		}

		return array_map([self::class, 'canonical'], $value);
	}

	/**
	 * Quita los campos volátiles del primer nivel de una sala o del cableado.
	 */
	private static function clean($value) {
		if (is_array($value) && !self::isList($value)) {
			foreach (self::VOLATILE as $k) {
				unset($value[$k]);
			}
		}

		return $value;
	}

	// Equivalente de array_is_list() (PHP 8.1), porque Zabbix 7.0 funciona con PHP 8.0.
	private static function isList(array $value): bool {
		return $value === [] || array_keys($value) === range(0, count($value) - 1);
	}

	private static function isTextList($value): bool {
		if (!is_array($value) || !self::isList($value)) {
			return false;
		}

		foreach ($value as $item) {
			if (!is_string($item) && !is_int($item)) {
				return false;
			}
		}

		return true;
	}

	// Diferencia de listas respetando repetidos.
	private static function minus(array $a, array $b): array {
		$out = [];
		$count = array_count_values(array_map('strval', $b));

		foreach ($a as $item) {
			$k = (string) $item;

			if (!empty($count[$k])) {
				$count[$k]--;
				continue;
			}

			$out[] = $item;
		}

		return $out;
	}

	private static function get(array $config, array $path) {
		$node = $config;

		foreach ($path as $key) {
			if (!is_array($node) || !array_key_exists($key, $node)) {
				return null;
			}

			$node = $node[$key];
		}

		return $node;
	}

	private static function set(array &$config, array $path, $value): void {
		$node = &$config;

		foreach ($path as $key) {
			if (!isset($node[$key]) || !is_array($node[$key])) {
				$node[$key] = $node[$key] ?? [];
			}

			$node = &$node[$key];
		}

		$node = $value;
	}

	private static function remove(array &$config, array $path): void {
		$last = array_pop($path);
		$node = &$config;

		foreach ($path as $key) {
			if (!isset($node[$key]) || !is_array($node[$key])) {
				return;
			}

			$node = &$node[$key];
		}

		unset($node[$last]);
	}
}
