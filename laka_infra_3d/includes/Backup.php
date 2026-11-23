<?php declare(strict_types = 0);
/*
 * LAKA Infra 3D – gemelo digital de data center para Zabbix 7.0 – 8.0
 * © LAKA Soluciones Tecnológicas
 * Autor: Willian Tola
 * Licencia GPLv3
 *
 * Respaldo y restauración completos del módulo.
 *
 * La exportación de dashboards de Zabbix lleva solo los campos del widget; las salas, el cableado, los sitios,
 * los modelos y los permisos viven en module.config y no viajan con ella. Este respaldo los lleva todos en un
 * archivo JSON, opcionalmente con las fotos de los modelos (imágenes de Zabbix), para migrar a otro servidor
 * (por ejemplo de MySQL a PostgreSQL) o volver a un estado anterior.
 *
 * Al restaurar, todo pasa por los mismos normalizadores que usa el editor: nada se guarda sin validar.
 */

namespace Modules\LakaInfra3D\Includes;

use API,
	CWebUser;

use Modules\LakaInfra3D\Actions\{
	CableSave,
	ModelSave
};

class Backup {

	public const MARK = 'laka_infra_3d_backup';
	public const FORMAT = 1;

	private const MAX_ROOMS = 200;
	private const MAX_SITES = 500;
	private const MAX_IMAGES = 500;

	/**
	 * Arma el respaldo. El historial no viaja (es propio de cada servidor).
	 */
	public static function build(array $config, string $module_version, bool $with_images): array {
		unset($config['history']);

		$backup = [
			self::MARK => self::FORMAT,
			'module_version' => $module_version,
			'zabbix_version' => defined('ZABBIX_VERSION') ? ZABBIX_VERSION : '',
			'db' => Config::dbType(),
			'exported' => time(),
			'by' => (string) (CWebUser::$data['username'] ?? CWebUser::$data['alias'] ?? ''),
			'config' => $config
		];

		if ($with_images) {
			$ids = [];

			foreach ((array) ($config['models'] ?? []) as $model) {
				foreach (['f', 'b'] as $side) {
					if (!empty($model[$side]) && ctype_digit((string) $model[$side])) {
						$ids[] = (string) $model[$side];
					}
				}
			}

			$ids = array_slice(array_values(array_unique($ids)), 0, self::MAX_IMAGES);

			if ($ids) {
				$images = API::Image()->get([
					'output' => ['imageid', 'name'],
					'imageids' => $ids,
					'select_image' => true
				]);

				foreach ($images as $image) {
					$backup['images'][$image['imageid']] = ['name' => $image['name'], 'image' => $image['image']];
				}
			}
		}

		return $backup;
	}

	/**
	 * Lee el archivo subido. Devuelve [respaldo, error].
	 */
	public static function parse(string $text): array {
		// El archivo descargado empieza con la marca BOM (para Excel); se quita antes de leer.
		$data = json_decode(preg_replace('/^\xEF\xBB\xBF/', '', $text), true);

		if (!is_array($data) || (int) ($data[self::MARK] ?? 0) !== self::FORMAT || !is_array($data['config'] ?? null)) {
			return [null, I18n::t('El archivo no es un respaldo de LAKA Infra 3D.')];
		}

		return [$data, null];
	}

	/**
	 * Resumen para la vista previa: salas, racks, equipos, objetos, cables, sitios, modelos y fotos.
	 */
	public static function summary(array $config, array $images = []): array {
		$rooms = [];

		foreach (array_keys(array_merge((array) ($config['rooms'] ?? []), (array) ($config['cables'] ?? []))) as $key) {
			$room = Layout::normalize($config['rooms'][$key] ?? []);
			$rooms[] = [
				'key' => (string) $key,
				'racks' => count($room['racks']),
				'devices' => count($room['placements']) + count($room['passives']),
				'objects' => count($room['objects']),
				'cables' => count((array) ($config['cables'][$key]['list'] ?? []))
			];
		}

		return [
			'rooms' => $rooms,
			'sites' => count((array) ($config['sites'] ?? [])),
			'models' => count((array) ($config['models'] ?? [])),
			'images' => count($images),
			'acl' => count((array) ($config['acl'] ?? []))
		];
	}

	/**
	 * Configuración limpia a partir del respaldo. $mode: 'replace' (todo como en el archivo) o 'merge' (las salas,
	 * sitios y modelos del archivo reemplazan a los del mismo nombre; el resto se conserva).
	 * Devuelve [config, cantidad de fotos recreadas].
	 */
	public static function restore(array $backup, array $current, string $mode): array {
		$in = $backup['config'];
		$out = $mode === 'merge' ? $current : [];
		unset($out['history']);
		$out['history'] = $current['history'] ?? [];
		$user = (string) (CWebUser::$data['username'] ?? CWebUser::$data['alias'] ?? '');

		// Salas: mismo normalizador del editor. La revisión sube para que un editor abierto avise del conflicto.
		foreach (array_slice((array) ($in['rooms'] ?? []), 0, self::MAX_ROOMS, true) as $key => $room) {
			$key = Layout::roomKey((string) $key === Layout::DEFAULT_ROOM ? '' : (string) $key);
			$layout = Layout::normalize(is_array($room) ? $room : []);
			$layout['rev'] = (int) ($current['rooms'][$key]['rev'] ?? 0) + 1;
			$layout['updated'] = time();
			$layout['user'] = $user;
			$out['rooms'][$key] = Layout::compact($layout);
		}

		// Cableado: mismo normalizador de CableSave.
		foreach (array_slice((array) ($in['cables'] ?? []), 0, self::MAX_ROOMS, true) as $key => $room) {
			$key = Layout::roomKey((string) $key === Layout::DEFAULT_ROOM ? '' : (string) $key);
			$room = CableSave::normalize($room);
			$room['rev'] = (int) ($current['cables'][$key]['rev'] ?? 0) + 1;
			$out['cables'][$key] = $room;
		}

		// Sitios: nombre y coordenadas válidas.
		foreach (array_slice((array) ($in['sites'] ?? []), 0, self::MAX_SITES, true) as $name => $site) {
			$name = mb_substr(trim((string) $name), 0, 64);
			$lat = $site['lat'] ?? null;
			$lon = $site['lon'] ?? null;

			if ($name !== '' && is_numeric($lat) && is_numeric($lon) && abs((float) $lat) <= 90 && abs((float) $lon) <= 180) {
				$out['sites'][$name] = ['lat' => round((float) $lat, 5), 'lon' => round((float) $lon, 5)];
			}
		}

		// Mapa: país con su archivo de contorno y alcance conocido.
		if (is_array($in['map'] ?? null)) {
			$country = strtoupper((string) ($in['map']['country'] ?? ''));
			$scope = (string) ($in['map']['scope'] ?? 'country');

			if (($country === '' || (preg_match('/^[A-Z]{2}$/', $country) && is_file(dirname(__DIR__).'/data/geo/'.$country.'.json')))
					&& in_array($scope, ['country', 'city', 'world'], true)) {
				$out['map'] = ['country' => $country, 'scope' => $scope];
			}
		}

		// Modelos: cantidad, perfil y fotos (recreadas desde el respaldo o, si existen en este Zabbix, conservadas).
		[$models, $created] = self::models((array) ($in['models'] ?? []), (array) ($backup['images'] ?? []));

		foreach ($models as $key => $model) {
			$out['models'][$key] = $model;
		}

		// Permisos por sala: solo grupos de usuarios que existen en este Zabbix.
		$groups = [];

		foreach ((array) ($in['acl'] ?? []) as $ids) {
			foreach ((array) $ids as $id) {
				$groups[] = (string) $id;
			}
		}

		$valid = $groups
			? array_map('strval', array_column(API::UserGroup()->get(['output' => ['usrgrpid'], 'usrgrpids' => array_unique($groups)]), 'usrgrpid'))
			: [];

		foreach ((array) ($in['acl'] ?? []) as $key => $ids) {
			$ids = array_values(array_intersect(array_map('strval', (array) $ids), $valid));
			$key = Layout::roomKey((string) $key === Layout::DEFAULT_ROOM ? '' : (string) $key);

			if ($ids) {
				$out['acl'][$key] = $ids;
			}
		}

		foreach (['rooms', 'cables', 'sites', 'models', 'acl', 'history'] as $k) {
			if (array_key_exists($k, $out) && $out[$k] === []) {
				unset($out[$k]);
			}
		}

		return [$out, $created];
	}

	private static function models(array $models, array $images): array {
		$out = [];
		$created = 0;
		$cache = [];

		foreach (array_slice($models, 0, ModelSave::MAX_MODELS, true) as $key => $model) {
			$key = mb_substr(trim((string) $key), 0, 128);

			if ($key === '' || !is_array($model)) {
				continue;
			}

			$clean = ['n' => max(1, min(20, (int) ($model['n'] ?? 1)))];

			if (is_string($model['p'] ?? null) && ModelSave::profile($model['p']) !== '') {
				$clean['p'] = ModelSave::profile($model['p']);
			}

			foreach (['f', 'b'] as $side) {
				$id = (string) ($model[$side] ?? '');

				if ($id === '' || !ctype_digit($id)) {
					continue;
				}

				if (!array_key_exists($id, $cache)) {
					$cache[$id] = self::image($id, $images[$id] ?? null, $created);
				}

				if ($cache[$id] !== null) {
					$clean[$side] = $cache[$id];
				}
			}

			$out[$key] = $clean;
		}

		return [$out, $created];
	}

	/**
	 * Foto de un modelo: si el respaldo trae la imagen, se crea en este Zabbix (solo Super admin puede);
	 * si no, se conserva el id solo si la imagen existe aquí.
	 */
	private static function image(string $id, ?array $image, int &$created): ?string {
		if (is_array($image) && is_string($image['image'] ?? null) && $image['image'] !== '') {
			$name = mb_substr('LAKA3D '.preg_replace('/^LAKA3D\s*/', '', (string) ($image['name'] ?? 'foto')), 0, 58).' '.substr(uniqid(), -5);

			try {
				$result = API::Image()->create([['name' => $name, 'imagetype' => IMAGE_TYPE_BACKGROUND, 'image' => $image['image']]]);
			}
			catch (\Throwable $e) {
				$result = false;
			}

			if ($result && !empty($result['imageids'])) {
				$created++;

				return (string) $result['imageids'][0];
			}

			get_and_clear_messages();

			return null;
		}

		$exists = API::Image()->get(['output' => ['imageid'], 'imageids' => [$id]]);

		return $exists ? $id : null;
	}
}
