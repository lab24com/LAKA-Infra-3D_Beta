<?php declare(strict_types = 0);
/*
 * LAKA Infra 3D – gemelo digital de data center para Zabbix 7.0 – 8.0
 * © LAKA Soluciones Tecnológicas
 * Autor: Willian Tola
 * Licencia GPLv3
 *
 * Órdenes de trabajo por sala (instalar, mover, retirar, mantenimiento) ligadas a los periodos de mantenimiento
 * oficiales de Zabbix (maintenance.create / update / delete): mientras dura el trabajo, Zabbix no genera
 * problemas para esos hosts (o ni siquiera recolecta datos, si se elige) y la vista 3D los muestra
 * "en mantenimiento" con el estado que entrega Zabbix.
 *
 * Se guardan en module.config → wo[sala] (lista compacta). No entran en el historial de la sala: cada alta,
 * cambio de estado o borrado queda en el registro de auditoría de Zabbix.
 */

namespace Modules\LakaInfra3D\Includes;

use API,
	CWebUser;

class WorkOrders {

	public const TYPES = ['install', 'move', 'remove', 'maint', 'other'];
	public const STATUSES = ['open', 'progress', 'done', 'cancelled'];

	// Por sala: órdenes abiertas sin límite práctico (hasta 40) y las 15 cerradas más recientes.
	public const MAX_OPEN = 40;
	public const MAX_CLOSED = 15;
	public const MAX_HOSTS = 200;
	public const MAX_RACKS = 20;

	// Prefijo del nombre del periodo de mantenimiento en Zabbix.
	public const MAINT_PREFIX = 'LAKA3D';

	/**
	 * Lista de la sala, ya validada.
	 */
	public static function list(array $config, string $room): array {
		$list = $config['wo'][$room] ?? [];

		return is_array($list) ? array_values(array_filter($list, 'is_array')) : [];
	}

	/**
	 * Valida una orden recibida del widget. Devuelve [orden, error].
	 */
	public static function normalize(array $in, ?array $current): array {
		$title = mb_substr(trim((string) ($in['title'] ?? '')), 0, 120);

		if ($title === '') {
			return [null, I18n::t('La orden necesita un título.')];
		}

		$start = (int) ($in['start'] ?? 0);
		$end = (int) ($in['end'] ?? 0);

		if ($start <= 0 || $end <= 0) {
			return [null, I18n::t('Indica el inicio y el fin del trabajo.')];
		}

		// Zabbix exige al menos 5 minutos de periodo.
		if ($end - $start < 300) {
			return [null, I18n::t('El fin debe ser al menos 5 minutos después del inicio.')];
		}

		$racks = array_slice(array_values(array_unique(array_filter(array_map(
			static fn($r) => mb_substr(trim((string) $r), 0, 64), (array) ($in['racks'] ?? [])
		), 'strlen'))), 0, self::MAX_RACKS);

		$hostids = array_slice(array_values(array_unique(array_filter(array_map('strval', (array) ($in['hostids'] ?? [])),
			'ctype_digit'
		))), 0, self::MAX_HOSTS);

		$order = [
			'id' => $current['id'] ?? '',
			'title' => $title,
			'type' => in_array($in['type'] ?? '', self::TYPES, true) ? $in['type'] : 'other',
			'status' => $current['status'] ?? 'open',
			'racks' => $racks,
			'hostids' => $hostids,
			'start' => $start,
			'end' => $end,
			'who' => mb_substr(trim((string) ($in['who'] ?? '')), 0, 64),
			'ticket' => mb_substr(trim((string) ($in['ticket'] ?? '')), 0, 64),
			'notes' => mb_substr(trim((string) ($in['notes'] ?? '')), 0, 1000),
			// Mantenimiento de Zabbix: 0 sin mantenimiento, 1 con recolección de datos, 2 sin recolección.
			'maint' => in_array((int) ($in['maint'] ?? 0), [0, 1, 2], true) ? (int) $in['maint'] : 0,
			'mid' => $current['mid'] ?? '',
			'by' => $current['by'] ?? self::user(),
			'created' => $current['created'] ?? time(),
			'updated' => time(),
			'closed' => $current['closed'] ?? 0
		];

		return [$order, null];
	}

	/**
	 * Crea, actualiza o quita el periodo de mantenimiento de Zabbix de la orden según su estado.
	 * Devuelve el mensaje de error de Zabbix o null. Modifica $order['mid'].
	 */
	public static function syncMaintenance(array &$order, string $room): ?string {
		$active = in_array($order['status'], ['open', 'progress'], true);
		$want = $active && $order['maint'] > 0 && $order['hostids'];
		$now = time();

		try {
			// Orden cerrada o sin mantenimiento: se acorta (si ya empezó) o se borra (si no empezó).
			if (!$want) {
				if ($order['mid'] !== '') {
					$db = API::Maintenance()->get(['output' => ['maintenanceid', 'active_since', 'active_till'],
						'maintenanceids' => [$order['mid']]
					]);

					if ($db) {
						$since = (int) $db[0]['active_since'];
						$till = (int) $db[0]['active_till'];

						if ($now < $since + 300) {
							// Todavía no empezó (o recién empieza): se borra.
							API::Maintenance()->delete([$order['mid']]);
						}
						elseif ($now < $till) {
							// En curso: termina ahora (Zabbix pide al menos 5 minutos de periodo).
							API::Maintenance()->update([[
								'maintenanceid' => $order['mid'],
								'active_till' => $now,
								'timeperiods' => [['timeperiod_type' => TIMEPERIOD_TYPE_ONETIME, 'start_date' => $since,
									'period' => $now - $since
								]]
							]]);
						}
						// Ya terminó: se deja como registro en Zabbix.
					}

					$order['mid'] = '';
				}

				return self::apiError();
			}

			$maintenance = [
				'name' => self::maintenanceName($order),
				'maintenance_type' => $order['maint'] === 2 ? MAINTENANCE_TYPE_NODATA : MAINTENANCE_TYPE_NORMAL,
				'description' => self::description($order, $room),
				'active_since' => $order['start'],
				'active_till' => $order['end'],
				'hosts' => array_map(static fn(string $id): array => ['hostid' => $id], $order['hostids']),
				'timeperiods' => [['timeperiod_type' => TIMEPERIOD_TYPE_ONETIME, 'start_date' => $order['start'],
					'period' => $order['end'] - $order['start']
				]]
			];

			$exists = $order['mid'] !== ''
				? API::Maintenance()->get(['output' => ['maintenanceid'], 'maintenanceids' => [$order['mid']]])
				: [];

			if ($exists) {
				$result = API::Maintenance()->update([['maintenanceid' => $order['mid']] + $maintenance]);
			}
			else {
				$result = API::Maintenance()->create([$maintenance]);

				if ($result && !empty($result['maintenanceids'])) {
					$order['mid'] = (string) $result['maintenanceids'][0];
				}
			}

			if (!$result) {
				return self::apiError() ?? I18n::t('Zabbix no aceptó el periodo de mantenimiento.');
			}
		}
		catch (\Throwable $e) {
			return self::apiError() ?? $e->getMessage();
		}

		return null;
	}

	/**
	 * Guarda la orden en la lista de la sala, con número correlativo y recorte de cerradas antiguas.
	 */
	public static function put(array &$config, string $room, array $order): array {
		$list = self::list($config, $room);

		if ($order['id'] === '') {
			$seq = (int) ($config['wo_seq'] ?? 0) + 1;
			$config['wo_seq'] = $seq;
			$order['id'] = sprintf('OT-%04d', $seq);
			$list[] = $order;
		}
		else {
			foreach ($list as $i => $o) {
				if ($o['id'] === $order['id']) {
					$list[$i] = $order;
				}
			}
		}

		$config['wo'][$room] = self::trim($list);

		return $order;
	}

	public static function remove(array &$config, string $room, string $id): void {
		$config['wo'][$room] = array_values(array_filter(self::list($config, $room), static fn(array $o): bool => $o['id'] !== $id));

		if (!$config['wo'][$room]) {
			unset($config['wo'][$room]);
		}

		if (empty($config['wo'])) {
			unset($config['wo']);
		}
	}

	public static function find(array $config, string $room, string $id): ?array {
		foreach (self::list($config, $room) as $o) {
			if ($o['id'] === $id) {
				return $o;
			}
		}

		return null;
	}

	/**
	 * Texto corto para el registro de auditoría de Zabbix.
	 */
	public static function auditText(string $verb, array $order, string $room): string {
		return sprintf('%s %s · %s · %s', $verb, $order['id'], $order['title'],
			sprintf(I18n::t('Sala %1$s'), $room === Layout::DEFAULT_ROOM ? I18n::t('Sala principal') : $room)
		);
	}

	private static function trim(array $list): array {
		$open = array_values(array_filter($list, static fn(array $o): bool => in_array($o['status'], ['open', 'progress'], true)));
		$closed = array_values(array_filter($list, static fn(array $o): bool => !in_array($o['status'], ['open', 'progress'], true)));

		usort($closed, static fn(array $a, array $b): int => $b['closed'] <=> $a['closed']);

		return array_merge(array_slice($open, 0, self::MAX_OPEN), array_slice($closed, 0, self::MAX_CLOSED));
	}

	private static function maintenanceName(array $order): string {
		return mb_substr(self::MAINT_PREFIX.' '.$order['id'].' · '.$order['title'], 0, 128);
	}

	private static function description(array $order, string $room): string {
		$lines = [
			'LAKA Infra 3D · '.$order['id'],
			sprintf(I18n::t('Sala %1$s'), $room === Layout::DEFAULT_ROOM ? I18n::t('Sala principal') : $room)
		];

		if ($order['racks']) {
			$lines[] = I18n::t('Racks').': '.implode(', ', $order['racks']);
		}
		if ($order['who'] !== '') {
			$lines[] = I18n::t('Responsable').': '.$order['who'];
		}
		if ($order['ticket'] !== '') {
			$lines[] = I18n::t('Ticket').': '.$order['ticket'];
		}
		if ($order['notes'] !== '') {
			$lines[] = $order['notes'];
		}

		return mb_substr(implode("\n", $lines), 0, 2000);
	}

	private static function apiError(): ?string {
		$messages = array_column(array_filter(get_and_clear_messages(), static fn(array $m): bool => ($m['type'] ?? '') === 'error'), 'message');

		return $messages ? implode("\n", $messages) : null;
	}

	private static function user(): string {
		return (string) (CWebUser::$data['username'] ?? CWebUser::$data['alias'] ?? '');
	}
}
