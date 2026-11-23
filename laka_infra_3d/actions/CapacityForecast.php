<?php declare(strict_types = 0);
/*
 * LAKA Infra 3D – gemelo digital de data center para Zabbix 7.0 – 8.0
 * © LAKA Soluciones Tecnológicas
 * Autor: Willian Tola
 * Licencia GPLv3
 *
 * Pronóstico de capacidad eléctrica: con la potencia medida en las PDU de cada rack (tendencias horarias de
 * Zabbix, promedio diario) se ajusta una recta por mínimos cuadrados y se estima en cuántos días el rack llega
 * a su capacidad (kW). Lo mismo para la sala (suma de los racks con medición). Es una proyección lineal:
 * sirve para planificar, no reemplaza el análisis del crecimiento real. Solo lectura, con los permisos del usuario.
 */

namespace Modules\LakaInfra3D\Actions;

use API,
	CController,
	CControllerResponseData;

class CapacityForecast extends CController {

	private const MAX_RACKS = 300;
	private const CHUNK_DAYS = 30;

	// Días mínimos con datos para dar un pronóstico.
	public const MIN_DAYS = 14;

	protected function init(): void {
		$this->disableCsrfValidation();
	}

	protected function checkInput(): bool {
		$ret = $this->validateInput([
			'racks' => 'required|string',
			'pattern' => 'required|string',
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
		$days = max(14, min(365, (int) $this->getInput('days')));
		$now = time();
		$from = $now - $days * 86400;
		$pattern = trim($this->getInput('pattern'));
		$racks = json_decode($this->getInput('racks'), true);
		$racks = is_array($racks) ? array_slice($racks, 0, self::MAX_RACKS) : [];

		// PDU de cada rack → ítem de potencia.
		$sources = [];
		$rack_hosts = [];

		foreach ($racks as $r) {
			$name = mb_substr((string) ($r['name'] ?? ''), 0, 64);
			$hosts = array_values(array_filter(array_map('strval', (array) ($r['hostids'] ?? [])), 'ctype_digit'));

			if ($name === '' || !$hosts) {
				continue;
			}

			$rack_hosts[$name] = ['hosts' => $hosts, 'cap_w' => max(0, (float) ($r['cap_w'] ?? 0))];

			foreach ($hosts as $h) {
				$sources[] = ['hostid' => $h, 'pattern' => $pattern];
			}
		}

		$by_host = $pattern !== '' ? EnergyGet::resolveByHost($sources) : [];
		$item_host = [];

		foreach ($by_host as $hostid => $b) {
			$item_host[$b['itemid']] = ['host' => (string) $hostid, 'factor' => $b['factor']];
		}

		// Watts por host y hora.
		$hours = [];

		for ($t = $from; $item_host && $t < $now; $t += self::CHUNK_DAYS * 86400) {
			$rows = API::Trend()->get([
				'output' => ['itemid', 'clock', 'value_avg'],
				'itemids' => array_keys($item_host),
				'time_from' => $t,
				'time_till' => min($now, $t + self::CHUNK_DAYS * 86400 - 1),
				'limit' => count($item_host) * (self::CHUNK_DAYS * 24 + 48)
			]);

			foreach ($rows as $row) {
				$ih = $item_host[$row['itemid']] ?? null;

				if ($ih !== null) {
					$hours[$ih['host']][(int) $row['clock']] = (float) $row['value_avg'] * $ih['factor'];
				}
			}
		}

		$out = [];
		$room_days = [];
		$room_cap = 0.0;

		foreach ($rack_hosts as $name => $r) {
			// Por hora: suma de las PDU con lectura; por día: promedio de esas horas.
			$sum = [];

			foreach ($r['hosts'] as $h) {
				foreach ($hours[$h] ?? [] as $clock => $w) {
					$sum[$clock] = ($sum[$clock] ?? 0) + $w;
				}
			}

			$daily = [];

			foreach ($sum as $clock => $w) {
				$d = intdiv($clock - $from, 86400);
				$daily[$d][] = $w;
			}

			$series = [];

			foreach ($daily as $d => $list) {
				$series[$d] = array_sum($list) / count($list);
			}

			ksort($series);

			if ($r['cap_w'] > 0 && $series) {
				$room_cap += $r['cap_w'];

				foreach ($series as $d => $w) {
					$room_days[$d] = ($room_days[$d] ?? 0) + $w;
				}
			}

			$out[] = ['name' => $name] + self::forecast($series, $r['cap_w']);
		}

		ksort($room_days);

		$this->respond([
			'success' => true,
			'days' => $days,
			'racks' => $out,
			'room' => self::forecast($room_days, $room_cap)
		]);
	}

	/**
	 * Recta por mínimos cuadrados sobre la serie diaria [día => W] y días hasta llegar a la capacidad.
	 */
	public static function forecast(array $series, float $cap_w): array {
		$n = count($series);
		$base = ['points' => $n, 'cap_w' => round($cap_w), 'current_w' => null, 'slope_w_month' => null, 'r2' => null,
			'eta_days' => null, 'status' => 'nodata', 'series' => []
		];

		if ($n === 0) {
			return $base;
		}

		$xs = array_keys($series);
		$ys = array_values($series);
		$last = array_slice($ys, -7);
		$base['current_w'] = round(array_sum($last) / count($last));
		// Serie diaria en kW (para el gráfico), como mucho 365 puntos.
		$base['series'] = array_map(static fn($w) => round($w / 1000, 2), $ys);

		if ($n < self::MIN_DAYS) {
			$base['status'] = 'short';

			return $base;
		}

		$mx = array_sum($xs) / $n;
		$my = array_sum($ys) / $n;
		$sxx = 0.0;
		$sxy = 0.0;
		$syy = 0.0;

		foreach ($xs as $i => $x) {
			$sxx += ($x - $mx) ** 2;
			$sxy += ($x - $mx) * ($ys[$i] - $my);
			$syy += ($ys[$i] - $my) ** 2;
		}

		$slope = $sxx > 0 ? $sxy / $sxx : 0.0;
		$base['slope_w_month'] = round($slope * 30);
		$base['r2'] = $sxx > 0 && $syy > 0 ? round(($sxy * $sxy) / ($sxx * $syy), 3) : null;

		// Valor de la recta hoy (último día de la serie).
		$today = $my + $slope * (end($xs) - $mx);

		if ($cap_w <= 0) {
			$base['status'] = 'nocap';
		}
		elseif ($today >= $cap_w) {
			$base['status'] = 'full';
			$base['eta_days'] = 0;
		}
		elseif ($slope <= 0) {
			$base['status'] = 'stable';
		}
		else {
			$base['eta_days'] = (int) ceil(($cap_w - $today) / $slope);
			$base['status'] = 'growing';
		}

		return $base;
	}

	private function respond(array $data): void {
		$this->setResponse(new CControllerResponseData(['main_block' => json_encode($data)]));
	}
}
