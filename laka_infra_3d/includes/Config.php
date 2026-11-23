<?php declare(strict_types = 0);
/*
 * LAKA Infra 3D – gemelo digital de data center para Zabbix 7.0 – 8.0
 * © LAKA Soluciones Tecnológicas
 * Autor: Willian Tola
 * Licencia GPLv3
 *
 * Lectura y escritura de la configuración del módulo (tabla module, campo config), igual en MySQL / MariaDB
 * y en PostgreSQL (las bases que soporta Zabbix 7.0 – 8.0).
 * - module.config es TEXT en el esquema de Zabbix: en MySQL / MariaDB guarda hasta 65 535 bytes; en PostgreSQL
 *   no tiene ese tope. Para que una sala real (cientos de cables) entre en las dos, la configuración se guarda
 *   comprimida (zlib + base64) dentro de un objeto {"format": 2, "z": "..."}; si PHP no tiene zlib, se guarda
 *   tal cual (formato 1). Las configuraciones viejas (sin comprimir) se leen igual y se comprimen al guardar.
 * - El tamaño se mide sobre el texto que realmente se guarda (json_encode por defecto, como hace module.update).
 * - El superadministrador escribe por la API (queda en el registro de auditoría); el administrador, que no puede
 *   usar module.update, escribe directo con DB::update (SQL de Zabbix, igual para las dos bases).
 */

namespace Modules\LakaInfra3D\Includes;

use APP,
	CWebUser,
	DB;

class Config {

	public const FORMAT = 2;

	// Topes del texto guardado: MySQL / MariaDB TEXT = 65 535 bytes (se deja margen); PostgreSQL TEXT no tiene
	// tope práctico, se limita para no cargar el navegador.
	public const MAX_MYSQL = 65000;
	public const MAX_PGSQL = 16000000;

	/** Base de datos de Zabbix: "postgresql" o "mysql" (MySQL y MariaDB). */
	public static function dbType(): string {
		global $DB;

		return isset($DB['TYPE']) && $DB['TYPE'] === ZBX_DB_POSTGRESQL ? 'postgresql' : 'mysql';
	}

	public static function maxBytes(): int {
		return self::dbType() === 'postgresql' ? self::MAX_PGSQL : self::MAX_MYSQL;
	}

	/** Configuración guardada (comprimida o no, como arreglo o como texto JSON) → configuración del módulo. */
	public static function decode($raw): array {
		if (is_string($raw)) {
			$raw = json_decode($raw, true);
		}

		if (!is_array($raw)) {
			return [];
		}

		if (($raw['format'] ?? 0) == self::FORMAT && is_string($raw['z'] ?? null)) {
			$bin = base64_decode($raw['z'], true);
			$json = $bin !== false && function_exists('gzinflate') ? @gzinflate($bin) : false;
			$config = $json !== false ? json_decode($json, true) : null;

			return is_array($config) ? $config : [];
		}

		return $raw;
	}

	/** Configuración del módulo → lo que se guarda en module.config (comprimido si hay zlib). */
	public static function encode(array $config): array {
		if (!function_exists('gzdeflate')) {
			return $config;
		}

		$json = json_encode($config, JSON_UNESCAPED_UNICODE);
		$bin = $json !== false ? gzdeflate($json, 9) : false;

		return $bin !== false ? ['format' => self::FORMAT, 'z' => base64_encode($bin)] : $config;
	}

	/** Uso del almacenamiento, para mostrar en el editor. */
	public static function stats(array $config): array {
		$stored = json_encode(self::encode($config));
		$raw = json_encode($config, JSON_UNESCAPED_UNICODE);

		return [
			'db' => self::dbType(),
			'bytes' => $stored === false ? 0 : strlen($stored),
			'max' => self::maxBytes(),
			'raw' => $raw === false ? 0 : strlen($raw),
			'compressed' => function_exists('gzdeflate')
		];
	}

	/**
	 * Id del módulo y configuración actual leída de la base de datos (no de la caché del módulo).
	 *
	 * @return array|null  [moduleid, config] o null si el módulo no está habilitado.
	 */
	// Copia de lo último leído con load(): sirve para armar el historial al guardar.
	private static ?array $loaded = null;

	public static function load(): ?array {
		$module = APP::ModuleManager()->getModule(Layout::MODULE_ID);

		if ($module === null) {
			return null;
		}

		$db_module = DB::select('module', [
			'output' => ['moduleid', 'config'],
			'filter' => ['moduleid' => $module->getModuleId()]
		]);

		$config = $db_module ? self::decode($db_module[0]['config']) : [];
		self::$loaded = $config;

		return [$module->getModuleId(), $config];
	}

	/**
	 * Guarda la configuración completa. Devuelve null si salió bien o el mensaje de error.
	 */
	/**
	 * Guarda la configuración. Antes de guardar registra el historial de la sala (con deshacer) comparando con lo
	 * leído en load(); después deja el resumen en el registro de auditoría de Zabbix.
	 *
	 * $kind: '' guardado normal · 'restore' restauración de respaldo · 'undo' deshacer (no crea entrada nueva).
	 *
	 * Se escribe con DB::update para todos los usuarios. Antes, el Super admin guardaba por module.update y la API
	 * auditaba la configuración entera (vieja y nueva): con más de ~32 KB comprimidos, el detalle superaba los
	 * 64 KB de auditlog.details en MySQL / MariaDB con Zabbix 7.4 y 8.0, y el guardado fallaba.
	 */
	public static function save($moduleid, array $config, ?string $too_big = null, string $kind = '',
			string $audit_text = ''): ?string {
		$entries = [];

		if ($kind !== 'undo' && self::$loaded !== null) {
			$entries = History::record(self::$loaded, $config, $kind);
		}

		$stored = self::encode($config);
		$json = json_encode($stored);

		if ($json === false || strlen($json) > self::maxBytes()) {
			return $too_big ?? I18n::t('La configuración supera el límite de la base de datos de Zabbix (MySQL/MariaDB: 64 KB comprimidos). Quita cables, salas o sitios sin uso, o usa Zabbix sobre PostgreSQL.');
		}

		try {
			DB::update('module', [
				'values' => ['config' => $json],
				'where' => ['moduleid' => $moduleid]
			]);
		}
		catch (\Exception $e) {
			$messages = array_column(get_and_clear_messages(), 'message');

			return $messages ? implode("\n", $messages) : I18n::t('No se pudo guardar.');
		}

		self::$loaded = $config;
		History::audit((string) $moduleid, $entries, $audit_text);

		return null;
	}

	/**
	 * Grupos de usuarios de Zabbix que pueden editar una sala ([] = cualquier Administrador).
	 */
	public static function roomEditors(array $config, string $room): array {
		$list = $config['acl'][$room] ?? [];

		return is_array($list) ? array_values(array_filter(array_map('strval', $list), 'ctype_digit')) : [];
	}

	/**
	 * true si el usuario actual puede editar la sala: Super admin siempre; Administrador si la sala no tiene
	 * grupos asignados o si pertenece a uno de ellos.
	 */
	public static function canEditRoom(array $config, string $room): bool {
		$type = (int) CWebUser::getType();

		if ($type === USER_TYPE_SUPER_ADMIN) {
			return true;
		}

		if ($type < USER_TYPE_ZABBIX_ADMIN) {
			return false;
		}

		$editors = self::roomEditors($config, $room);

		return !$editors || (bool) array_intersect($editors, self::userGroupIds());
	}

	private static function userGroupIds(): array {
		static $ids = null;

		if ($ids === null) {
			$rows = DB::select('users_groups', [
				'output' => ['usrgrpid'],
				'filter' => ['userid' => CWebUser::$data['userid'] ?? 0]
			]);
			$ids = array_map('strval', array_column($rows, 'usrgrpid'));
		}

		return $ids;
	}
}
