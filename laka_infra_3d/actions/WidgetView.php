<?php declare(strict_types = 0);
/*
 * LAKA Infra 3D – gemelo digital de data center para Zabbix 7.0 – 8.0
 * © LAKA Soluciones Tecnológicas
 * Autor: Willian Tola
 * Licencia GPLv3
 *
 * Controlador del widget. Junta la distribución guardada por el editor con los tags de ubicación
 * de los hosts, lee los problemas activos y los ítems de temperatura y CPU, y arma la sala
 * (racks + equipos) para la vista 3D.
 */

namespace Modules\LakaInfra3D\Actions;

use API,
	CControllerDashboardWidgetView,
	CControllerResponseData,
	CCsrfTokenHelper,
	CSettingsHelper,
	DB,
	CWebUser;

use Modules\LakaInfra3D\Includes\{
	Config,
	History,
	I18n,
	Layout,
	WidgetForm,
	WorkOrders
};

class WidgetView extends CControllerDashboardWidgetView {

	private ?array $module_config = null;


	// Límites de seguridad para no sobrecargar el frontend.
	private const MAX_HOSTS = 3000;
	private const MAX_UNPLACED = 2000;
	private const MAX_PROBLEMS = 5000;
	private const MAX_PROBLEMS_PER_HOST = 5;

	protected function doAction(): void {
		$lang = I18n::setLanguage((int) $this->fields_values['lang']);

		$data = [
			'name' => $this->getInput('name', $this->widget->getDefaultName()),
			'user' => [
				'debug_mode' => $this->getDebugMode()
			]
		];

		$tags = $this->getTagNames();
		$room = (string) $this->fields_values['room'];
		$room_key = Layout::roomKey($room);
		$layout = $this->getLayout($room_key);
		// Editar: Administrador o Super admin, y además el permiso de la sala (grupos de usuarios, si tiene).
		$can_edit = !$this->isTemplateDashboard() && $this->getUserType() >= USER_TYPE_ZABBIX_ADMIN
			&& Config::canEditRoom($this->moduleConfig(), $room_key);

		[$hosts, $unplaced, $object_hosts, $tag_rooms] = $this->getHosts($tags, $layout);
		$sites = $this->getSites($room_key, $tag_rooms);

		// Racks: los del campo de texto (versión 0.1) y los del editor, que mandan si se repite el nombre.
		$racks_def = [];

		foreach (Layout::parseRacksText((string) $this->fields_values['racks_def']) as $rack) {
			$racks_def[mb_strtolower($rack['name'])] = $rack;
		}

		foreach ($layout['racks'] as $rack) {
			$racks_def[mb_strtolower($rack['name'])] = $rack;
		}

		$passives = array_merge(Layout::parsePassivesText((string) $this->fields_values['passives']),
			$layout['passives']
		);

		$editor = $can_edit ? [
			'room_key' => $room_key,
			'layout' => $layout,
			'unplaced' => array_slice($unplaced, 0, self::MAX_UNPLACED),
			'unplaced_total' => count($unplaced),
			'csrf' => CCsrfTokenHelper::get('laka_infra_3d.layout.save'),
			'save_url' => 'zabbix.php?action=laka_infra_3d.layout.save',
			'search_url' => 'zabbix.php?action=laka_infra_3d.hosts.search',
			'site_url' => 'zabbix.php?action=laka_infra_3d.site.save',
			// Uso de module.config según la base de Zabbix (MySQL / MariaDB o PostgreSQL).
			'storage' => Config::stats($this->moduleConfig()),
			// Historial de cambios de la sala, permiso por sala y respaldo completo (0.21.0).
			'admin' => $this->getAdminData($room_key),
			// Vecinos LLDP / CDP para validar el cableado (plantilla LAKA LLDP CDP by SNMP).
			'lldp_url' => 'zabbix.php?action=laka_infra_3d.lldp.get',
			'site_csrf' => CCsrfTokenHelper::get('laka_infra_3d.site.save'),
			'object_hosts' => array_values(array_map(static fn(array $h): array => [
				'id' => (string) $h['hostid'], 'name' => $h['name'], 'host' => $h['host']
			], $object_hosts))
		] : null;

		if (!$hosts && !$racks_def && !$passives && !$layout['objects']) {
			$data['vars'] = [
				'empty' => true,
				'i18n' => I18n::forJs(),
				'lang' => $lang,
				'tags' => $tags,
				'editor' => $editor,
				'sites' => $sites,
				'geomap' => $this->getGeomapConfig(),
				'room' => $room,
				'site' => $layout['site']
			];

			$this->setResponse(new CControllerResponseData($data));

			return;
		}

		$hostids = array_keys($hosts);
		$problems = $this->getProblems(array_values(array_unique(array_merge(array_map('strval', $hostids),
			array_map('strval', array_keys($object_hosts))
		))));
		$temps = $this->getItemValues($hostids, (string) $this->fields_values['temp_key']);
		$clocks = [];
		$cpus = $this->getItemValues($hostids, (string) $this->fields_values['cpu_key'], $clocks['cpu']);
		$mems = $this->getItemValues($hostids, (string) $this->fields_values['mem_key'], $clocks['mem']);

		$rack_units = (int) $this->fields_values['rack_units'];
		$warnings = [];
		$devices = [];

		foreach ($hosts as $hostid => $host) {
			$loc = $host['loc'];

			$device = [
				'id' => (string) $hostid,
				'key' => (string) $hostid,
				'name' => $host['name'],
				'host' => $host['host'],
				'rack' => $loc['rack'],
				'u' => $loc['u'],
				'n' => max(1, min(20, $loc['size'])),
				'face' => $loc['face'],
				'row' => $loc['row'],
				'type' => $loc['type'],
				'src' => $loc['src'],
				'maint' => (int) $host['maintenance_status'] === 1,
				'sev' => -1,
				'problems' => [],
				'temp' => $temps[$hostid] ?? null,
				'cpu' => $cpus[$hostid] ?? null,
				'mem' => $mems[$hostid] ?? null,
				// Hora del último valor de CPU y RAM (para avisar si es viejo).
				'cpu_clock' => $clocks['cpu'][$hostid] ?? null,
				'mem_clock' => $clocks['mem'][$hostid] ?? null,
				'avail' => self::availability($host),
				'w' => (int) ($loc['w'] ?? 0),
				'kg' => (float) ($loc['kg'] ?? 0),
				'inv' => self::inventory($host)
			];

			if (array_key_exists($hostid, $problems)) {
				$device['sev'] = $problems[$hostid]['sev'];
				$device['problems'] = $problems[$hostid]['list'];
				$device['pcount'] = $problems[$hostid]['count'];
			}

			if ($device['u'] === null) {
				$warnings[] = sprintf(I18n::t('%1$s no tiene el tag de U; se ubicó en el primer espacio libre.'),
					$host['name']
				);
			}

			$devices[] = $device;
		}

		foreach ($passives as $i => $passive) {
			$devices[] = [
				'id' => 'p'.($i + 1),
				// Id estable para el cableado: rack, U y cara (dos pasivos no comparten U en la misma cara).
				'key' => 'p:'.mb_strtolower(mb_substr($passive['rack'], 0, 32)).':'.(int) $passive['u'].':'
					.(($passive['face'] ?? 'front') === 'back' ? 'back' : 'front'),
				'passive' => true,
				'name' => $passive['name'] !== '' ? mb_substr($passive['name'], 0, 64) : 'patch-'.($i + 1),
				'host' => '',
				'rack' => mb_substr($passive['rack'], 0, 32),
				'u' => $passive['u'],
				'n' => max(1, min(20, (int) $passive['n'])),
				'face' => $passive['face'] ?? 'front',
				'row' => '',
				'type' => in_array($passive['type'], Layout::TYPES, true) ? $passive['type'] : 'patch',
				'src' => 'passive',
				'maint' => false,
				'sev' => -1,
				'problems' => [],
				'temp' => null,
				'cpu' => null,
				'mem' => null,
				'w' => (int) ($passive['w'] ?? 0),
				'kg' => (float) ($passive['kg'] ?? 0),
				'inv' => []
			];
		}

		$layout_mode = $layout['layout'] ?? (int) $this->fields_values['layout'];
		$racks = $this->buildRacks($devices, $racks_def, $rack_units, $layout['rows'], $layout_mode);

		// Aires, UPS modulares y gabinetes de baterías ocupan un lugar de la fila pero no llevan equipos.
		$slots = array_filter($racks, static fn(array $r): bool => $r['kind'] !== 'rack');
		$devices = array_values(array_filter($devices, static function (array $d) use ($slots, &$warnings): bool {
			if (array_key_exists($d['rack'], $slots)) {
				$warnings[] = sprintf(I18n::t('%1$s está ubicado en %2$s, que no es un rack.'), $d['name'], $d['rack']);

				return false;
			}

			return true;
		}));

		$this->placeDevices($devices, $racks, $warnings);
		$this->measurePower($racks, $devices, $problems);

		foreach ($layout['racks'] as $def) {
			if ($def['kind'] !== 'rack') {
				$layout['objects'][] = [
					'id' => 'row-'.substr(md5($def['name']), 0, 8),
					'kind' => $def['kind'] === 'cooler' ? ($def['model'] === 'crac' ? 'crac' : 'inrow') : $def['kind'],
					'name' => $def['name'], 'x' => 0, 'z' => 0, 'rot' => 0, 'rack' => $def['name'],
					'level' => 'top', 'face' => 'front', 'hostid' => $def['hostid'], 'key' => $def['key'], 'mount' => 'row',
					'wall' => 'n', 'offset' => 0, 'height' => 0, 'hinge' => 'l', 'leaves' => 1, 'size' => 1, 'batt' => 0
				];
			}
		}

		$objects = $this->buildObjects($layout['objects'], $object_hosts + $hosts, $problems);

		$stats = ['total' => 0, 'by_sev' => array_fill(-1, 7, 0), 'unplaced' => count($unplaced),
			'objects' => count($objects)
		];

		foreach ($devices as $device) {
			if (!array_key_exists('passive', $device)) {
				$stats['total']++;
				$stats['by_sev'][$device['sev']]++;
			}
		}

		$focus = null;

		if ($this->fields_values['override_hostid']) {
			$focus = (string) reset($this->fields_values['override_hostid']);
		}

		$cfg = [
			'layout' => $layout_mode,
			'racks_per_row' => (int) $this->fields_values['racks_per_row'],
			'rack_units' => $rack_units,
			'mode' => [WidgetForm::MODE_HEAT => 'heat', WidgetForm::MODE_CAPACITY => 'capacity']
				[(int) $this->fields_values['view_mode']] ?? 'status',
			// Estilo de colores elegido en la configuración del widget.
			'style' => (int) $this->fields_values['color_style'] === WidgetForm::STYLE_VIVID ? 'vivid' : 'zabbix',
			'labels' => (bool) $this->fields_values['show_labels'],
			'auto_rotate' => (bool) $this->fields_values['auto_rotate'],
			'room' => $room,
			'site' => $layout['site'],
			'aisle' => $layout['aisle'] ?? ((int) $this->fields_values['aisle'] === 1 ? 'hot' : 'cold'),
			'aisle_default' => (int) $this->fields_values['aisle'] === 1 ? 'hot' : 'cold',
			'contain' => $layout['contain'],
			'flips' => $layout['flips'],
			'room_size' => $layout['room'],
			'temp_key' => (string) $this->fields_values['temp_key'],
			'power_key' => (string) $this->fields_values['power_key'],
			'hum_key' => (string) $this->fields_values['hum_key'],
			// PUE y ASHRAE de la sala; dirección para el PUE por período (tendencias de Zabbix).
			'energy' => $layout['energy'] ?? Layout::energy([]),
			'energy_url' => 'zabbix.php?action=laka_infra_3d.energy.get',
			'forecast_url' => 'zabbix.php?action=laka_infra_3d.capacity.forecast',
			// Órdenes de trabajo de la sala (todos las ven; las crea quien puede editar la sala).
			'wo' => WorkOrders::list($this->moduleConfig(), $room_key),
			'wo_room' => $room_key,
			'wo_url' => $can_edit ? 'zabbix.php?action=laka_infra_3d.wo.save' : '',
			'wo_csrf' => $can_edit ? CCsrfTokenHelper::get('laka_infra_3d.wo.save') : '',
			// Base para los enlaces de los códigos QR de equipos (vista Últimos datos de Zabbix).
			'host_url' => 'zabbix.php?action=latest.view&filter_set=1&hostids%5B%5D=',
			'noc' => [
				'autostart' => (bool) $this->fields_values['noc_autostart'],
				'cycle' => max(5, min(120, (int) $this->fields_values['noc_cycle'])),
				'min_sev' => (int) $this->fields_values['noc_min_sev'],
				'sound' => (bool) $this->fields_values['noc_sound']
			]
		];

		$data['vars'] = [
			'empty' => false,
			'lang' => $lang,
			'i18n' => I18n::forJs(),
			'cfg' => $cfg,
			'racks' => array_values($racks),
			'devices' => $devices,
			'objects' => $objects,
			'stats' => $stats,
			'warnings' => array_slice($warnings, 0, 20),
			'sites' => $sites,
			'geomap' => $this->getGeomapConfig(),
			'focus' => $focus,
			// Firma de la disposición: si no cambia, el JS solo actualiza colores y datos.
			'sig' => md5(json_encode([
				// La potencia medida cambia en cada lectura: no forma parte de la firma.
				array_map(static fn($r) => array_diff_key($r, ['power_w' => 1, 'pdu_count' => 1, 'pdu_sev' => 1]),
					array_values($racks)
				),
				array_map(static fn($d) => [$d['id'], $d['rack'], $d['u'], $d['n'], $d['face'], $d['type']], $devices),
				$layout_mode,
				$cfg['labels'],
				array_map(static fn($o) => [$o['id'], $o['kind'], $o['x'], $o['z'], $o['rot'], $o['rack'], $o['level'],
					$o['face'], $o['mount'], $o['wall'], $o['offset'], $o['height'], $o['hinge'], $o['leaves'],
					$o['size'], $o['batt']
				], $objects),
				$layout['room'],
				[$cfg['aisle'], $cfg['contain'], $cfg['flips']]
			])),
			'severities' => self::getSeverities(),
			'links' => [
				'problems' => 'zabbix.php?action=problem.view&filter_set=1&hostids%5B%5D=',
				'latest' => 'zabbix.php?action=latest.view&filter_set=1&hostids%5B%5D=',
				'graphs' => 'zabbix.php?action=charts.view&filter_set=1&filter_hostids%5B%5D=',
				'host' => 'zabbix.php?action=host.list&filter_set=1&filter_host='
			],
			'editor' => $editor,
			// Cableado de la sala y perfiles de modelos para la vista del equipo.
			'cabling' => $this->getCabling($room_key),
			'models' => $this->getModels(),
			'devapi' => [
				'detail_url' => 'zabbix.php?action=laka_infra_3d.device.detail',
				'img_url' => 'imgstore.php?iconid=',
				'room_key' => $room_key,
				'can_edit' => $can_edit,
				'is_super' => $this->getUserType() == USER_TYPE_SUPER_ADMIN,
				'cable_url' => $can_edit ? 'zabbix.php?action=laka_infra_3d.cable.save' : '',
				'cable_csrf' => $can_edit ? CCsrfTokenHelper::get('laka_infra_3d.cable.save') : '',
				'model_url' => $can_edit ? 'zabbix.php?action=laka_infra_3d.model.save' : '',
				'model_csrf' => $can_edit ? CCsrfTokenHelper::get('laka_infra_3d.model.save') : ''
			],
			'time' => time()
		];

		$this->setResponse(new CControllerResponseData($data));
	}

	/**
	 * Cableado guardado de la sala (module.config → cables).
	 */
	private function getCabling(string $room_key): array {
		$config = $this->moduleConfig();
		$all = is_array($config['cables'] ?? null) ? $config['cables'] : [];

		return CableSave::normalize($all[$room_key] ?? []);
	}

	/**
	 * Perfiles de hardware y fotos por modelo (module.config → models).
	 */
	private function getModels(): array {
		$config = $this->moduleConfig();
		$models = is_array($config['models'] ?? null) ? $config['models'] : [];

		return array_filter($models, 'is_array');
	}

	/**
	 * Distribución guardada para la sala (configuración del módulo en la base de datos de Zabbix).
	 */
	/**
	 * Datos del editor para la pestaña "Historial y respaldo": historial de la sala, grupos con permiso de
	 * edición (con nombre) y, para Super admin, la lista de grupos de usuarios y las direcciones del respaldo.
	 */
	private function getAdminData(string $room_key): array {
		$config = $this->moduleConfig();
		$super = $this->getUserType() == USER_TYPE_SUPER_ADMIN;
		$editors = Config::roomEditors($config, $room_key);
		$groups = [];

		if ($super) {
			$groups = API::UserGroup()->get(['output' => ['usrgrpid', 'name'], 'sortfield' => 'name', 'limit' => 1000]);
		}
		elseif ($editors) {
			$groups = DB::select('usrgrp', ['output' => ['usrgrpid', 'name'], 'usrgrpids' => $editors]);
		}

		return [
			'is_super' => $super,
			'history' => History::forClient($config, $room_key),
			'history_url' => 'zabbix.php?action=laka_infra_3d.room.history',
			'history_csrf' => CCsrfTokenHelper::get('laka_infra_3d.room.history'),
			'editors' => $editors,
			'groups' => array_map(static fn(array $g): array => ['id' => (string) $g['usrgrpid'], 'name' => $g['name']], $groups),
			'acl_url' => $super ? 'zabbix.php?action=laka_infra_3d.room.acl' : '',
			'acl_csrf' => $super ? CCsrfTokenHelper::get('laka_infra_3d.room.acl') : '',
			'backup_url' => $super ? 'zabbix.php?action=laka_infra_3d.backup' : '',
			'backup_csrf' => $super ? CCsrfTokenHelper::get('laka_infra_3d.backup') : ''
		];
	}

	private function getLayout(string $room_key): array {
		$config = $this->moduleConfig();
		$rooms = is_array($config['rooms'] ?? null) ? $config['rooms'] : [];

		return Layout::normalize($rooms[$room_key] ?? []);
	}

	/**
	 * Hosts con ubicación (por el editor o por tags) y hosts de los grupos elegidos que aún no tienen ubicación.
	 * Sin grupos ni hosts elegidos, se leen solo los hosts con tag de rack y los ubicados en el editor.
	 */
	private function getHosts(array $tags, array $layout): array {
		$options = [
			'output' => ['hostid', 'host', 'name', 'maintenance_status', 'active_available'],
			'selectInterfaces' => ['type', 'available', 'error'],
			'selectTags' => ['tag', 'value'],
			// Inventario de Zabbix, con las fechas del ciclo de vida del hardware (compra, instalación,
			// fin de garantía y retiro).
			'selectInventory' => ['type', 'vendor', 'model', 'serialno_a', 'os', 'location', 'asset_tag',
				'date_hw_purchase', 'date_hw_install', 'date_hw_expiry', 'date_hw_decomm'
			],
			'monitored_hosts' => true,
			'preservekeys' => true,
			'limit' => self::MAX_HOSTS
		];

		$placed_ids = array_map('strval', array_keys($layout['placements']));
		$object_ids = array_values(array_unique(array_map('strval', array_filter(array_merge(
			array_column($layout['objects'], 'hostid'),
			array_column($layout['racks'], 'hostid'),
			array_merge([], ...array_column($layout['racks'], 'pdus'))
		)))));

		if ($this->isTemplateDashboard()) {
			if (!$this->fields_values['override_hostid']) {
				return [[], [], []];
			}

			$hosts = API::Host()->get($options + ['hostids' => $this->fields_values['override_hostid']]);
		}
		elseif ($this->fields_values['groupids'] || $this->fields_values['hostids']) {
			if ($this->fields_values['groupids']) {
				$options['groupids'] = $this->fields_values['groupids'];
			}

			if ($this->fields_values['hostids']) {
				$options['hostids'] = $this->fields_values['hostids'];
			}

			$hosts = API::Host()->get($options);
		}
		else {
			$hosts = API::Host()->get($options + [
				'evaltype' => TAG_EVAL_TYPE_AND_OR,
				'tags' => [['tag' => $tags['rack'], 'operator' => TAG_OPERATOR_EXISTS, 'value' => '']]
			]);
		}

		// Hosts ubicados en el editor o vinculados a la infraestructura que no vinieron en la consulta principal.
		$missing = array_diff(array_merge($placed_ids, $object_ids), array_map('strval', array_keys($hosts)));

		if ($missing && !$this->isTemplateDashboard()) {
			unset($options['groupids'], $options['hostids'], $options['evaltype'], $options['tags']);
			$hosts += API::Host()->get($options + ['hostids' => array_values($missing)]);
		}

		$room = mb_strtolower(trim((string) $this->fields_values['room']));
		$located = [];
		$unplaced = [];
		$object_hosts = [];
		$tag_rooms = [];

		foreach ($hosts as $hostid => $host) {
			$hostid = (string) $hostid;

			if (in_array($hostid, $object_ids, true)) {
				$object_hosts[$hostid] = $host;
			}

			if (array_key_exists($hostid, $layout['placements'])) {
				$place = $layout['placements'][$hostid];
				$host['loc'] = [
					'rack' => $place['rack'],
					'u' => $place['u'],
					'size' => $place['n'],
					'face' => $place['face'],
					'row' => '',
					'type' => $place['type'],
					'src' => 'layout',
					'w' => $place['w'] ?? 0,
					'kg' => $place['kg'] ?? 0
				];
				$located[$hostid] = $host;

				continue;
			}

			$loc = self::location($host, $tags);

			// Hosts ubicados por tags en cada sala (para el resumen de sitios y salas).
			if ($loc !== null) {
				$tag_rooms[mb_strtolower(trim($loc['room']))][] = $hostid;
			}

			if ($loc !== null && ($room === '' || mb_strtolower($loc['room']) === $room)) {
				$loc['src'] = 'tag';
				$host['loc'] = $loc;
				$located[$hostid] = $host;
			}
			elseif ($loc === null && !array_key_exists($hostid, $object_hosts)) {
				$unplaced[] = [
					'id' => $hostid,
					'name' => $host['name'],
					'host' => $host['host'],
					'type' => Layout::normalizeType('', self::hostText($host))
				];
			}
		}

		usort($unplaced, static fn(array $a, array $b): int => strnatcasecmp($a['name'], $b['name']));

		return [$located, $unplaced, $object_hosts, $tag_rooms];
	}

	/**
	 * Sitios (regiones) y sus salas con un resumen de estado: equipos, racks, problemas y severidad más alta.
	 * Incluye las salas guardadas en el editor y las que solo existen por el tag de sala de los hosts.
	 */
	private function getSites(string $current_key, array $tag_rooms): array {
		$config = $this->moduleConfig();
		$saved = is_array($config['rooms'] ?? null) ? $config['rooms'] : [];
		$rooms = [];

		foreach ($saved as $key => $raw) {
			$key = (string) $key;
			$layout = Layout::normalize($raw);
			$ids = array_merge(array_map('strval', array_keys($layout['placements'])),
				array_column($layout['objects'], 'hostid'), array_column($layout['racks'], 'hostid'),
				array_merge([], ...array_column($layout['racks'], 'pdus'))
			);

			$rooms[mb_strtolower($key === Layout::DEFAULT_ROOM ? '' : $key)] = [
				'key' => $key,
				'name' => $key === Layout::DEFAULT_ROOM ? '' : $key,
				'site' => $layout['site'],
				'racks' => count(array_filter($layout['racks'], static fn($r) => $r['kind'] === 'rack')),
				'devices' => count($layout['placements']) + count($layout['passives']),
				'ids' => $ids
			];
		}

		foreach ($tag_rooms as $name => $ids) {
			if (!array_key_exists($name, $rooms)) {
				$rooms[$name] = ['key' => Layout::roomKey($name), 'name' => $name, 'site' => '', 'racks' => 0,
					'devices' => 0, 'ids' => []
				];
			}

			$rooms[$name]['ids'] = array_merge($rooms[$name]['ids'], $ids);
			$rooms[$name]['devices'] += count($ids);
		}

		// La sala actual siempre aparece, aunque todavía no tenga nada guardado.
		$current = mb_strtolower($current_key === Layout::DEFAULT_ROOM ? '' : $current_key);

		if (!array_key_exists($current, $rooms)) {
			$rooms[$current] = ['key' => $current_key, 'name' => $current_key === Layout::DEFAULT_ROOM ? '' : $current_key,
				'site' => '', 'racks' => 0, 'devices' => 0, 'ids' => []
			];
		}

		$all = array_values(array_unique(array_filter(array_map('strval', array_merge([], ...array_column($rooms, 'ids'))))));
		$problems = count($rooms) > 1 ? $this->getProblems($all) : [];
		$sites = [];

		foreach ($rooms as $room) {
			$ids = array_values(array_unique(array_filter(array_map('strval', $room['ids']))));
			$by_sev = array_fill(0, 6, 0);
			$sev = -1;
			$count = 0;

			foreach ($ids as $id) {
				if (array_key_exists($id, $problems) && $problems[$id]['sev'] >= 0) {
					$by_sev[$problems[$id]['sev']]++;
					$sev = max($sev, $problems[$id]['sev']);
					$count += $problems[$id]['count'];
				}
			}

			unset($room['ids']);
			$sites[$room['site']][] = $room + ['sev' => $sev, 'pcount' => $count, 'by_sev' => $by_sev,
				'current' => mb_strtolower($room['key']) === mb_strtolower($current_key)
			];
		}

		ksort($sites, SORT_NATURAL | SORT_FLAG_CASE);
		$coords = is_array($config['sites'] ?? null) ? $config['sites'] : [];
		$out = [];

		foreach ($sites as $site => $list) {
			usort($list, static fn($a, $b) => strnatcasecmp($a['name'], $b['name']));
			$c = $coords[(string) $site] ?? null;
			$out[] = ['name' => (string) $site, 'rooms' => $list,
				// Ubicación guardada en el mapa (null = se sugiere por el nombre del sitio en el navegador).
				'lat' => is_array($c) && is_numeric($c['lat'] ?? null) ? (float) $c['lat'] : null,
				'lon' => is_array($c) && is_numeric($c['lon'] ?? null) ? (float) $c['lon'] : null
			];
		}

		return $out;
	}

	/**
	 * Mapa base de Zabbix (Administración → General → Mapas geográficos), igual que el widget Geomap.
	 */
	/**
	 * Configuración del módulo ya descomprimida (Config::decode), leída una vez por pedido. Zabbix la entrega
	 * desde module.config tal como se guardó: comprimida ({"format": 2, "z": ...}) o, si es vieja, sin comprimir.
	 */
	private function moduleConfig(): array {
		if ($this->module_config === null) {
			$this->module_config = Config::decode($this->widget->getConfig());
		}

		return $this->module_config;
	}

	/**
	 * Mapa base de Zabbix más el enfoque guardado del mapa de sitios: país resaltado (ISO alfa-2) y alcance
	 * (país o ciudad), y la dirección que entrega el contorno del país.
	 */
	private function getGeomapConfig(): array {
		$config = $this->moduleConfig();
		$map = is_array($config['map'] ?? null) ? $config['map'] : [];
		$country = is_string($map['country'] ?? null) && preg_match('/^[A-Z]{2}$/', $map['country']) ? $map['country'] : '';

		return self::getTileConfig() + [
			'country' => $country,
			'scope' => in_array($map['scope'] ?? '', ['country', 'city', 'world'], true) ? $map['scope'] : 'country',
			'geo_url' => 'zabbix.php?action=laka_infra_3d.geo.country'
		];
	}

	private static function getTileConfig(): array {
		try {
			$provider = (string) CSettingsHelper::get(CSettingsHelper::GEOMAPS_TILE_PROVIDER);

			if ($provider === '') {
				return [
					'tile_url' => (string) CSettingsHelper::get(CSettingsHelper::GEOMAPS_TILE_URL),
					'max_zoom' => (int) CSettingsHelper::get(CSettingsHelper::GEOMAPS_MAX_ZOOM),
					// Igual que el widget Geomap: la atribución escrita a mano se muestra como texto.
					'attribution' => htmlspecialchars((string) CSettingsHelper::get(CSettingsHelper::GEOMAPS_ATTRIBUTION),
						ENT_NOQUOTES, 'UTF-8'
					)
				];
			}

			$providers = function_exists('getTileProviders') ? getTileProviders() : [];
			$tile = $providers[$provider] ?? reset($providers);

			return $tile ? [
				'tile_url' => $tile['geomaps_tile_url'],
				'max_zoom' => (int) $tile['geomaps_max_zoom'],
				'attribution' => $tile['geomaps_attribution']
			] : ['tile_url' => '', 'max_zoom' => 18, 'attribution' => ''];
		}
		catch (\Throwable $e) {
			return ['tile_url' => '', 'max_zoom' => 18, 'attribution' => ''];
		}
	}

	private static function hostText(array $host): string {
		return $host['host'].' '.$host['name'].' '
			.(is_array($host['inventory']) ? ($host['inventory']['type'] ?? '') : '');
	}

	/**
	 * Racks de la sala: los definidos (editor o campo de texto) más los que aparecen en los equipos.
	 * Asigna fila y posición: definida, por tag de fila o automática en orden natural.
	 */
	private function buildRacks(array $devices, array $racks_def, int $default_units, array $rows_order,
			int $layout_mode): array {
		$racks = [];

		foreach ($racks_def as $def) {
			$racks[$def['name']] = [
				'name' => $def['name'],
				'units' => $def['units'] >= 4 ? min(60, $def['units']) : $default_units,
				'kind' => $def['kind'] ?? 'rack',
				'width' => (float) ($def['width'] ?? 0.6),
				'power_kw' => (float) ($def['power_kw'] ?? 0),
				'max_kg' => (int) ($def['max_kg'] ?? 0),
				'pdus' => $def['pdus'] ?? [],
				'model' => $def['model'] ?? '',
				'vpdu' => (int) ($def['vpdu'] ?? 0),
				'outlets' => (int) ($def['outlets'] ?? 0),
				'row' => $def['row'],
				'pos' => $def['pos'],
				'mount' => $def['mount'] ?? '',
				'wall' => $def['wall'] ?? 'n',
				'offset' => (float) ($def['offset'] ?? 0),
				'height' => (float) ($def['height'] ?? 0),
				'depth' => (float) ($def['depth'] ?? 0)
			];
		}

		foreach ($devices as $device) {
			$name = $device['rack'];

			if (!array_key_exists($name, $racks)) {
				$racks[$name] = ['name' => $name, 'units' => $default_units, 'row' => '', 'pos' => null, 'kind' => 'rack',
					'width' => 0.6, 'power_kw' => 0.0, 'max_kg' => 0, 'pdus' => [], 'model' => '', 'vpdu' => 0, 'outlets' => 0
				];
			}

			// La fila que declara un host vale para su rack si el rack no la tiene definida.
			if ($racks[$name]['row'] === '' && ($device['row'] ?? '') !== '') {
				$racks[$name]['row'] = $device['row'];
			}
		}

		uksort($racks, 'strnatcasecmp');

		$per_row = max(1, (int) $this->fields_values['racks_per_row']);
		$auto_index = 0;

		foreach ($racks as &$rack) {
			// Los racks de pared no van en filas: se ubican en su pared.
			if (($rack['mount'] ?? '') === 'wall') {
				continue;
			}

			if ($layout_mode === WidgetForm::LAYOUT_SINGLE) {
				$rack['row'] = '1';
			}
			elseif ($rack['row'] === '') {
				$rack['row'] = '#'.intdiv($auto_index, $per_row);
				$auto_index++;
			}
		}
		unset($rack);

		// Orden de las filas: primero el del editor, después orden natural.
		$rows = [];

		foreach ($racks as $name => $rack) {
			if (($rack['mount'] ?? '') === 'wall') {
				$racks[$name]['row_index'] = -1;
				$racks[$name]['index'] = 0;
				$racks[$name]['row_label'] = '';

				continue;
			}

			$rows[$rack['row']][] = $name;
		}

		$order = array_flip($rows_order);

		uksort($rows, static function ($a, $b) use ($order): int {
			$a = (string) $a;
			$b = (string) $b;
			$ia = $order[$a] ?? PHP_INT_MAX;
			$ib = $order[$b] ?? PHP_INT_MAX;

			return $ia === $ib ? strnatcasecmp($a, $b) : $ia <=> $ib;
		});

		$row_index = 0;

		foreach ($rows as $row => $names) {
			$row = (string) $row;

			usort($names, static function ($a, $b) use ($racks): int {
				$pa = $racks[$a]['pos'] ?? PHP_INT_MAX;
				$pb = $racks[$b]['pos'] ?? PHP_INT_MAX;

				return $pa === $pb ? strnatcasecmp((string) $a, (string) $b) : $pa <=> $pb;
			});

			foreach ($names as $i => $name) {
				$racks[$name]['row_index'] = $row_index;
				$racks[$name]['index'] = $i;
				$racks[$name]['row_label'] = $row[0] === '#' ? (string) ($row_index + 1) : $row;
			}

			$row_index++;
		}

		foreach ($racks as &$rack) {
			unset($rack['pos']);
		}
		unset($rack);

		return $racks;
	}

	/**
	 * Nombres y colores de severidad configurados en Zabbix (Administración › General › Opciones de triggers).
	 * Si el nombre es el de fábrica, se traduce al idioma del widget.
	 */
	private static function getSeverities(): array {
		$defaults = [
			'Not classified' => 'No clasificado',
			'Information' => 'Información',
			'Warning' => 'Advertencia',
			'Average' => 'Promedio',
			'High' => 'Alta',
			'Disaster' => 'Desastre'
		];
		$default_names = array_keys($defaults);
		$result = [];

		for ($i = 0; $i < 6; $i++) {
			$name = CSettingsHelper::get('severity_name_'.$i);
			$color = CSettingsHelper::get('severity_color_'.$i);

			$result[] = [
				'name' => $name === $default_names[$i] ? I18n::t($defaults[$name]) : $name,
				'color' => '#'.ltrim($color, '#')
			];
		}

		return $result;
	}

	/**
	 * Infraestructura de la sala con su estado: host vinculado, problemas y el valor del ítem que muestra.
	 * Si el objeto no indica clave, se usa una por tipo (temperatura, batería, potencia o puerta).
	 */
	private function buildObjects(array $objects, array $hosts, array $problems): array {
		if (!$objects) {
			return [];
		}

		$temp_key = (string) $this->fields_values['temp_key'];
		$defaults = [
			'crac' => $temp_key, 'inrow' => $temp_key, 'split' => $temp_key, 'sensor' => $temp_key,
			// Cámaras, lectores y sensores de movimiento: disponibilidad (plantilla ICMP Ping); detectores y
			// sensores de fuga: su estado; supresión: presión de los cilindros. El resto solo muestra problemas.
			'camera' => 'icmpping', 'access' => 'icmpping', 'motion' => 'icmpping', 'smoke' => '*smoke*',
			'vesda' => '*smoke*', 'firepanel' => '*alarm*', 'suppression' => '*pressure*', 'leak' => '*leak*',
			'extinguisher' => '', 'epo' => '', 'light' => '', 'ground' => '',
			// Cadena eléctrica: combustible del generador; transferencia y transformador, su estado de energía.
			'generator' => '*fuel*', 'ats' => '*power*', 'transformer' => '*power*',
			'ups' => '*battery*', 'battery' => '*battery*', 'panel' => '*power*', 'door' => '*door*',
			// Enfriamiento líquido: temperatura del agua de suministro (FWS) de la CDU y del intercambiador;
			// punto de acceso Wi-Fi: disponibilidad; medidor de agua y generación renovable.
			'cdu' => $temp_key, 'rdhx' => $temp_key, 'wap' => 'icmpping', 'water' => '*water*', 'solar' => '*power*'
		];

		// Se agrupan los hosts por patrón de clave para hacer una consulta por patrón.
		$by_pattern = [];

		foreach ($objects as $o) {
			if ($o['hostid'] !== '' && array_key_exists($o['hostid'], $hosts)) {
				$pattern = $o['key'] !== '' ? $o['key'] : $defaults[$o['kind']];
				$by_pattern[$pattern][$o['hostid']] = true;

				if ($o['kind'] === 'sensor') {
					$by_pattern[(string) $this->fields_values['hum_key']][$o['hostid']] = true;
				}
			}
		}

		$values = [];

		foreach ($by_pattern as $pattern => $hostids) {
			$values[$pattern] = $this->getItemInfo(array_keys($hostids), (string) $pattern);
		}

		$result = [];

		foreach ($objects as $o) {
			$host = $o['hostid'] !== '' ? ($hosts[$o['hostid']] ?? null) : null;
			$pattern = $o['key'] !== '' ? $o['key'] : $defaults[$o['kind']];
			$item = $host !== null ? ($values[$pattern][$o['hostid']] ?? null) : null;
			$hum = ($host !== null && $o['kind'] === 'sensor')
				? ($values[(string) $this->fields_values['hum_key']][$o['hostid']] ?? null)
				: null;

			$out = $o + [
				'host_name' => $host !== null ? $host['name'] : '',
				'host' => $host !== null ? $host['host'] : '',
				'linked' => $host !== null,
				'maint' => $host !== null && (int) $host['maintenance_status'] === 1,
				'sev' => -1,
				'pcount' => 0,
				'problems' => [],
				'value' => $item !== null ? $item['value'] : null,
				'units' => $item !== null ? $item['units'] : '',
				'item_name' => $item !== null ? $item['name'] : '',
				'hum' => $hum !== null ? $hum['value'] : null,
				'pattern' => $pattern
			];

			if ($host !== null && array_key_exists($o['hostid'], $problems)) {
				$out['sev'] = $problems[$o['hostid']]['sev'];
				$out['pcount'] = $problems[$o['hostid']]['count'];
				$out['problems'] = $problems[$o['hostid']]['list'];
			}

			$result[] = $out;
		}

		return $result;
	}

	/**
	 * Último valor numérico (el mayor, si hay varios ítems) con su unidad y nombre de ítem.
	 */
	private function getItemInfo(array $hostids, string $pattern): array {
		$pattern = trim($pattern);

		if (!$hostids || $pattern === '') {
			return [];
		}

		$items = API::Item()->get([
			'output' => ['itemid', 'hostid', 'name', 'lastvalue', 'lastclock', 'units'],
			'hostids' => $hostids,
			'search' => ['key_' => $pattern],
			'searchWildcardsEnabled' => true,
			'filter' => ['value_type' => [ITEM_VALUE_TYPE_FLOAT, ITEM_VALUE_TYPE_UINT64]],
			'monitored' => true,
			'webitems' => false,
			'limit' => count($hostids) * 20
		]);

		$result = [];

		foreach ($items as $item) {
			if ((int) $item['lastclock'] === 0 || !is_numeric($item['lastvalue'])) {
				continue;
			}

			$value = round((float) $item['lastvalue'], 1);
			$hostid = (string) $item['hostid'];

			if (!array_key_exists($hostid, $result) || $value > $result[$hostid]['value']) {
				$result[$hostid] = ['value' => $value, 'units' => (string) $item['units'], 'name' => $item['name']];
			}
		}

		return $result;
	}

	/**
	 * Nombres de los tags configurados en el formulario (en minúsculas, con su valor por defecto si quedó vacío).
	 */
	private function getTagNames(): array {
		$tags = [];

		foreach (WidgetForm::DEFAULT_TAGS as $field => $default) {
			$value = trim((string) $this->fields_values[$field]);
			$tags[substr($field, 4)] = mb_strtolower($value === '' ? $default : $value);
		}

		return $tags;
	}

	/**
	 * Lee la ubicación del host a partir de sus tags. Devuelve null si no tiene rack.
	 */
	private static function location(array $host, array $tags): ?array {
		$values = [];

		foreach ($host['tags'] as $tag) {
			$name = mb_strtolower(trim($tag['tag']));

			if (!array_key_exists($name, $values)) {
				$values[$name] = trim($tag['value']);
			}
		}

		$rack = $values[$tags['rack']] ?? '';

		if ($rack === '') {
			return null;
		}

		$u = $values[$tags['u']] ?? '';
		$size = $values[$tags['size']] ?? '';
		$face = mb_strtolower($values[$tags['face']] ?? '');

		return [
			'rack' => mb_substr($rack, 0, 32),
			'u' => ctype_digit($u) ? (int) $u : null,
			'size' => ctype_digit($size) ? (int) $size : 1,
			'face' => in_array($face, ['atras', 'atrás', 'back', 'trasera', 'posterior'], true) ? 'back' : 'front',
			'row' => mb_substr($values[$tags['row']] ?? '', 0, 16),
			'type' => Layout::normalizeType($values[$tags['type']] ?? '', self::hostText($host)),
			'room' => $values[$tags['room']] ?? ''
		];
	}

	private static function inventory(array $host): array {
		$inv = is_array($host['inventory']) ? $host['inventory'] : [];

		return [
			'vendor' => (string) ($inv['vendor'] ?? ''),
			'model' => (string) ($inv['model'] ?? ''),
			'serial' => (string) ($inv['serialno_a'] ?? ''),
			'os' => (string) ($inv['os'] ?? ''),
			'location' => (string) ($inv['location'] ?? ''),
			'asset' => (string) ($inv['asset_tag'] ?? ''),
			// Ciclo de vida: texto tal como está en el inventario y fecha interpretada (timestamp o null).
			'buy' => (string) ($inv['date_hw_purchase'] ?? ''),
			'inst' => (string) ($inv['date_hw_install'] ?? ''),
			'exp' => (string) ($inv['date_hw_expiry'] ?? ''),
			'decomm' => (string) ($inv['date_hw_decomm'] ?? ''),
			'buy_ts' => self::parseDate((string) ($inv['date_hw_purchase'] ?? '')),
			'exp_ts' => self::parseDate((string) ($inv['date_hw_expiry'] ?? '')),
			'decomm_ts' => self::parseDate((string) ($inv['date_hw_decomm'] ?? ''))
		];
	}

	/**
	 * Fecha de un campo de inventario (texto libre en Zabbix): acepta AAAA-MM-DD, AAAA/MM/DD, DD/MM/AAAA,
	 * DD-MM-AAAA, DD.MM.AAAA y AAAA-MM (fin de ese mes). Devuelve el timestamp del final del día o null.
	 */
	public static function parseDate(string $text): ?int {
		$text = trim($text);

		if (preg_match('/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/', $text, $m)) {
			[$y, $mo, $d] = [(int) $m[1], (int) $m[2], (int) $m[3]];
		}
		elseif (preg_match('/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})/', $text, $m)) {
			[$d, $mo, $y] = [(int) $m[1], (int) $m[2], (int) $m[3]];
		}
		elseif (preg_match('/^(\d{4})[-\/.](\d{1,2})$/', $text, $m)) {
			[$y, $mo] = [(int) $m[1], (int) $m[2]];
			$d = $mo >= 1 && $mo <= 12 ? (int) date('t', mktime(0, 0, 0, $mo, 1, $y)) : 0;
		}
		else {
			return null;
		}

		if (!checkdate($mo, $d, $y)) {
			return null;
		}

		return mktime(23, 59, 59, $mo, $d, $y);
	}

	/**
	 * Problemas activos por host: severidad máxima, cantidad y los más graves.
	 */
	private function getProblems(array $hostids): array {
		if (!$hostids) {
			return [];
		}

		$options = [
			'output' => ['eventid', 'objectid', 'name', 'severity', 'clock', 'acknowledged'],
			'hostids' => $hostids,
			'source' => EVENT_SOURCE_TRIGGERS,
			'object' => EVENT_OBJECT_TRIGGER,
			'symptom' => false,
			'sortfield' => ['eventid'],
			'sortorder' => ZBX_SORT_DOWN,
			'limit' => self::MAX_PROBLEMS
		];

		if (!$this->fields_values['show_suppressed']) {
			$options['suppressed'] = false;
		}

		$problems = API::Problem()->get($options);

		if (!$problems) {
			return [];
		}

		$triggers = API::Trigger()->get([
			'output' => ['triggerid'],
			'selectHosts' => ['hostid'],
			'triggerids' => array_unique(array_column($problems, 'objectid')),
			'monitored' => true,
			'skipDependent' => true,
			'preservekeys' => true
		]);

		$result = [];

		foreach ($problems as $problem) {
			if (!array_key_exists($problem['objectid'], $triggers)) {
				continue;
			}

			foreach ($triggers[$problem['objectid']]['hosts'] as $trigger_host) {
				$hostid = $trigger_host['hostid'];

				if (!in_array($hostid, $hostids)) {
					continue;
				}

				if (!array_key_exists($hostid, $result)) {
					$result[$hostid] = ['sev' => -1, 'count' => 0, 'list' => []];
				}

				$result[$hostid]['count']++;
				$result[$hostid]['sev'] = max($result[$hostid]['sev'], (int) $problem['severity']);
				$result[$hostid]['list'][] = [
					// El identificador del evento permite al modo NOC detectar problemas nuevos.
					'eventid' => (string) $problem['eventid'],
					'name' => $problem['name'],
					'sev' => (int) $problem['severity'],
					'clock' => (int) $problem['clock'],
					'ack' => (int) $problem['acknowledged'] === 1
				];
			}
		}

		// Los más graves primero y, a igual severidad, los más recientes.
		foreach ($result as &$host_problems) {
			usort($host_problems['list'], static function (array $a, array $b): int {
				return [$b['sev'], $b['clock']] <=> [$a['sev'], $a['clock']];
			});

			$host_problems['list'] = array_slice($host_problems['list'], 0, self::MAX_PROBLEMS_PER_HOST);
		}
		unset($host_problems);

		return $result;
	}

	/**
	 * Último valor numérico (el mayor, si hay varios ítems) de los ítems cuya clave coincide con el patrón.
	 */
	private function getItemValues(array $hostids, string $pattern, ?array &$clocks = null): array {
		$pattern = trim($pattern);
		$clocks = [];

		if (!$hostids || $pattern === '') {
			return [];
		}

		$items = API::Item()->get([
			'output' => ['itemid', 'hostid', 'lastvalue', 'lastclock'],
			'hostids' => $hostids,
			'search' => ['key_' => $pattern],
			'searchWildcardsEnabled' => true,
			'filter' => ['value_type' => [ITEM_VALUE_TYPE_FLOAT, ITEM_VALUE_TYPE_UINT64]],
			'monitored' => true,
			'webitems' => false,
			'limit' => count($hostids) * 20
		]);

		$values = [];

		foreach ($items as $item) {
			if ((int) $item['lastclock'] === 0 || !is_numeric($item['lastvalue'])) {
				continue;
			}

			$value = round((float) $item['lastvalue'], 1);
			$hostid = $item['hostid'];

			if (!array_key_exists($hostid, $values) || $value > $values[$hostid]) {
				$values[$hostid] = $value;
				$clocks[$hostid] = (int) $item['lastclock'];
			}
		}

		return $values;
	}

	/**
	 * Disponibilidad del host como en la lista de hosts de Zabbix: una entrada por tipo de interfaz
	 * (ZBX, SNMP, IPMI, JMX) y el agente activo. Estado: 1 disponible, 2 no disponible, 0 desconocido.
	 */
	private static function availability(array $host): array {
		$types = [INTERFACE_TYPE_AGENT => 'ZBX', INTERFACE_TYPE_SNMP => 'SNMP', INTERFACE_TYPE_IPMI => 'IPMI',
			INTERFACE_TYPE_JMX => 'JMX'
		];
		$out = [];

		foreach ($host['interfaces'] ?? [] as $interface) {
			$type = $types[(int) $interface['type']] ?? null;

			if ($type === null) {
				continue;
			}

			$state = (int) $interface['available'];
			$prev = $out[$type] ?? null;

			// Varias interfaces del mismo tipo: manda la peor (no disponible antes que disponible).
			if ($prev === null || $state === INTERFACE_AVAILABLE_FALSE
					|| ($prev['state'] === INTERFACE_AVAILABLE_UNKNOWN && $state === INTERFACE_AVAILABLE_TRUE)) {
				$out[$type] = ['type' => $type, 'state' => $state, 'error' => (string) ($interface['error'] ?? '')];
			}
		}

		$active = (int) ($host['active_available'] ?? 0);

		if ($active !== 0) {
			$out['ACT'] = ['type' => 'ZBX', 'active' => true, 'state' => $active, 'error' => ''];
		}

		return array_values($out);
	}

	/**
	 * Potencia medida por rack: suma de las PDU del rack (las ubicadas en U con tipo PDU y las de 0U vinculadas
	 * en el editor). De cada PDU se toma el ítem de mayor valor que coincide con la clave de potencia,
	 * así el total de la PDU no se suma dos veces con sus tomas. Las unidades kW y kVA se pasan a W.
	 */
	private function measurePower(array &$racks, array $devices, array $problems): void {
		$by_rack = [];

		foreach ($racks as $name => $rack) {
			$by_rack[$name] = array_map('strval', $rack['pdus'] ?? []);
		}

		foreach ($devices as $device) {
			if ($device['type'] === 'pdu' && !array_key_exists('passive', $device)
					&& array_key_exists($device['rack'], $by_rack)) {
				$by_rack[$device['rack']][] = $device['id'];
			}
		}

		$all = array_values(array_unique(array_merge([], ...array_values($by_rack))));
		$values = $this->getPowerValues($all, (string) $this->fields_values['power_key']);

		foreach ($racks as $name => &$rack) {
			$ids = array_values(array_unique($by_rack[$name]));
			$read = array_values(array_filter($ids, static fn($id) => array_key_exists($id, $values)));

			$rack['pdu_count'] = count($ids);
			// Severidad más alta de las PDU del rack, para colorear las PDU verticales.
			$rack['pdu_sev'] = $ids ? max(array_map(static fn($id) => $problems[$id]['sev'] ?? -1, $ids)) : -1;
			$rack['power_w'] = $read ? round(array_sum(array_map(static fn($id) => $values[$id], $read))) : null;
		}
		unset($rack);
	}

	/**
	 * Último valor de potencia (en W) por host, para la clave indicada.
	 */
	private function getPowerValues(array $hostids, string $pattern): array {
		$pattern = trim($pattern);

		if (!$hostids || $pattern === '') {
			return [];
		}

		$items = API::Item()->get([
			'output' => ['itemid', 'hostid', 'lastvalue', 'lastclock', 'units'],
			'hostids' => $hostids,
			'search' => ['key_' => $pattern],
			'searchWildcardsEnabled' => true,
			'filter' => ['value_type' => [ITEM_VALUE_TYPE_FLOAT, ITEM_VALUE_TYPE_UINT64]],
			'monitored' => true,
			'webitems' => false,
			'limit' => count($hostids) * 50
		]);

		$values = [];

		foreach ($items as $item) {
			if ((int) $item['lastclock'] === 0 || !is_numeric($item['lastvalue'])) {
				continue;
			}

			$units = mb_strtolower(trim($item['units']));

			// Solo potencia: W, kW, VA o kVA (sin unidad se toma como W).
			if (!in_array($units, ['', 'w', 'kw', 'va', 'kva'], true)) {
				continue;
			}

			$value = (float) $item['lastvalue'] * ($units === 'kw' || $units === 'kva' ? 1000 : 1);
			$hostid = (string) $item['hostid'];

			if (!array_key_exists($hostid, $values) || $value > $values[$hostid]) {
				$values[$hostid] = $value;
			}
		}

		return $values;
	}

	/**
	 * Ubica en el primer hueco libre a los equipos sin U y avisa de los que se superponen o no entran.
	 */
	private function placeDevices(array &$devices, array $racks, array &$warnings): void {
		$used = [];

		foreach ($devices as $device) {
			if ($device['u'] !== null) {
				for ($u = $device['u']; $u < $device['u'] + $device['n']; $u++) {
					$key = $device['rack'].'|'.$device['face'].'|'.$u;

					if (array_key_exists($key, $used)) {
						$warnings[] = sprintf(I18n::t('%1$s y %2$s ocupan la misma U (%3$s, U%4$d).'),
							$used[$key], $device['name'], $device['rack'], $u
						);
						break;
					}

					$used[$key] = $device['name'];
				}
			}
		}

		foreach ($devices as &$device) {
			$units = $racks[$device['rack']]['units'];

			if ($device['u'] === null) {
				// Primer hueco libre desde arriba.
				for ($top = $units; $top >= $device['n']; $top--) {
					$start = $top - $device['n'] + 1;
					$free = true;

					for ($u = $start; $u <= $top; $u++) {
						if (array_key_exists($device['rack'].'|'.$device['face'].'|'.$u, $used)) {
							$free = false;
							break;
						}
					}

					if ($free) {
						$device['u'] = $start;

						for ($u = $start; $u <= $top; $u++) {
							$used[$device['rack'].'|'.$device['face'].'|'.$u] = $device['name'];
						}

						break;
					}
				}

				if ($device['u'] === null) {
					$device['u'] = 1;
					$warnings[] = sprintf(I18n::t('No hay espacio libre para %1$s en %2$s.'), $device['name'],
						$device['rack']
					);
				}
			}
			elseif ($device['u'] + $device['n'] - 1 > $units) {
				$warnings[] = sprintf(I18n::t('%1$s queda fuera del rack %2$s (%3$dU).'), $device['name'],
					$device['rack'], $units
				);
			}

			unset($device['row']);
		}
		unset($device);
	}
}
