<?php declare(strict_types = 0);
/*
 * LAKA Infra 3D – gemelo digital de data center para Zabbix 7.0 – 8.0
 * © LAKA Soluciones Tecnológicas
 * Autor: Willian Tola
 * Licencia GPLv3
 *
 * Energía por período con las tendencias horarias de Zabbix (promedio de potencia de cada hora × 1 h):
 * - PUE (ISO/IEC 30134-2): energía total de la instalación ÷ energía de TI. Solo se cuentan las horas en las
 *   que hay lectura de los dos lados, para comparar el mismo período.
 * - Energía renovable generada (REF, parte 3), energía reutilizada (ERF, parte 6) y agua (WUE, parte 9).
 *   El agua se lee de un medidor de caudal (L/s, L/min, L/h, m³/h, gpm) o de un contador de volumen (L, m³).
 * - Desglose por día y por mes (para el reporte anual).
 * Las tendencias se piden por tramos de 30 días para no traer de una vez un año de horas.
 * Solo lectura, con los permisos del usuario.
 */

namespace Modules\LakaInfra3D\Actions;

use API,
	CController,
	CControllerResponseData;

class EnergyGet extends CController {

	private const MAX_SOURCES = 200;
	private const CHUNK_DAYS = 30;

	// Lados con potencia (W) y el del agua.
	private const POWER_SIDES = ['total', 'it', 'renew', 'reuse'];

	protected function init(): void {
		$this->disableCsrfValidation();
	}

	protected function checkInput(): bool {
		$ret = $this->validateInput([
			'total' => 'required|string',
			'it' => 'required|string',
			'renew' => 'string',
			'reuse' => 'string',
			'water' => 'string',
			'days' => 'required|int32'
		]);

		if (!$ret) {
			$this->respond(['success' => false]);
		}

		return $ret;
	}

	protected function checkPermissions(): bool {
		return $this->getUserType() >= USER_TYPE_ZABBIX_USER;
	}

	protected function doAction(): void {
		$days = max(1, min(366, (int) $this->getInput('days')));
		$now = time();
		$from = $now - $days * 86400;

		$groups = [];

		foreach (self::POWER_SIDES as $side) {
			$groups[$side] = self::resolve($this->sources($side));
		}

		$water = self::resolveWater($this->sources('water'));

		// Horas: [lado][clock] = W; agua: [clock] = litros de esa hora (caudal) y extremos por día (contador).
		$hours = array_fill_keys(self::POWER_SIDES, []);
		$water_hours = [];
		$counter = [];

		$itemids = array_values(array_unique(array_map('strval', array_merge(array_keys($water), ...array_map('array_keys', array_values($groups))))));

		for ($t = $from; $itemids && $t < $now; $t += self::CHUNK_DAYS * 86400) {
			$till = min($now, $t + self::CHUNK_DAYS * 86400 - 1);
			$trends = API::Trend()->get([
				'output' => ['itemid', 'clock', 'value_min', 'value_avg', 'value_max'],
				'itemids' => $itemids,
				'time_from' => $t,
				'time_till' => $till,
				'limit' => count($itemids) * (self::CHUNK_DAYS * 24 + 48)
			]);

			foreach ($trends as $row) {
				$clock = (int) $row['clock'];

				foreach (self::POWER_SIDES as $side) {
					if (array_key_exists($row['itemid'], $groups[$side])) {
						$hours[$side][$clock] = ($hours[$side][$clock] ?? 0) + (float) $row['value_avg'] * $groups[$side][$row['itemid']];
					}
				}

				if (array_key_exists($row['itemid'], $water)) {
					$w = $water[$row['itemid']];

					if ($w['mode'] === 'flow') {
						// Caudal promedio de la hora (L/h) × 1 h.
						$water_hours[$clock] = ($water_hours[$clock] ?? 0) + (float) $row['value_avg'] * $w['factor'];
					}
					else {
						// Contador: consumo del día = máximo − mínimo del día (en litros).
						$day = date('Y-m-d', $clock);
						$key = $row['itemid'].'|'.$day;
						$counter[$key] = [
							'day' => $day,
							'min' => min($counter[$key]['min'] ?? INF, (float) $row['value_min'] * $w['factor']),
							'max' => max($counter[$key]['max'] ?? -INF, (float) $row['value_max'] * $w['factor'])
						];
					}
				}
			}
		}

		$by_day = [];
		$by_month = [];
		$sum = ['total' => 0.0, 'it' => 0.0, 'hours' => 0, 'renew' => 0.0, 'reuse' => 0.0, 'water' => 0.0, 'total_all' => 0.0];
		$bucket = static function (array &$list, string $key, string $field, float $value): void {
			$list += [$key => ['total' => 0.0, 'it' => 0.0, 'hours' => 0, 'renew' => 0.0, 'reuse' => 0.0, 'water' => 0.0, 'total_all' => 0.0]];
			$list[$key][$field] += $value;
		};

		// PUE: horas con los dos lados medidos.
		foreach ($hours['total'] as $clock => $w_total) {
			$day = date('Y-m-d', $clock);
			$month = substr($day, 0, 7);

			// Energía total de todas las horas medidas (denominador de REF y ERF).
			$bucket($by_day, $day, 'total_all', $w_total / 1000);
			$bucket($by_month, $month, 'total_all', $w_total / 1000);
			$sum['total_all'] += $w_total / 1000;

			if (!array_key_exists($clock, $hours['it']) || $hours['it'][$clock] <= 0) {
				continue;
			}

			foreach (['total' => $w_total / 1000, 'it' => $hours['it'][$clock] / 1000, 'hours' => 1] as $field => $value) {
				$bucket($by_day, $day, $field, $value);
				$bucket($by_month, $month, $field, $value);
			}

			$sum['total'] += $w_total / 1000;
			$sum['it'] += $hours['it'][$clock] / 1000;
			$sum['hours']++;
		}

		foreach (['renew', 'reuse'] as $side) {
			foreach ($hours[$side] as $clock => $w) {
				$day = date('Y-m-d', $clock);
				$bucket($by_day, $day, $side, $w / 1000);
				$bucket($by_month, substr($day, 0, 7), $side, $w / 1000);
				$sum[$side] += $w / 1000;
			}
		}

		foreach ($water_hours as $clock => $liters) {
			$day = date('Y-m-d', $clock);
			$bucket($by_day, $day, 'water', $liters);
			$bucket($by_month, substr($day, 0, 7), 'water', $liters);
			$sum['water'] += $liters;
		}

		foreach ($counter as $c) {
			$liters = max(0, $c['max'] - $c['min']);
			$bucket($by_day, $c['day'], 'water', $liters);
			$bucket($by_month, substr($c['day'], 0, 7), 'water', $liters);
			$sum['water'] += $liters;
		}

		ksort($by_day);
		ksort($by_month);

		$row = static fn(array $d): array => [
			'pue' => $d['it'] > 0 ? round($d['total'] / $d['it'], 3) : null,
			'total_kwh' => round($d['total'], 1),
			'it_kwh' => round($d['it'], 1),
			'hours' => $d['hours'],
			'total_all_kwh' => round($d['total_all'], 1),
			'renew_kwh' => round($d['renew'], 1),
			'reuse_kwh' => round($d['reuse'], 1),
			'water_l' => round($d['water'], 1)
		];

		$this->respond([
			'success' => true,
			'days' => array_map(static fn(string $k, array $d): array => ['day' => $k] + $row($d), array_keys($by_day), $by_day),
			'months' => array_map(static fn(string $k, array $d): array => ['month' => $k] + $row($d), array_keys($by_month), $by_month),
			'pue' => $sum['it'] > 0 ? round($sum['total'] / $sum['it'], 3) : null,
			'total_kwh' => round($sum['total'], 1),
			'it_kwh' => round($sum['it'], 1),
			'hours' => $sum['hours'],
			'total_all_kwh' => round($sum['total_all'], 1),
			'renew_kwh' => round($sum['renew'], 1),
			'reuse_kwh' => round($sum['reuse'], 1),
			'water_l' => round($sum['water'], 1),
			'items' => array_map('count', $groups) + ['water' => count($water)],
			'from' => $from
		]);
	}

	private function sources(string $side): array {
		$sources = json_decode((string) $this->getInput($side, '[]'), true);

		return is_array($sources) ? array_slice($sources, 0, self::MAX_SOURCES) : [];
	}

	/**
	 * Agrupa las fuentes [{hostid, pattern}] por patrón y trae sus ítems numéricos.
	 */
	private static function items(array $sources): array {
		$by_pattern = [];

		foreach ($sources as $s) {
			if (is_array($s) && ctype_digit((string) ($s['hostid'] ?? '')) && trim((string) ($s['pattern'] ?? '')) !== '') {
				$by_pattern[trim($s['pattern'])][] = (string) $s['hostid'];
			}
		}

		$out = [];

		foreach ($by_pattern as $pattern => $hostids) {
			$items = API::Item()->get([
				'output' => ['itemid', 'hostid', 'lastvalue', 'units'],
				'hostids' => array_values(array_unique($hostids)),
				'search' => ['key_' => $pattern],
				'searchWildcardsEnabled' => true,
				'filter' => ['value_type' => [ITEM_VALUE_TYPE_FLOAT, ITEM_VALUE_TYPE_UINT64]],
				'monitored' => true,
				'webitems' => false,
				'limit' => count($hostids) * 50
			]);

			array_push($out, ...$items);
		}

		return $out;
	}

	/**
	 * Fuentes [{hostid, pattern}] → [itemid => factor a W]. De cada host se toma el ítem de potencia de mayor
	 * valor que coincide con la clave (el total del equipo y no sus tomas o fases sueltas).
	 */
	public static function resolve(array $sources): array {
		$out = [];

		foreach (self::resolveByHost($sources) as $b) {
			$out[$b['itemid']] = $b['factor'];
		}

		return $out;
	}

	/**
	 * Igual que resolve(), pero por host: [hostid => ['itemid', 'factor', 'w']] (lo usa el pronóstico de capacidad).
	 */
	public static function resolveByHost(array $sources): array {
		$best = [];

		foreach (self::items($sources) as $item) {
			$factor = self::factor($item['units']);

			if ($factor === null) {
				continue;
			}

			$w = (float) $item['lastvalue'] * $factor;
			$hostid = (string) $item['hostid'];

			if (!array_key_exists($hostid, $best) || $w > $best[$hostid]['w']) {
				$best[$hostid] = ['itemid' => (string) $item['itemid'], 'w' => $w, 'factor' => $factor];
			}
		}

		return $best;
	}

	/**
	 * Medidores de agua → [itemid => ['mode' => flow|counter, 'factor' => a L/h o a L]]. Un ítem por host.
	 */
	public static function resolveWater(array $sources): array {
		$out = [];
		$seen = [];

		foreach (self::items($sources) as $item) {
			$w = self::waterFactor($item['units']);

			if ($w === null || isset($seen[$item['hostid']])) {
				continue;
			}

			$seen[$item['hostid']] = true;
			$out[(string) $item['itemid']] = $w;
		}

		return $out;
	}

	/** Factor para pasar a W: W, kW, MW (VA y kVA se toman como W, igual que la potencia por rack). */
	public static function factor(string $units): ?float {
		return [
			'' => 1.0, 'w' => 1.0, 'va' => 1.0, 'kw' => 1000.0, 'kva' => 1000.0, 'mw' => 1000000.0
		][mb_strtolower(trim($units))] ?? null;
	}

	/**
	 * Unidades de agua: caudal (a litros por hora) o volumen acumulado (a litros).
	 */
	public static function waterFactor(string $units): ?array {
		$u = str_replace(['³', ' '], ['3', ''], mb_strtolower(trim($units)));
		$flow = ['l/s' => 3600.0, 'l/min' => 60.0, 'lpm' => 60.0, 'l/h' => 1.0, 'm3/h' => 1000.0, 'm3/min' => 60000.0,
			'gpm' => 227.124];
		$volume = ['l' => 1.0, 'm3' => 1000.0, 'gal' => 3.78541];

		if (array_key_exists($u, $flow)) {
			return ['mode' => 'flow', 'factor' => $flow[$u]];
		}

		return array_key_exists($u, $volume) ? ['mode' => 'counter', 'factor' => $volume[$u]] : null;
	}

	private function respond(array $data): void {
		$this->setResponse(new CControllerResponseData(['main_block' => json_encode($data)]));
	}
}
